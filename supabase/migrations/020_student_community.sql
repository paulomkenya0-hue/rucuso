-- Student services: private security cases, first-year feedback and member chat.
-- Apply after migrations 001–019 in the RUCUSO Supabase SQL Editor.
begin;
insert into public.leadership_positions(key,label_sw,label_en,tier_key,rank,sees_all_ministries,ministry_required)
values ('ministry_secretary','Katibu wa Wizara','Ministry Secretary','ministry',3,false,true)
on conflict(key) do nothing;

-- Reuse the existing security ministry where available; never assign real
-- people or generate staff passwords in a public migration.
insert into public.ministries(name,description)
select 'Wizara ya Ulinzi','Usalama wa wanafunzi na vitu vilivyopotea au kupatikana'
where not exists(select 1 from public.ministries where active and (name ilike '%ulinzi%' or name ilike '%security%'))
on conflict(name) do update set active=true;
create table if not exists public.student_service_settings (
  id boolean primary key default true check(id),
  security_ministry_id uuid not null references public.ministries(id)
);
insert into public.student_service_settings(id,security_ministry_id)
select true,id from public.ministries where active and (name ilike '%ulinzi%' or name ilike '%security%') order by name limit 1
on conflict(id) do nothing;
alter table public.student_service_settings enable row level security;
revoke all on public.student_service_settings from anon, authenticated;
grant select on public.student_service_settings to authenticated;
grant update(security_ministry_id) on public.student_service_settings to authenticated;
drop policy if exists services_settings_read on public.student_service_settings;
create policy services_settings_read on public.student_service_settings for select to authenticated using(public.is_super_admin());
drop policy if exists services_settings_write on public.student_service_settings;
create policy services_settings_write on public.student_service_settings for update to authenticated using(public.is_super_admin()) with check(public.is_super_admin());

create or replace function public.can_manage_security_cases() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select public.is_super_admin() or exists(
    select 1 from public.profiles p join public.student_service_settings s on s.security_ministry_id=p.ministry_id
    where p.id=auth.uid() and p.active and p.role='leader'
      and p.position in ('minister','deputy_minister','ministry_secretary')
  );
$$;
create or replace function public.can_manage_first_year_feedback() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select public.has_permission('manage_feedback') or public.is_executive_leader();
$$;
create or replace function public.can_moderate_community() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select public.has_permission('manage_feedback');
$$;

