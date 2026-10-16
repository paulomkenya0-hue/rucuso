-- ============================================================
-- RUCUSO — Migration 017: approved AI knowledge and live leadership facts
-- Run AFTER 016_leadership_row_bands.sql.
--
-- Knowledge documents are plain text so the Edge Function can retrieve them
-- without executing uploaded content or depending on a third-party parser.
-- Search is PostgreSQL full-text search; no embedding provider or API secret is
-- required. Only approved documents are searchable by the AI.
-- ============================================================

create table if not exists public.ai_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 180),
  category text check (category is null or length(category) <= 100),
  content text not null check (length(btrim(content)) between 1 and 100000),
  source text check (source is null or length(source) <= 300),
  source_url text check (
    source_url is null or
    (length(source_url) <= 2048 and source_url ~* '^https?://')
  ),
  file_name text check (file_name is null or length(file_name) <= 255),
  publication_date date,
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'inactive')),
  visibility text not null default 'staff'
    check (visibility in ('public', 'staff')),
  created_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(category, '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(content, '')), 'C')
  ) stored
);

create index if not exists ai_knowledge_search_idx
  on public.ai_knowledge_documents using gin (search_vector);
create index if not exists ai_knowledge_approval_updated_idx
  on public.ai_knowledge_documents (approval_status, updated_at desc);

alter table public.ai_knowledge_documents enable row level security;
revoke all on public.ai_knowledge_documents from anon;
grant select, insert, update, delete on public.ai_knowledge_documents to authenticated;
grant all on public.ai_knowledge_documents to service_role;

drop policy if exists "super_admin manages AI knowledge" on public.ai_knowledge_documents;
create policy "super_admin manages AI knowledge"
  on public.ai_knowledge_documents for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create or replace function public.set_ai_knowledge_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_catalog as $$
begin
  new.updated_at := now();
  if new.approval_status = 'approved' then
    if tg_op = 'INSERT' then
      new.approved_at := now();
    elsif old.approval_status is distinct from 'approved' or
          new.title is distinct from old.title or
          new.category is distinct from old.category or
          new.content is distinct from old.content or
          new.source is distinct from old.source or
          new.source_url is distinct from old.source_url or
          new.publication_date is distinct from old.publication_date or
          new.visibility is distinct from old.visibility then
      new.approved_at := now();
    end if;
  else
    new.approved_at := null;
    new.approved_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists ai_knowledge_updated_at on public.ai_knowledge_documents;
create trigger ai_knowledge_updated_at
  before insert or update on public.ai_knowledge_documents
  for each row execute function public.set_ai_knowledge_updated_at();

create or replace function public.search_ai_knowledge(p_query text, p_limit integer default 5)
returns table (
  document_id uuid,
  title text,
  category text,
  publication_date date,
  source text,
  source_url text,
  excerpt text
)
language sql stable security definer
set search_path = public, pg_catalog as $$
  with search_terms as (
    select plainto_tsquery('simple'::regconfig, left(coalesce(p_query, ''), 300)) as query
  )
  select d.id,
         d.title,
         d.category,
         d.publication_date,
         d.source,
         d.source_url,
         replace(
           replace(
             ts_headline(
               'simple'::regconfig,
               d.content,
               search_terms.query,
               'MaxFragments=2,MinWords=20,MaxWords=70'
             ),
             '<b>', ''
           ),
           '</b>', ''
         )
  from public.ai_knowledge_documents d
  cross join search_terms
  where d.approval_status = 'approved'
    and d.visibility = 'public'
    and numnode(search_terms.query) > 0
    and d.search_vector @@ search_terms.query
  order by ts_rank_cd(d.search_vector, search_terms.query) desc, d.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 5), 8));
$$;

revoke all on function public.search_ai_knowledge(text, integer) from public, anon, authenticated;
grant execute on function public.search_ai_knowledge(text, integer) to service_role;

-- A low-data summary for the AI: never returns internal leader names or
-- contact details. Each ministry-required post has one expected slot per
-- active ministry; a slot is filled by at least one active assignment.
create or replace function public.rucuso_ai_leadership_stats()
returns jsonb
language sql stable security definer
set search_path = public, pg_catalog as $$
  with slots as (
    select p.key as position_key,
           p.label_sw as position_label,
           p.tier_key,
           t.label_sw as tier_label,
           t.rank as tier_rank,
           p.rank as position_rank,
           m.id as ministry_id,
           m.name as ministry_name
    from public.leadership_positions p
    join public.leadership_tiers t on t.key = p.tier_key and t.active
    join public.ministries m on p.ministry_required and m.active
    where p.active and p.ministry_required

    union all

    select p.key,
           p.label_sw,
           p.tier_key,
           t.label_sw,
           t.rank,
           p.rank,
           null::uuid,
           null::text
    from public.leadership_positions p
    join public.leadership_tiers t on t.key = p.tier_key and t.active
    where p.active and not p.ministry_required
  ),
  assignments as (
    select s.position_key,
           s.position_label,
           s.tier_key,
           s.tier_label,
           s.tier_rank,
           s.position_rank,
           s.ministry_id,
           s.ministry_name,
           count(l.id)::integer as active_leaders
    from slots s
    left join public.leaders l
      on l.position = s.position_key
     and l.active
     and (s.ministry_id is null or l.ministry_id = s.ministry_id)
    group by s.position_key, s.position_label, s.tier_key, s.tier_label,
             s.tier_rank, s.position_rank,
             s.ministry_id, s.ministry_name
  )
  select jsonb_build_object(
    'active_leaders', (select count(*) from public.leaders where active),
    'inactive_leaders', (select count(*) from public.leaders where not active),
    'public_active_leaders', (
      select count(*) from public.leaders where active and public_visible
    ),
    'active_ministries', (select count(*) from public.ministries where active),
    'slots', coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'position', position_key,
          'position_label', position_label,
          'tier', tier_key,
          'tier_label', tier_label,
          'ministry', ministry_name,
          'active_leaders', active_leaders,
          'filled', active_leaders > 0
        )
        order by tier_rank, position_rank, ministry_name
      ) from assignments),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.rucuso_ai_leadership_stats() from public, anon, authenticated;
