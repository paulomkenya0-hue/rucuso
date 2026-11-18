-- Current-event sports sign-up. Only the sports minister and super admin
-- can read students or export lists. Deputy/secretary/admin roles are excluded.
begin;
insert into public.ministries(name,description)
select 'Wizara ya Michezo','Usajili wa michezo na mashindano ya wanafunzi'
where not exists(select 1 from public.ministries where active and (name ilike '%michezo%' or name ilike '%sport%'))
on conflict(name) do update set active=true;
create table if not exists public.sports_event (
 id smallint primary key default 1 check(id=1),
 title text not null default 'Usajili wa Michezo na Mashindano ya RUCUSO' check(char_length(btrim(title)) between 3 and 160),
 ministry_id uuid not null references public.ministries(id),
 is_open boolean not null default true,
 deadline timestamptz
);
insert into public.sports_event(id,ministry_id)
select 1,id from public.ministries where active and (name ilike '%michezo%' or name ilike '%sport%') order by name limit 1
on conflict(id) do nothing;
create or replace function public.can_manage_sports() returns boolean
language sql stable security definer set search_path='' as $$
 select public.is_super_admin() or exists(
  select 1 from public.profiles p join public.sports_event e on e.ministry_id=p.ministry_id
  where p.id=auth.uid() and p.active and p.role='leader' and p.position='minister'
 );
$$;
alter table public.sports_event enable row level security;
revoke all on public.sports_event from anon,authenticated;
grant select on public.sports_event to authenticated;
drop policy if exists sports_event_staff on public.sports_event;
create policy sports_event_staff on public.sports_event for select to authenticated using(public.can_manage_sports());
create table if not exists public.sports_options (
 code text primary key,
 label text not null unique,
 sort_order integer not null
);
insert into public.sports_options(code,label,sort_order) values
 ('netball','Netball',1),('volleyball','Volleyball',2),('basketball','Basketball',3),('football','Mpira wa miguu',4),
 ('sprints','Mbio fupi',5),('eating','Mashindano ya kula',6),('chicken_chase','Kukimbiza kuku',7),
 ('egg_spoon','Kukimbia na yai kwenye kijiko',8),('sack_race','Kukimbia kwenye gunia',9),('tug_of_war','Kuvuta kamba',10)
