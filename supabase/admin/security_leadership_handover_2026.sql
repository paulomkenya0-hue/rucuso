-- Owner-run handover requested by the super admin. Run AFTER migration 027.
-- Stops on ambiguous identities/account links rather than editing another person.
-- No passwords, usernames, Auth users, photographs or contact fields are changed.
begin;
create table if not exists public.security_handover_runs(
 change_key text primary key,
 before_snapshot jsonb not null,
 applied_at timestamptz not null default now()
);
alter table public.security_handover_runs enable row level security;
revoke all on public.security_handover_runs from public,anon,authenticated;

do $handover$
declare
 k constant text:='security-mahfudhi-osca-2026-v1';
 outgoing public.leaders;incoming public.leaders;secretary public.leaders;
 n integer;mid uuid;snapshot jsonb;
begin
 if exists(select 1 from public.security_handover_runs where change_key=k)then
  raise notice 'Handover already applied; no records changed.';return;
 end if;
 -- Serialize against account provisioning and simultaneous personnel edits.
 lock table public.leaders,public.profiles in share row exclusive mode;
 perform pg_advisory_xact_lock(200020);
 select count(*)into n from public.leaders l join public.ministries m on m.id=l.ministry_id
 where regexp_replace(lower(l.full_name),'[^a-z]','','g')~'^mahfudhi.*katabazi?$'
 and lower(m.name)~'ulinzi|security|defen[cs]e'and m.active;
 if n<>1 then raise exception 'REVIEW_MAHFUDHI_IDENTITY: expected one Security directory row, found %',n;end if;
 select l.*into incoming from public.leaders l join public.ministries m on m.id=l.ministry_id
 where regexp_replace(lower(l.full_name),'[^a-z]','','g')~'^mahfudhi.*katabazi?$'
 and lower(m.name)~'ulinzi|security|defen[cs]e'and m.active;
 if incoming.position not in('ministry_secretary','minister')then raise exception 'REVIEW_MAHFUDHI_CURRENT_POST';end if;
 mid:=incoming.ministry_id;
 if not exists(select 1 from public.student_service_settings where id=true and security_ministry_id=mid)then raise exception 'REVIEW_SECURITY_ROUTE: configure the Security inbox to this ministry first';end if;
 select count(*)into n from public.leaders where ministry_id=mid and position='minister'
 and regexp_replace(lower(full_name),'[^a-z]','','g')~'^julius.*salan?ganda$';
 if n<>1 then raise exception 'REVIEW_OUTGOING_MINISTER: expected one Julius Salaganda/Salanganda row, found %',n;end if;
 select *into outgoing from public.leaders where ministry_id=mid and position='minister'
 and regexp_replace(lower(full_name),'[^a-z]','','g')~'^julius.*salan?ganda$';
 if outgoing.id=incoming.id then raise exception 'REVIEW_IDENTITIES';end if;
 select count(*)into n from public.leaders where regexp_replace(lower(full_name),'[^a-z]','','g')='oscakarokolajusto';
 if n>1 then raise exception 'REVIEW_OSCA_IDENTITY: multiple exact name matches';end if;
 if n=1 then
  select *into secretary from public.leaders where regexp_replace(lower(full_name),'[^a-z]','','g')='oscakarokolajusto';
  if secretary.position not in('ministry_secretary','officer','representative')then raise exception 'REVIEW_OSCA_CURRENT_POST';end if;
 elsif exists(select 1 from public.leaders where (regexp_replace(lower(full_name),'[^a-z]','','g')like '%karokolajusto%'or regexp_replace(lower(full_name),'[^a-z]','','g')~'^oscar?.*justo$'))then
  raise exception 'REVIEW_OSCA_SIMILAR_NAME: inspect the existing directory before adding another person';
 end if;
 if exists(select 1 from public.leaders where active and ministry_id=mid and position='minister'and id not in(outgoing.id,incoming.id))then raise exception 'REVIEW_OTHER_ACTIVE_MINISTER';end if;
 if exists(select 1 from public.leaders where active and ministry_id=mid and position='ministry_secretary'and id<>incoming.id and id is distinct from secretary.id)then raise exception 'REVIEW_OTHER_ACTIVE_SECRETARY';end if;
 -- Linked login profiles must refer to these exact people and remain leaders.
 if exists(select 1 from public.profiles where leader_id in(outgoing.id,incoming.id,secretary.id)and role<>'leader')then raise exception 'REVIEW_LINKED_ACCOUNT_ROLE';end if;
 if exists(select 1 from public.profiles where leader_id in(outgoing.id,incoming.id,secretary.id)group by leader_id having count(*)>1)then raise exception 'REVIEW_MULTIPLE_ACCOUNT_LINKS';end if;
 if exists(select 1 from public.profiles where active and role='leader'and ministry_id=mid and position='minister'and leader_id is distinct from outgoing.id and leader_id is distinct from incoming.id)then raise exception 'REVIEW_MINISTER_ACCOUNT_LINK';end if;
 if exists(select 1 from public.profiles where active and role='leader'and ministry_id=mid and position='ministry_secretary'and leader_id is distinct from incoming.id and leader_id is distinct from secretary.id)then raise exception 'REVIEW_SECRETARY_ACCOUNT_LINK';end if;
 if not exists(select 1 from public.profiles where leader_id=incoming.id)and exists(
 select 1 from public.profiles where regexp_replace(lower(full_name),'[^a-z]','','g')~'^mahfudhi.*katabazi?$')then raise exception 'REVIEW_MAHFUDHI_UNLINKED_ACCOUNT';end if;
 if not exists(select 1 from public.profiles where leader_id=secretary.id)and exists(
 select 1 from public.profiles where (regexp_replace(lower(full_name),'[^a-z]','','g')like '%karokolajusto%'or regexp_replace(lower(full_name),'[^a-z]','','g')~'^oscar?.*justo$'))then raise exception 'REVIEW_OSCA_UNLINKED_ACCOUNT';end if;
 snapshot:=jsonb_build_object(
  'leaders',(select coalesce(jsonb_agg(to_jsonb(l)),'[]')from public.leaders l where l.id in(outgoing.id,incoming.id,secretary.id)),
  'profiles',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.profiles p where p.leader_id in(outgoing.id,incoming.id,secretary.id))
 );
 update public.leaders set active=false,public_visible=false where id=outgoing.id;
 update public.profiles set active=false where leader_id=outgoing.id and role='leader';
 update public.leaders set position='minister',active=true where id=incoming.id;
 update public.profiles set position='minister',ministry_id=mid,active=true where leader_id=incoming.id and role='leader';
 if secretary.id is null then
  insert into public.leaders(full_name,position,ministry_id,bio,active,public_visible)
  values('OSCA KAROKOLA JUSTO','ministry_secretary',mid,'Katibu wa Wizara ya Ulinzi na Makazi ya RUCUSO.',true,true)returning *into secretary;
 else
  update public.leaders set position='ministry_secretary',ministry_id=mid,active=true where id=secretary.id;
  update public.profiles set position='ministry_secretary',ministry_id=mid,active=true where leader_id=secretary.id and role='leader';
 end if;
 insert into public.security_handover_runs(change_key,before_snapshot)values(k,snapshot);
end;$handover$;
commit;
-- No credentials in this result. A null username/account means create its login
-- from the existing directory-only section, not by importing another person.
select l.full_name,l.position,l.active as directory_active,p.username,p.active as account_active
from public.leaders l
left join public.profiles p on p.leader_id=l.id and p.role='leader'
where regexp_replace(lower(l.full_name),'[^a-z]','','g')~'^mahfudhi.*katabazi?$'
 or regexp_replace(lower(l.full_name),'[^a-z]','','g')~'^julius.*salan?ganda$'
 or regexp_replace(lower(l.full_name),'[^a-z]','','g')='oscakarokolajusto'
order by l.full_name;
