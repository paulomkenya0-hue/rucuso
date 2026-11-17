-- Study Hub: moderated links and material requests. No paid storage required.
-- Requires previous migrations (including has_permission).
begin;
create table if not exists public.study_resources (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 3 and 160),
  course text not null check (char_length(btrim(course)) between 2 and 100),
  subject text not null check (char_length(btrim(subject)) between 2 and 100),
  study_year integer not null check (study_year between 1 and 7),
  semester integer not null check (semester in (1,2)),
  kind text not null check (kind in ('notes','past_paper','practice','request')),
  source text not null check (char_length(btrim(source)) between 2 and 160),
  resource_url text check (char_length(resource_url) <= 1500 and resource_url ~ '^https://[^[:space:]<>]+$'),
  description text not null default '' check (char_length(description) <= 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  check ((kind = 'request' and resource_url is null) or (kind <> 'request' and resource_url is not null))
);
create index if not exists study_resources_browse on public.study_resources(status, created_at desc);
alter table public.study_resources enable row level security;
revoke all on public.study_resources from anon, authenticated;
grant select on public.study_resources to anon, authenticated;
grant update(status), delete on public.study_resources to authenticated;
drop policy if exists study_read on public.study_resources;
create policy study_read on public.study_resources for select to anon, authenticated
  using (status = 'approved' or public.has_permission('manage_documents'));
drop policy if exists study_moderate on public.study_resources;
create policy study_moderate on public.study_resources for update to authenticated
  using (public.has_permission('manage_documents'))
  with check (public.has_permission('manage_documents'));
drop policy if exists study_delete on public.study_resources;
create policy study_delete on public.study_resources for delete to authenticated
  using (public.has_permission('manage_documents'));

-- Anonymous callers can submit only pending entries, never approve their own.
-- A bounded daily queue protects storage even without student sign-in.
create or replace function public.submit_study_resource(
  p_title text, p_course text, p_subject text, p_study_year integer,
  p_semester integer, p_kind text, p_source text, p_resource_url text, p_description text
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(190019);
  if (select count(*) from public.study_resources where created_at >= date_trunc('day', now())) >= 200 then
    raise exception 'Maombi ya leo yamefikia kikomo. Tafadhali jaribu kesho.';
  end if;
  if p_kind <> 'request' and (p_resource_url !~ '^https://[^[:space:]<>]+$' or p_resource_url ~ '^https://[^/]*@') then
    raise exception 'Weka kiungo sahihi cha HTTPS.';
  end if;
  insert into public.study_resources(title,course,subject,study_year,semester,kind,source,resource_url,description)
    values (btrim(p_title),btrim(p_course),btrim(p_subject),p_study_year,p_semester,p_kind,
      btrim(p_source),case when p_kind='request' then null else btrim(p_resource_url) end,coalesce(btrim(p_description),''));
end; $$;
revoke all on function public.submit_study_resource(text,text,text,integer,integer,text,text,text,text) from public;
grant execute on function public.submit_study_resource(text,text,text,integer,integer,text,text,text,text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