on conflict(code) do nothing;
alter table public.sports_options enable row level security;
revoke all on public.sports_options from anon,authenticated;
grant select on public.sports_options to anon,authenticated;
drop policy if exists sports_options_public on public.sports_options;
create policy sports_options_public on public.sports_options for select to anon,authenticated using(true);
create table if not exists public.sports_registrations (
 id uuid primary key default gen_random_uuid(),
 reference text not null unique default ('SPORT-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))),
 first_name text not null check(char_length(btrim(first_name)) between 1 and 60),
 middle_name text not null check(char_length(btrim(middle_name)) between 1 and 60),
 last_name text not null check(char_length(btrim(last_name)) between 1 and 60),
 full_name text generated always as (first_name||' '||middle_name||' '||last_name) stored,
 registration_number text not null unique check(registration_number ~ '^RU/[A-Z0-9-]+/[0-9]{4}/[0-9]{1,8}$'),
 phone text not null check(phone ~ '^\+?[0-9]{9,15}$'),
 course text not null check(char_length(btrim(course)) between 2 and 120),
 study_year integer not null check(study_year between 1 and 4),
 gender text not null check(gender in ('male','female')),
 created_at timestamptz not null default now()
);
create index if not exists sports_registration_time on public.sports_registrations(created_at);
create table if not exists public.sports_selections (
 registration_id uuid not null references public.sports_registrations(id) on delete cascade,
 sport_code text not null references public.sports_options(code),
 primary key(registration_id,sport_code)
);
alter table public.sports_registrations enable row level security;
alter table public.sports_selections enable row level security;
revoke all on public.sports_registrations,public.sports_selections from anon,authenticated;
grant select on public.sports_registrations,public.sports_selections to authenticated;
drop policy if exists sports_roster_staff on public.sports_registrations;
create policy sports_roster_staff on public.sports_registrations for select to authenticated using(public.can_manage_sports());
drop policy if exists sports_selections_staff on public.sports_selections;
create policy sports_selections_staff on public.sports_selections for select to authenticated using(public.can_manage_sports());
create or replace function public.sports_public_info() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('title',e.title,'is_open',e.is_open and (e.deadline is null or e.deadline>now()),'deadline',e.deadline,
  'total_students',(select count(*) from public.sports_registrations),
  'sports',(select jsonb_agg(jsonb_build_object('code',o.code,'label',o.label,'count',(select count(*) from public.sports_selections s where s.sport_code=o.code)) order by o.sort_order) from public.sports_options o))
 from public.sports_event e where e.id=1;
$$;
create or replace function public.register_sports(p_student jsonb,p_sports text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.sports_event; r public.sports_registrations; choices text[];
begin
 select * into e from public.sports_event where id=1 for update;
 if not found or not e.is_open or (e.deadline is not null and e.deadline<=now()) then raise exception 'REGISTRATION_CLOSED'; end if;
 if (select count(*) from public.sports_registrations where created_at>=date_trunc('day',now()))>=5000 then raise exception 'DAILY_LIMIT'; end if;
 if p_sports is null or cardinality(p_sports) not between 1 and 10 or array_position(p_sports,null) is not null then raise exception 'CHOOSE_SPORT'; end if;
 select array_agg(distinct s) into choices from unnest(p_sports) s;
 if exists(select 1 from unnest(choices) s where not exists(select 1 from public.sports_options o where o.code=s)) then raise exception 'INVALID_SPORT'; end if;
 insert into public.sports_registrations(first_name,middle_name,last_name,registration_number,phone,course,study_year,gender)
 values(btrim(p_student->>'first_name'),btrim(p_student->>'middle_name'),btrim(p_student->>'last_name'),
  upper(regexp_replace(p_student->>'registration_number','\s','','g')),
  regexp_replace(p_student->>'phone','[\s()-]','','g'),btrim(p_student->>'course'),(p_student->>'study_year')::integer,p_student->>'gender') returning * into r;
 insert into public.sports_selections(registration_id,sport_code) select r.id,s from unnest(choices) s;
 return jsonb_build_object('reference',r.reference,'sports_count',cardinality(choices));
end; $$;
create or replace function public.sports_roster(p_sport text default null,p_gender text default null,p_course text default null,p_year integer default null,p_offset integer default 0,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.can_manage_sports() then raise exception 'NOT_AUTHORIZED' using errcode='42501'; end if;
 if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 250 then raise exception 'INVALID_PAGE'; end if;
 with filtered as (
  select r.* from public.sports_registrations r
  where (p_sport is null or exists(select 1 from public.sports_selections s where s.registration_id=r.id and s.sport_code=p_sport))
    and (p_gender is null or r.gender=p_gender) and (p_year is null or r.study_year=p_year)
    and (nullif(btrim(p_course),'') is null or strpos(lower(r.course),lower(btrim(p_course)))>0)
 ), page as (
  select r.*,array(select o.label from public.sports_selections s join public.sports_options o on o.code=s.sport_code where s.registration_id=r.id order by o.sort_order) as sports
  from filtered r order by r.created_at,r.id offset p_offset limit p_limit
 ) select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.id) from page p),'[]'::jsonb)) into result;
 return result;
end; $$;
create or replace function public.configure_sports_event(p_title text,p_open boolean,p_deadline timestamptz,p_ministry uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.is_super_admin() then raise exception 'NOT_AUTHORIZED' using errcode='42501'; end if;
 if p_open is null or not exists(select 1 from public.ministries where id=p_ministry and active) then raise exception 'INVALID_SETTINGS'; end if;
 update public.sports_event set title=btrim(p_title),is_open=p_open,deadline=p_deadline,ministry_id=p_ministry where id=1;
end; $$;
revoke all on function public.sports_public_info(),public.register_sports(jsonb,text[]),public.sports_roster(text,text,text,integer,integer,integer),public.configure_sports_event(text,boolean,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.sports_public_info(),public.register_sports(jsonb,text[]) to anon,authenticated;
grant execute on function public.sports_roster(text,text,text,integer,integer,integer),public.configure_sports_event(text,boolean,timestamptz,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
