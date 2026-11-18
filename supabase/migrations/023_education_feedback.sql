-- Private education inbox. Uses fully qualified names throughout so legacy
-- helper search_path settings cannot break this module. No existing data is changed.
begin;
insert into public.ministries(name,description)
select 'Wizara ya Elimu','Maoni, malalamiko na changamoto za elimu za wanafunzi wa RUCU'
where not exists(select 1 from public.ministries where active and (name ilike '%elimu%' or name ilike '%education%'))
on conflict(name) do update set active=true;
create table if not exists public.education_settings(
 id smallint primary key default 1 check(id=1),
 title text not null default 'Maoni na Malalamiko ya Elimu — RUCU' check(char_length(btrim(title)) between 3 and 160),
 ministry_id uuid not null references public.ministries(id),
 is_open boolean not null default true
);
insert into public.education_settings(id,ministry_id)
select 1,id from public.ministries where active and (name ilike '%elimu%' or name ilike '%education%') order by name limit 1 on conflict(id) do nothing;
create or replace function public.education_is_super() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and active and role='super_admin');
$$;
create or replace function public.can_manage_education() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and
  (p.role='super_admin' or (p.role='leader' and p.position='minister' and
   exists(select 1 from public.education_settings s where s.ministry_id=p.ministry_id))));
$$;
alter table public.education_settings enable row level security;
revoke all on public.education_settings from anon,authenticated;
grant select on public.education_settings to authenticated;
drop policy if exists education_settings_read on public.education_settings;
create policy education_settings_read on public.education_settings for select to authenticated using(public.education_is_super());