grant execute on function public.rucuso_ai_leadership_stats() to service_role;

-- Aggregates feedback inside Postgres so the model never receives report rows
-- and Edge Functions never download an unbounded personal-data table.
create or replace function public.rucuso_ai_feedback_stats()
returns jsonb
language sql stable security definer
set search_path = public, pg_catalog as $$
  select jsonb_build_object(
    'total', (select count(*) from public.feedback),
    'by_status', coalesce((
      select jsonb_object_agg(status, amount)
      from (
        select status, count(*)::integer as amount
        from public.feedback
        group by status
      ) grouped_status
    ), '{}'::jsonb),
    'by_submission_type', coalesce((
      select jsonb_object_agg(submission_type, amount)
      from (
        select submission_type, count(*)::integer as amount
        from public.feedback
        group by submission_type
      ) grouped_type
    ), '{}'::jsonb),
    'by_category', coalesce((
      select jsonb_object_agg(category, amount)
      from (
        select coalesce(c.name, 'Bila kundi') as category, count(*)::integer as amount
        from public.feedback f
        left join public.categories c on c.id = f.category_id
        group by coalesce(c.name, 'Bila kundi')
      ) grouped_category
    ), '{}'::jsonb),
    'open', (
      select count(*) from public.feedback
      where status in ('New', 'Under Review', 'Assigned', 'In Progress', 'Awaiting Information')
    ),
    'critical_open', (
      select count(*) from public.feedback
      where priority = 'Critical'
        and status not in ('Resolved', 'Closed', 'Rejected/Invalid')
    ),
    'last_7_days', (
      select count(*) from public.feedback
      where created_at >= now() - interval '7 days'
    ),
    'rating_average', (
      select round(avg(satisfaction_rating)::numeric, 2)
      from public.feedback
      where satisfaction_rating between 1 and 5
    ),
    'rated_reports', (
      select count(*) from public.feedback
      where satisfaction_rating between 1 and 5
    )
  );
$$;

revoke all on function public.rucuso_ai_feedback_stats() from public, anon, authenticated;
grant execute on function public.rucuso_ai_feedback_stats() to service_role;

-- Public-safe aggregate: contains no names or contact details, and counts only
-- rows the directory already exposes. This keeps tier counts exact even when
-- the directory grows beyond PostgREST's default page size.
create or replace function public.rucuso_ai_public_leadership_stats()
returns jsonb
language sql stable security definer
set search_path = public, pg_catalog as $$
  select jsonb_build_object(
    'total', (select count(*) from public.public_leaders),
    'by_tier', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'tier_key', tier_key,
          'tier_label', tier_label,
          'tier_rank', tier_rank,
          'people', people
        )
        order by tier_rank
      )
      from (
        select tier_key, tier_label, tier_rank, count(*)::integer as people
        from public.public_leaders
        group by tier_key, tier_label, tier_rank
      ) grouped_tiers
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.rucuso_ai_public_leadership_stats() from public;
grant execute on function public.rucuso_ai_public_leadership_stats() to anon, authenticated, service_role;

-- The AI dashboard can see aggregate successful-query counts, never question
-- text or caller identifiers. Failures are not persisted by migration 003.
create or replace function public.rucuso_ai_usage_stats(p_days integer default 30)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_catalog as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 30), 90));
  v_stats jsonb;
begin
  if not public.is_super_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'days', v_days,
    'successful_queries', (
      select count(*) from public.ai_queries
      where created_at >= now() - make_interval(days => v_days)
    ),
    'successful_queries_24h', (
      select count(*) from public.ai_queries
      where created_at >= now() - interval '24 hours'
    ),
    'by_role', coalesce((
      select jsonb_object_agg(role, amount)
      from (
        select role, count(*)::integer as amount
        from public.ai_queries
        where created_at >= now() - make_interval(days => v_days)
        group by role
      ) grouped_roles
    ), '{}'::jsonb)
  ) into v_stats;
  return v_stats;
end;
$$;

revoke all on function public.rucuso_ai_usage_stats(integer) from public, anon;
grant execute on function public.rucuso_ai_usage_stats(integer) to authenticated, service_role;
