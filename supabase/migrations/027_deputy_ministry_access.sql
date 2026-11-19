-- Deputy ministers share their OWN ministry's inbox and exports.
-- Secretaries, ordinary admins, other ministries and students remain excluded.
-- Does not alter accounts, credentials, ministry routes or existing submissions.
begin;
create or replace function public.can_access_ministry(p_ministry uuid)returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid()and p.active and not coalesce(p.must_change_password,false)
 and(p.role='super_admin'or(p.role='leader'and p.position in('minister','deputy_minister')and p_ministry is not null and p.ministry_id=p_ministry
 and exists(select 1 from public.ministries m where m.id=p_ministry and m.active))));
$$;

create or replace function public.can_manage_first_year_feedback()returns boolean
language sql stable security definer set search_path='' as $$
 select public.is_super_admin()or exists(select 1 from public.profiles p where p.id=auth.uid()and p.active and p.role='leader'and p.position in('minister','deputy_minister')and public.can_access_ministry(p.ministry_id));
$$;

create or replace function public.staff_portal_overview()returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare cards jsonb:='[]'::jsonb;n bigint;total bigint;
begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid()and p.active and not coalesce(p.must_change_password,false)and(p.role='super_admin'or(p.role='leader'and p.position in('minister','deputy_minister'))))then return cards;end if;
 select count(*),count(*)filter(where status='New')into total,n from public.feedback where public.can_access_ministry(ministry_id);
 cards:=cards||jsonb_build_array(jsonb_build_object('key','feedback','label','Maoni na malalamiko ya wizara','href','/leader/inbox/','total',total,'new',n));
 if public.can_manage_education()then
 select count(*),count(*)filter(where status='submitted')into total,n from public.education_feedback;
 cards:=cards||jsonb_build_array(jsonb_build_object('key','education','label','Maoni ya Elimu','href','/admin/education/','total',total,'new',n));end if;
 if public.can_manage_security_cases()then
 select count(*),count(*)filter(where status='submitted')into total,n from public.student_cases where kind in('lost','found')and public.can_access_ministry(ministry_id);
 cards:=cards||jsonb_build_array(jsonb_build_object('key','security','label','Ripoti za Ulinzi: vilivyopotea / kuokotwa','href','/staff/student-services/','total',total,'new',n));end if;
 if public.can_manage_sports()then
 select count(*)into total from public.sports_registrations;
 cards:=cards||jsonb_build_array(jsonb_build_object('key','sports','label','Waliojisajili Michezo','href','/admin/sports/','total',total));end if;
 if public.can_manage_loan_pending()then
 select count(*)into total from public.loan_pending_samples;
 cards:=cards||jsonb_build_array(jsonb_build_object('key','loans','label','Sample za Mkopo Pending','href','/admin/loan-pending/','total',total));end if;
 select count(*),count(*)filter(where status='submitted')into total,n from public.student_cases where kind='first_year_feedback'and public.can_access_ministry(ministry_id);
 cards:=cards||jsonb_build_array(jsonb_build_object('key','first_year','label','Maoni ya mwaka wa kwanza','href','/staff/student-services/','total',total,'new',n));
 return cards;
end;$$;

create or replace function public.staff_portal_routes()returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not public.is_super_admin()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 return(select jsonb_agg(jsonb_build_object('key',r.key,'ministry_id',r.mid,'ministry',m.name,'ministers',(select count(*)from public.profiles p where p.active and p.role='leader'and p.position='minister'and p.ministry_id=r.mid),'handlers',(select count(*)from public.profiles p where p.active and p.role='leader'and p.position in('minister','deputy_minister')and p.ministry_id=r.mid)))from(
 select 'education'as key,ministry_id as mid from public.education_settings where id=1 union all
 select 'security',security_ministry_id from public.student_service_settings where id=true union all
 select 'sports',ministry_id from public.sports_event where id=1 union all
 select 'loans',ministry_id from public.loan_pending_settings where id=1)r left join public.ministries m on m.id=r.mid);
end;$$;
notify pgrst,'reload schema';
commit;