-- CRs and MPs are verified by an account link created by the super admin.
-- A registration number or matching name alone is never proof of a position.
create table if not exists public.education_representatives(
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role in ('cr','mp')),
 full_name text not null check(char_length(btrim(full_name)) between 3 and 120),
 registration_number text check(registration_number is null or char_length(registration_number)<=80),
 course text check(course is null or char_length(course)<=120),
 study_year integer check(study_year between 1 and 4),
 scope text not null check(char_length(btrim(scope)) between 2 and 180),
 parliament_id uuid references public.parliament_members(id) on delete cascade,
 active boolean not null default true,
 updated_at timestamptz not null default now(),
 primary key(user_id,role),
 check(role<>'mp' or parliament_id is not null)
);
alter table public.education_representatives enable row level security;
revoke all on public.education_representatives from anon,authenticated;
grant select on public.education_representatives to authenticated;
drop policy if exists education_rep_registry on public.education_representatives;
create policy education_rep_registry on public.education_representatives for select to authenticated using(public.education_is_super());
create table if not exists public.education_feedback(
 id uuid primary key default gen_random_uuid(),
 reference text not null unique default ('EDU-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))),
 tracking_token uuid not null unique default gen_random_uuid(),
 sender_role text not null check(sender_role in ('student','cr','mp','minister')),
 role_verified boolean not null default false,
 verified_account uuid references auth.users(id) on delete set null,
 full_name text not null check(char_length(btrim(full_name)) between 3 and 120),
 registration_number text not null check(registration_number ~ '^RU/[A-Z0-9-]+/[0-9]{4}/[0-9]{1,8}$'),
 course text not null check(char_length(btrim(course)) between 2 and 120),
 study_year integer not null check(study_year between 1 and 4),
 phone text not null check(phone ~ '^\+?[0-9]{9,15}$'),
 role_scope text check(char_length(role_scope)<=180),
 kind text not null check(kind in ('opinion','complaint','challenge','suggestion','praise')),
 category text not null check(category in ('teaching','timetable','exams','results','facilities','library','other')),
 title text not null check(char_length(btrim(title)) between 3 and 160),
 description text not null check(char_length(btrim(description)) between 10 and 4000),
 solution text not null default '' check(char_length(solution)<=2000),
 evidence_url text check(evidence_url is null or (char_length(evidence_url)<=1500 and evidence_url ~ '^https://[^[:space:]<>]+$' and evidence_url !~ '^https://[^/]*@')),
 status text not null default 'submitted' check(status in ('submitted','in_progress','waiting','resolved','closed')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(sender_role='student' or (role_scope is not null and char_length(btrim(role_scope))>=2))
);
create index if not exists education_inbox on public.education_feedback(sender_role,status,created_at desc);
create index if not exists education_feedback_time on public.education_feedback(created_at);
alter table public.education_feedback enable row level security;
revoke all on public.education_feedback from anon,authenticated;
grant select on public.education_feedback to authenticated;
drop policy if exists education_inbox_read on public.education_feedback;
create policy education_inbox_read on public.education_feedback for select to authenticated using(public.can_manage_education());
create table if not exists public.education_replies(
 id uuid primary key default gen_random_uuid(),
 feedback_id uuid not null references public.education_feedback(id) on delete cascade,
 status text not null,
 reply text not null check(char_length(btrim(reply)) between 3 and 2000),
 actor_id uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now()
);
alter table public.education_replies enable row level security;
revoke all on public.education_replies from anon,authenticated;
grant select on public.education_replies to authenticated;
drop policy if exists education_replies_read on public.education_replies;
create policy education_replies_read on public.education_replies for select to authenticated using(public.can_manage_education());
create or replace function public.education_public_info() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('title',title,'is_open',is_open) from public.education_settings where id=1;
$$;
create or replace function public.education_identity() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('account_id',auth.uid(),'roles',
  coalesce((select jsonb_agg(r.role) from public.education_representatives r where r.user_id=auth.uid() and r.active and
   (r.role<>'mp' or exists(select 1 from public.parliament_members m where m.id=r.parliament_id and m.active))),'[]'::jsonb) ||
  case when exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='leader' and p.position='minister') then '["minister"]'::jsonb else '[]'::jsonb end);
$$;
create or replace function public.submit_education_feedback(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.education_feedback; v_role text:=p_payload->>'sender_role'; v_verified boolean:=false;
 v_name text:=btrim(p_payload->>'full_name'); v_scope text:=btrim(p_payload->>'role_scope'); v_rep public.education_representatives;
begin
 perform pg_advisory_xact_lock(230023);
 if not exists(select 1 from public.education_settings where id=1 and is_open) then raise exception 'EDUCATION_CLOSED'; end if;
 if (select count(*) from public.education_feedback where created_at>=date_trunc('day',now()))>=500 then raise exception 'DAILY_LIMIT'; end if;
 if v_role in ('cr','mp') and auth.uid() is not null then
  select * into v_rep from public.education_representatives r where r.user_id=auth.uid() and r.role=v_role and r.active
    and (r.role<>'mp' or exists(select 1 from public.parliament_members m where m.id=r.parliament_id and m.active));
  if found then v_verified:=true; v_name:=v_rep.full_name; v_scope:=v_rep.scope; end if;
 elsif v_role='minister' and auth.uid() is not null then
  select p.full_name,m.name into v_name,v_scope from public.profiles p join public.ministries m on m.id=p.ministry_id
   where p.id=auth.uid() and p.active and p.role='leader' and p.position='minister';
  if found then v_verified:=true;
  else v_name:=btrim(p_payload->>'full_name');v_scope:=btrim(p_payload->>'role_scope');end if;
 end if;
 if exists(select 1 from public.education_feedback where created_at>now()-interval '3 minutes'
  and registration_number=upper(regexp_replace(p_payload->>'registration_number','\s','','g'))
  and title=btrim(p_payload->>'title') and description=btrim(p_payload->>'description')) then raise exception 'DUPLICATE_SUBMISSION';end if;
 insert into public.education_feedback(sender_role,role_verified,verified_account,full_name,registration_number,course,study_year,phone,role_scope,kind,category,title,description,solution,evidence_url)
 values(v_role,v_verified,case when v_verified then auth.uid() end,v_name,
  upper(regexp_replace(p_payload->>'registration_number','\s','','g')),btrim(p_payload->>'course'),(p_payload->>'study_year')::integer,
  regexp_replace(p_payload->>'phone','[\s()-]','','g'),case when v_role='student' then null else v_scope end,
  p_payload->>'kind',p_payload->>'category',btrim(p_payload->>'title'),btrim(p_payload->>'description'),coalesce(btrim(p_payload->>'solution'),''),nullif(btrim(p_payload->>'evidence_url'),'')) returning * into f;
 return jsonb_build_object('reference',f.reference,'tracking_token',f.tracking_token,'role_verified',f.role_verified);
end; $$;
create or replace function public.track_education_feedback(p_reference text,p_token uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('reference',f.reference,'status',f.status,'sender_role',f.sender_role,'role_verified',f.role_verified,
 'replies',coalesce((select jsonb_agg(jsonb_build_object('status',r.status,'reply',r.reply,'created_at',r.created_at) order by r.created_at,r.id)
  from public.education_replies r where r.feedback_id=f.id),'[]'::jsonb))
 from public.education_feedback f where f.reference=p_reference and f.tracking_token=p_token;
$$;
create or replace function public.list_education_feedback(p_role text default null,p_kind text default null,p_status text default null,p_course text default null,p_year integer default null,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.can_manage_education() then raise exception 'NOT_AUTHORIZED' using errcode='42501';end if;
 if p_offset is null or p_offset<0 then raise exception 'INVALID_PAGE';end if;
 with filtered as(select f.* from public.education_feedback f where (p_role is null or f.sender_role=p_role)
  and(p_kind is null or f.kind=p_kind) and(p_status is null or f.status=p_status)
  and(p_year is null or f.study_year=p_year) and(nullif(btrim(p_course),'')is null or strpos(lower(f.course),lower(btrim(p_course)))>0)),
 page as(select * from filtered order by created_at desc,id limit 30 offset p_offset)
 select jsonb_build_object('total',(select count(*)from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(p)-'tracking_token' order by p.created_at desc,p.id)from page p),'[]'::jsonb))into result;
 return result;
end; $$;
create or replace function public.reply_education_feedback(p_id uuid,p_status text,p_reply text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.can_manage_education() then raise exception 'NOT_AUTHORIZED' using errcode='42501';end if;
 if p_status is null or p_status not in ('submitted','in_progress','waiting','resolved','closed') then raise exception 'INVALID_STATUS';end if;
 perform 1 from public.education_feedback where id=p_id for update;if not found then raise exception 'NOT_FOUND';end if;
 insert into public.education_replies(feedback_id,status,reply,actor_id)values(p_id,p_status,btrim(p_reply),auth.uid());
 update public.education_feedback set status=p_status,updated_at=now()where id=p_id;
end; $$;
create or replace function public.configure_education(p_title text,p_open boolean,p_ministry uuid)returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.education_is_super() then raise exception 'NOT_AUTHORIZED' using errcode='42501';end if;
 if p_open is null or not exists(select 1 from public.ministries where id=p_ministry and active)then raise exception 'INVALID_SETTINGS';end if;
 update public.education_settings set title=btrim(p_title),is_open=p_open,ministry_id=p_ministry where id=1;
end; $$;
create or replace function public.save_education_representative(p_account uuid,p_role text,p_name text,p_reg text,p_course text,p_year integer,p_scope text,p_parliament uuid default null)returns void
language plpgsql security definer set search_path='' as $$
declare v_name text:=btrim(p_name);v_scope text:=btrim(p_scope);
begin
 if not public.education_is_super()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 if not exists(select 1 from auth.users where id=p_account)then raise exception 'ACCOUNT_NOT_FOUND';end if;
 if p_role='mp'then
  select full_name,coalesce(nullif(btrim(constituency),''),v_scope)into v_name,v_scope from public.parliament_members where id=p_parliament and active;
  if not found then raise exception 'MP_NOT_FOUND';end if;
 end if;
 insert into public.education_representatives(user_id,role,full_name,registration_number,course,study_year,scope,parliament_id)
 values(p_account,p_role,v_name,nullif(upper(btrim(p_reg)),''),nullif(btrim(p_course),''),p_year,v_scope,case when p_role='mp'then p_parliament end)
 on conflict(user_id,role)do update set full_name=excluded.full_name,registration_number=excluded.registration_number,
 course=excluded.course,study_year=excluded.study_year,scope=excluded.scope,parliament_id=excluded.parliament_id,active=true,updated_at=now();
end; $$;
create or replace function public.set_education_representative_active(p_account uuid,p_role text,p_active boolean)returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.education_is_super()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 if p_active and exists(select 1 from public.education_representatives r where r.user_id=p_account and r.role=p_role and r.role='mp' and not exists(select 1 from public.parliament_members m where m.id=r.parliament_id and m.active))then raise exception 'MP_NOT_FOUND';end if;
 update public.education_representatives set active=p_active,updated_at=now()where user_id=p_account and role=p_role;
end; $$;
revoke all on function public.education_public_info(),public.education_identity(),public.submit_education_feedback(jsonb),public.track_education_feedback(text,uuid),public.list_education_feedback(text,text,text,text,integer,integer),public.reply_education_feedback(uuid,text,text),public.configure_education(text,boolean,uuid),public.save_education_representative(uuid,text,text,text,text,integer,text,uuid),public.set_education_representative_active(uuid,text,boolean)from public,anon,authenticated;
grant execute on function public.education_public_info(),public.education_identity(),public.submit_education_feedback(jsonb),public.track_education_feedback(text,uuid)to anon,authenticated;
grant execute on function public.list_education_feedback(text,text,text,text,integer,integer),public.reply_education_feedback(uuid,text,text),public.configure_education(text,boolean,uuid),public.save_education_representative(uuid,text,text,text,text,integer,text,uuid),public.set_education_representative_active(uuid,text,boolean)to authenticated;
notify pgrst,'reload schema';
commit;