create table if not exists public.student_cases (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('RUC-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))),
  tracking_token uuid not null unique default gen_random_uuid(),
  kind text not null check(kind in ('lost','found','first_year_feedback')),
  ministry_id uuid references public.ministries(id),
  full_name text not null check(char_length(btrim(full_name)) between 3 and 120),
  programme text not null check(char_length(btrim(programme)) between 2 and 100),
  study_year integer not null check(study_year between 1 and 4),
  phone text not null check(phone ~ '^\+?[0-9]{9,15}$'),
  title text not null check(char_length(btrim(title)) between 3 and 160),
  description text not null check(char_length(btrim(description)) between 10 and 3000),
  incident_date date,
  incident_location text check(char_length(incident_location) <= 200),
  residence_type text check(residence_type in ('campus_boys','campus_girls','lugalo','offcampus')),
  residence_name text check(char_length(residence_name) <= 250),
  identity_source text not null default 'self_reported' check(identity_source='self_reported'),
  status text not null default 'submitted' check(status in ('submitted','in_progress','waiting','resolved','closed')),
  public_reply text not null default '' check(char_length(public_reply)<=2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  response_due_at timestamptz not null default (now()+interval '24 hours'),
  first_response_at timestamptz,
  check(kind<>'first_year_feedback' or study_year=1),
  check(kind='first_year_feedback' or (ministry_id is not null and incident_date is not null and incident_location is not null and residence_name is not null and char_length(btrim(incident_location)) between 2 and 200 and residence_type is not null and char_length(btrim(residence_name))>=2))
);
create index if not exists student_cases_queue on public.student_cases(kind,status,created_at desc);
alter table public.student_cases enable row level security;
revoke all on public.student_cases from anon, authenticated;
grant select on public.student_cases to authenticated;
drop policy if exists private_cases_read on public.student_cases;
create policy private_cases_read on public.student_cases for select to authenticated using(
  (kind in ('lost','found') and public.can_manage_security_cases()) or
  (kind='first_year_feedback' and public.can_manage_first_year_feedback())
);
create table if not exists public.student_case_updates (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.student_cases(id) on delete cascade,
  status text not null,
  public_reply text not null,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.student_case_updates enable row level security;
revoke all on public.student_case_updates from anon,authenticated;
grant select on public.student_case_updates to authenticated;
drop policy if exists case_history_staff on public.student_case_updates;
create policy case_history_staff on public.student_case_updates for select to authenticated
  using(exists(select 1 from public.student_cases c where c.id=case_id));

-- Anonymous intake is bounded globally; personal details never appear publicly.
create or replace function public.submit_student_case(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_kind text:=p_payload->>'kind'; v_route uuid; v_row public.student_cases;
  v_res text:=p_payload->>'residence_name'; v_type text:=p_payload->>'residence_type';
begin
  perform pg_advisory_xact_lock(200020);
  if (select count(*) from public.student_cases where created_at>=date_trunc('day',now()))>=200 then
    raise exception 'DAILY_LIMIT'; end if;
  if v_kind is null or v_kind not in ('lost','found','first_year_feedback') then raise exception 'INVALID_KIND'; end if;
  if v_kind in ('lost','found') then
    select security_ministry_id into v_route from public.student_service_settings where id=true;
    if v_route is null then raise exception 'SECURITY_NOT_CONFIGURED'; end if;
    if v_type is null or v_res is null or
       (v_type='campus_boys' and v_res not in ('Nkembo','Katikaza')) or
       (v_type='campus_girls' and v_res not in ('NMB line','Kamzora','Sisters','Elizabeth')) or
       (v_type='lugalo' and v_res<>'Lugalo') then raise exception 'INVALID_RESIDENCE'; end if;
    if (p_payload->>'incident_date')::date>current_date then raise exception 'FUTURE_DATE'; end if;
  end if;
  insert into public.student_cases(kind,ministry_id,full_name,programme,study_year,phone,title,description,incident_date,incident_location,residence_type,residence_name)
  values(v_kind,v_route,btrim(p_payload->>'full_name'),btrim(p_payload->>'programme'),(p_payload->>'study_year')::integer,
    btrim(p_payload->>'phone'),btrim(p_payload->>'title'),btrim(p_payload->>'description'),
    case when v_kind<>'first_year_feedback' then (p_payload->>'incident_date')::date end,
    case when v_kind<>'first_year_feedback' then btrim(p_payload->>'incident_location') end,
    case when v_kind<>'first_year_feedback' then v_type end,
    case when v_kind<>'first_year_feedback' then btrim(v_res) end) returning * into v_row;
  return jsonb_build_object('reference',v_row.reference,'tracking_token',v_row.tracking_token,'response_due_at',v_row.response_due_at);
end; $$;
create or replace function public.track_student_case(p_reference text,p_token uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('reference',c.reference,'status',c.status,'created_at',c.created_at,
    'response_due_at',c.response_due_at,'first_response_at',c.first_response_at,'public_reply',c.public_reply,
    'updates',coalesce((select jsonb_agg(jsonb_build_object('status',u.status,'reply',u.public_reply,'created_at',u.created_at) order by u.created_at)
      from public.student_case_updates u where u.case_id=c.id),'[]'::jsonb))
  from public.student_cases c where c.reference=p_reference and c.tracking_token=p_token;
$$;
create or replace function public.update_student_case(p_id uuid,p_status text,p_reply text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.student_cases;
begin
  select * into v_row from public.student_cases where id=p_id for update;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if not ((v_row.kind in ('lost','found') and public.can_manage_security_cases()) or
    (v_row.kind='first_year_feedback' and public.can_manage_first_year_feedback())) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status is null or p_status not in ('submitted','in_progress','waiting','resolved','closed') or
    p_reply is null or char_length(btrim(p_reply)) not between 3 and 2000 then raise exception 'INVALID_UPDATE'; end if;
  update public.student_cases set status=p_status,public_reply=btrim(p_reply),updated_at=now(),
    first_response_at=coalesce(first_response_at,now()) where id=p_id;
  insert into public.student_case_updates(case_id,status,public_reply,actor_id) values(p_id,p_status,btrim(p_reply),auth.uid());
end; $$;

-- Chat identities are separate from staff profiles. Registration NEVER grants
-- staff privileges. All identities await a human check before reading/writing.
create table if not exists public.community_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check(char_length(btrim(display_name)) between 3 and 80),
  programme text not null check(char_length(btrim(programme)) between 2 and 100),
  study_year integer not null check(study_year between 1 and 4),
  registration_number text check(char_length(registration_number) between 3 and 80),
  status text not null default 'pending' check(status in ('pending','approved','suspended','rejected')),
  created_at timestamptz not null default now(),
  check(study_year=1 or registration_number is not null)
);
alter table public.community_members enable row level security;
revoke all on public.community_members from anon,authenticated;
grant select on public.community_members to authenticated;
drop policy if exists membership_private on public.community_members;
create policy membership_private on public.community_members for select to authenticated
  using(user_id=auth.uid() or public.can_moderate_community());
create or replace function public.is_community_member() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.community_members where user_id=auth.uid() and status='approved');
$$;
create table if not exists public.community_messages (
  id bigint generated always as identity primary key,
  author_id uuid not null references public.community_members(user_id),
  body text not null check(char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
alter table public.community_messages enable row level security;
revoke all on public.community_messages from anon,authenticated;
-- No author UUID, registration, email or phone is exposed through the reader RPC.
create table if not exists public.community_reports (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null references public.community_messages(id) on delete cascade,
  reporter_id uuid not null references public.community_members(user_id),
  reason text not null check(char_length(btrim(reason)) between 3 and 500),
  created_at timestamptz not null default now(),
  unique(message_id,reporter_id)
);
alter table public.community_reports enable row level security;
revoke all on public.community_reports from anon,authenticated;
grant select on public.community_reports to authenticated;
drop policy if exists reports_moderator on public.community_reports;
create policy reports_moderator on public.community_reports for select to authenticated using(public.can_moderate_community());

create or replace function public.join_community(p_name text,p_programme text,p_year integer,p_registration text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_advisory_xact_lock(200021);
  if exists(select 1 from public.community_members where user_id=auth.uid()) then raise exception 'ALREADY_APPLIED'; end if;
  if (select count(*) from public.community_members where created_at>=date_trunc('day',now()))>=200 then raise exception 'DAILY_LIMIT'; end if;
  insert into public.community_members(user_id,display_name,programme,study_year,registration_number)
    values(auth.uid(),btrim(p_name),btrim(p_programme),p_year,nullif(btrim(p_registration),''));
end; $$;
create or replace function public.moderate_community_member(p_user uuid,p_status text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.can_moderate_community() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status is null or p_status not in ('approved','suspended','rejected','pending') then raise exception 'INVALID_STATUS'; end if;
  update public.community_members set status=p_status where user_id=p_user;
end; $$;
create or replace function public.read_community_messages(p_before bigint default null) returns table(id bigint,display_name text,body text,created_at timestamptz,is_mine boolean)
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not (public.is_community_member() or public.can_moderate_community()) then raise exception 'NOT_AUTHORIZED'; end if;
  return query select m.id,u.display_name,m.body,m.created_at,m.author_id=auth.uid()
    from public.community_messages m join public.community_members u on u.user_id=m.author_id
    where (p_before is null or m.id<p_before) order by m.id desc limit 50;
end; $$;
create or replace function public.send_community_message(p_body text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  -- Lock per member so concurrent submissions cannot bypass cooldown.
  perform 1 from public.community_members where user_id=auth.uid() for update;
  if not public.is_community_member() then raise exception 'NOT_AUTHORIZED'; end if;
  if exists(select 1 from public.community_messages where author_id=auth.uid() and created_at>now()-interval '3 seconds') then raise exception 'SLOW_DOWN'; end if;
  if (select count(*) from public.community_messages where author_id=auth.uid() and created_at>now()-interval '1 hour')>=120 then raise exception 'HOURLY_LIMIT'; end if;
  insert into public.community_messages(author_id,body) values(auth.uid(),btrim(p_body));
end; $$;
create index if not exists community_message_author_time on public.community_messages(author_id,created_at desc);
create or replace function public.report_community_message(p_message bigint,p_reason text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.is_community_member() then raise exception 'NOT_AUTHORIZED'; end if;
  insert into public.community_reports(message_id,reporter_id,reason) values(p_message,auth.uid(),btrim(p_reason));
end; $$;
create or replace function public.remove_community_message(p_message bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.can_moderate_community() then raise exception 'NOT_AUTHORIZED'; end if;
  delete from public.community_messages where id=p_message;
end; $$;

-- Explicitly remove PostgreSQL's default PUBLIC function execution grants.
revoke all on function public.submit_student_case(jsonb),public.track_student_case(text,uuid) from public;
grant execute on function public.submit_student_case(jsonb),public.track_student_case(text,uuid) to anon,authenticated;
revoke all on function public.update_student_case(uuid,text,text),public.join_community(text,text,integer,text),public.moderate_community_member(uuid,text),public.read_community_messages(bigint),public.send_community_message(text),public.report_community_message(bigint,text),public.remove_community_message(bigint) from public,anon,authenticated;
grant execute on function public.update_student_case(uuid,text,text),public.join_community(text,text,integer,text),public.moderate_community_member(uuid,text),public.read_community_messages(bigint),public.send_community_message(text),public.report_community_message(bigint,text),public.remove_community_message(bigint) to authenticated;
notify pgrst,'reload schema';
commit;
