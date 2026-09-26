-- HESLB beneficiary management. Run after 007_leader_photo_upload_limit.sql.
-- Beneficiary rows deliberately contain only the fields used by this module.

create table if not exists public.heslb_beneficiaries (
  full_name text not null check (length(btrim(full_name)) between 1 and 160),
  index_number text primary key check (length(btrim(index_number)) between 1 and 80),
  phone text not null check (phone ~ '^\+255[678][0-9]{8}$'),
  faculty text not null check (faculty in ('ICT', 'FBMS', 'FASS', 'LAW', 'IHAS', 'HAS')),
  year_of_study smallint not null check (year_of_study between 1 and 7),
  status text not null default 'active' check (status in ('active', 'inactive', 'graduated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_heslb_beneficiaries_phone on public.heslb_beneficiaries (phone);
create index if not exists idx_heslb_beneficiaries_faculty on public.heslb_beneficiaries (faculty);
create index if not exists idx_heslb_beneficiaries_status on public.heslb_beneficiaries (status);

create or replace function public.normalize_heslb_beneficiary()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.full_name := btrim(new.full_name);
  new.index_number := upper(btrim(new.index_number));
  new.phone := regexp_replace(btrim(new.phone), '[[:space:]()-]', '', 'g');
  if new.phone ~ '^0[678][0-9]{8}$' then
    new.phone := '+255' || substr(new.phone, 2);
  elsif new.phone ~ '^255[678][0-9]{8}$' then
    new.phone := '+' || new.phone;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
  else
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists heslb_beneficiaries_normalize on public.heslb_beneficiaries;
create trigger heslb_beneficiaries_normalize
before insert or update on public.heslb_beneficiaries
for each row execute function public.normalize_heslb_beneficiary();

create or replace function public.is_heslb_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and (
        p.role = 'super_admin'
        or (
          (p.role = 'leader' or (
            p.role = 'admin'
            and coalesce((p.permissions ->> 'manage_heslb_beneficiaries')::boolean, false)
          ))
          and exists (
            select 1 from public.ministries m
            where m.id = p.ministry_id
              and m.active = true
              and regexp_replace(lower(m.name), '[^a-z0-9]', '', 'g') in (
                'loansandempowerment',
                'loansempowerment',
                'mikoponauwezeshaji',
                'wizarayamikoponauwezeshaji',
                'ministryofloansandempowerment'
              )
          )
        )
      )
  );
$$;

revoke all on function public.is_heslb_manager() from public, anon;
grant execute on function public.is_heslb_manager() to authenticated;

alter table public.heslb_beneficiaries enable row level security;
revoke all on public.heslb_beneficiaries from public, anon, authenticated;
grant select, insert, update on public.heslb_beneficiaries to authenticated;

create policy "authorized HESLB read" on public.heslb_beneficiaries
  for select to authenticated using (public.is_heslb_manager());
create policy "authorized HESLB insert" on public.heslb_beneficiaries
  for insert to authenticated with check (public.is_heslb_manager());
create policy "authorized HESLB update" on public.heslb_beneficiaries
  for update to authenticated
  using (public.is_heslb_manager())
  with check (public.is_heslb_manager());

create or replace function public.heslb_beneficiary_stats()
returns table (total bigint, active bigint, inactive bigint, graduated bigint, faculty text, faculty_total bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_heslb_manager() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    with faculties(faculty) as (
      values ('ICT'), ('FBMS'), ('FASS'), ('LAW'), ('IHAS'), ('HAS')
    ), totals as (
      select count(*) as total,
             count(*) filter (where b.status = 'active') as active,
             count(*) filter (where b.status = 'inactive') as inactive,
             count(*) filter (where b.status = 'graduated') as graduated
      from public.heslb_beneficiaries b
    ), by_faculty as (
      select b.faculty, count(*) as faculty_total
      from public.heslb_beneficiaries b
      group by b.faculty
    )
    select totals.total, totals.active, totals.inactive, totals.graduated,
           faculties.faculty, coalesce(by_faculty.faculty_total, 0)::bigint
    from faculties cross join totals
    left join by_faculty using (faculty);
end;
$$;

revoke all on function public.heslb_beneficiary_stats() from public, anon;
grant execute on function public.heslb_beneficiary_stats() to authenticated;

create or replace function public.audit_heslb_beneficiary_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_label text;
  v_action text;
begin
  select p.full_name into v_actor_label from public.profiles p where p.id = auth.uid();
  if tg_op = 'INSERT' then
    v_action := 'HESLB Beneficiary Created';
  elsif old.status is distinct from new.status and new.status = 'inactive' then
    v_action := 'HESLB Beneficiary Deactivated';
  else
    v_action := 'HESLB Beneficiary Updated';
  end if;
  insert into public.audit_logs (actor_id, actor_label, action, details)
  values (auth.uid(), coalesce(v_actor_label, 'Authorized HESLB user'), v_action,
          'HESLB record changed; personal record details omitted.');
  return new;
end;
$$;

drop trigger if exists heslb_beneficiaries_audit on public.heslb_beneficiaries;
create trigger heslb_beneficiaries_audit
after insert or update on public.heslb_beneficiaries
for each row execute function public.audit_heslb_beneficiary_change();

-- Edge Functions only. The hashed key is derived from a client IP using a
-- server-side secret; this table is never readable from anon/authenticated.
create table if not exists public.heslb_verification_rate_limits (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempt_count smallint not null check (attempt_count > 0)
);
create index if not exists idx_heslb_verification_rate_limits_window
  on public.heslb_verification_rate_limits (window_started_at);
alter table public.heslb_verification_rate_limits enable row level security;
revoke all on public.heslb_verification_rate_limits from public, anon, authenticated;
grant all on public.heslb_verification_rate_limits to service_role;

create or replace function public.consume_heslb_verification_attempt(p_key_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count smallint;
begin
  if p_key_hash !~ '^[a-f0-9]{64}$' then
    return false;
  end if;
  insert into public.heslb_verification_rate_limits (key_hash, window_started_at, attempt_count)
  values (p_key_hash, v_now, 1)
  on conflict (key_hash) do update set
    window_started_at = case
      when public.heslb_verification_rate_limits.window_started_at < v_now - interval '15 minutes' then v_now
      else public.heslb_verification_rate_limits.window_started_at
    end,
    attempt_count = case
      when public.heslb_verification_rate_limits.window_started_at < v_now - interval '15 minutes' then 1
      else least(11, public.heslb_verification_rate_limits.attempt_count + 1)::smallint
    end
  returning attempt_count into v_count;
  delete from public.heslb_verification_rate_limits
  where window_started_at < v_now - interval '1 day';
  return v_count <= 10;
end;
$$;

revoke all on function public.consume_heslb_verification_attempt(text) from public, anon, authenticated;
grant execute on function public.consume_heslb_verification_attempt(text) to service_role;
