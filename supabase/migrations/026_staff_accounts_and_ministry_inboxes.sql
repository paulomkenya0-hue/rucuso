-- Account provisioning is service-only; all student submissions are private to
-- the responsible minister and super admin. No existing account is recreated.
begin;
create or replace function public.is_super_admin()returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid()and active and role='super_admin');
$$;
create or replace function public.has_permission(p_key text)returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select role='super_admin'or(role='admin'and permissions->>p_key='true')from public.profiles where id=auth.uid()and active),false);
$$;
create or replace function public.can_access_ministry(p_ministry uuid)returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid()and p.active and not coalesce(p.must_change_password,false)
 and(p.role='super_admin'or(p.role='leader'and p.position='minister'and p_ministry is not null and p.ministry_id=p_ministry
 and exists(select 1 from public.ministries m where m.id=p_ministry and m.active))));
$$;
create or replace function public.provision_directory_leader(p_auth_id uuid,p_leader_id uuid,p_username text)returns uuid
language plpgsql security definer set search_path='' as $$
declare d public.leaders;pos public.leadership_positions;u text:=lower(btrim(p_username));
begin
 if u is null or u!~'^[a-z0-9._-]{3,32}$'then raise exception 'INVALID_USERNAME';end if;
 select * into d from public.leaders where id=p_leader_id for update;
 if not found or not d.active then raise exception 'DIRECTORY_INACTIVE_OR_MISSING';end if;
 select * into pos from public.leadership_positions where key=d.position and active;
 if not found then raise exception 'INVALID_POSITION';end if;
 if pos.ministry_required and not exists(select 1 from public.ministries where id=d.ministry_id and active)then raise exception 'MINISTRY_REQUIRED';end if;
 if not pos.ministry_required and d.ministry_id is not null then raise exception 'DIRECTORY_ASSIGNMENT_REVIEW_REQUIRED';end if;
 if not exists(select 1 from auth.users where id=p_auth_id)or exists(select 1 from public.profiles where id=p_auth_id)then raise exception 'AUTH_USER_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.profiles where leader_id=d.id)then raise exception 'LEADER_ALREADY_LINKED';end if;
 if exists(select 1 from public.profiles where lower(btrim(full_name))=lower(btrim(d.full_name)))then raise exception 'EXISTING_ACCOUNT_REVIEW_REQUIRED';end if;
 -- Serialize accounts for the same leadership slot, even on two directory rows.
 perform pg_advisory_xact_lock(hashtextextended(d.position||coalesce(d.ministry_id::text,''),260026));
 if d.position not in('representative','officer')and exists(select 1 from public.profiles where active and role='leader'and position=d.position and ministry_id is not distinct from d.ministry_id)then raise exception 'POSITION_ACCOUNT_EXISTS';end if;
 insert into public.profiles(id,full_name,role,position,ministry_id,username,active,must_change_password,leader_id,permissions)
 values(p_auth_id,d.full_name,'leader',d.position,d.ministry_id,u,true,true,d.id,'{}'::jsonb);
 return p_auth_id;
end;$$;
revoke all on function public.provision_directory_leader(uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.provision_directory_leader(uuid,uuid,text)to service_role;

-- Restrictive policies remain effective even if an old permissive admin or
-- executive policy exists. Null/unassigned ministry goes to super admin only.
drop policy if exists strict_ministry_feedback on public.feedback;
create policy strict_ministry_feedback on public.feedback as restrictive for all to authenticated
 using(public.can_access_ministry(ministry_id))with check(public.can_access_ministry(ministry_id));
drop policy if exists strict_ministry_history on public.feedback_status_history;
create policy strict_ministry_history on public.feedback_status_history as restrictive for all to authenticated
 using(exists(select 1 from public.feedback f where f.id=feedback_id and public.can_access_ministry(f.ministry_id)))
 with check(exists(select 1 from public.feedback f where f.id=feedback_id and public.can_access_ministry(f.ministry_id))and changed_by=auth.uid());
drop policy if exists strict_ministry_notes on public.internal_notes;
create policy strict_ministry_notes on public.internal_notes as restrictive for all to authenticated
 using(exists(select 1 from public.feedback f where f.id=feedback_id and public.can_access_ministry(f.ministry_id)))
 with check(exists(select 1 from public.feedback f where f.id=feedback_id and public.can_access_ministry(f.ministry_id))and admin_id=auth.uid());
drop policy if exists strict_ministry_attachments on public.attachments;
create policy strict_ministry_attachments on public.attachments as restrictive for all to authenticated
 using(exists(select 1 from public.feedback f where f.id=feedback_id and public.can_access_ministry(f.ministry_id)))
 with check(exists(select 1 from public.feedback f where f.id=feedback_id and public.can_access_ministry(f.ministry_id)));
-- Also restrict signed URLs / downloads from the private evidence bucket.
drop policy if exists strict_ministry_evidence_read on storage.objects;
create policy strict_ministry_evidence_read on storage.objects as restrictive for select to authenticated
 using(bucket_id<>'feedback-attachments'or exists(select 1 from public.attachments a join public.feedback f on f.id=a.feedback_id where a.file_url=name and public.can_access_ministry(f.ministry_id)));
drop policy if exists strict_ministry_evidence_delete on storage.objects;
create policy strict_ministry_evidence_delete on storage.objects as restrictive for delete to authenticated
 using(bucket_id<>'feedback-attachments'or exists(select 1 from public.attachments a join public.feedback f on f.id=a.feedback_id where a.file_url=name and public.can_access_ministry(f.ministry_id)));
create or replace function public.validate_feedback_ministry()returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT'or new.ministry_id is distinct from old.ministry_id then
 if new.ministry_id is not null and not exists(select 1 from public.ministries where id=new.ministry_id and active)then raise exception 'INVALID_MINISTRY';end if;
 end if;return new;
end;$$;
drop trigger if exists feedback_ministry_route on public.feedback;
create trigger feedback_ministry_route before insert or update on public.feedback for each row execute function public.validate_feedback_ministry();

create or replace function public.can_manage_security_cases()returns boolean
language sql stable security definer set search_path='' as $$
 select public.can_access_ministry(null)or exists(select 1 from public.student_service_settings s join public.ministries m on m.id=s.security_ministry_id where m.active and lower(m.name)~'ulinzi|security|defen[cs]e'and public.can_access_ministry(m.id));
$$;
create or replace function public.can_manage_first_year_feedback()returns boolean
language sql stable security definer set search_path='' as $$
 select public.is_super_admin()or exists(select 1 from public.profiles p where p.id=auth.uid()and p.active and p.role='leader'and p.position='minister'and public.can_access_ministry(p.ministry_id));
$$;
drop policy if exists private_cases_read on public.student_cases;
create policy private_cases_read on public.student_cases for select to authenticated using(public.can_access_ministry(ministry_id)and(kind='first_year_feedback'or public.can_manage_security_cases()));
drop policy if exists strict_student_case_scope on public.student_cases;
create policy strict_student_case_scope on public.student_cases as restrictive for all to authenticated using(public.can_access_ministry(ministry_id)and(kind='first_year_feedback'or public.can_manage_security_cases()))with check(public.can_access_ministry(ministry_id)and(kind='first_year_feedback'or public.can_manage_security_cases()));
create or replace function public.update_student_case(p_id uuid,p_status text,p_reply text)returns void
language plpgsql security definer set search_path='' as $$
declare c public.student_cases;
begin
 select * into c from public.student_cases where id=p_id and public.can_access_ministry(ministry_id)and(kind='first_year_feedback'or public.can_manage_security_cases())for update;
 if not found or not public.can_access_ministry(c.ministry_id)then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 if p_status is null or p_status not in('submitted','in_progress','waiting','resolved','closed')or p_reply is null or char_length(btrim(p_reply))not between 3 and 2000 then raise exception 'INVALID_UPDATE';end if;
 update public.student_cases set status=p_status,public_reply=btrim(p_reply),updated_at=now(),first_response_at=coalesce(first_response_at,now())where id=p_id;
 insert into public.student_case_updates(case_id,status,public_reply,actor_id)values(p_id,p_status,btrim(p_reply),auth.uid());
end;$$;
create or replace function public.can_manage_education()returns boolean
language sql stable security definer set search_path='' as $$select public.can_access_ministry(null)or exists(select 1 from public.education_settings s join public.ministries m on m.id=s.ministry_id where m.active and lower(m.name)~'elimu|education'and public.can_access_ministry(m.id));$$;
create or replace function public.can_manage_sports()returns boolean
language sql stable security definer set search_path='' as $$select public.can_access_ministry(null)or exists(select 1 from public.sports_event s join public.ministries m on m.id=s.ministry_id where m.active and lower(m.name)~'michezo|sport'and public.can_access_ministry(m.id));$$;
create or replace function public.can_manage_loan_pending()returns boolean
language sql stable security definer set search_path='' as $$select public.can_access_ministry(null)or exists(select 1 from public.loan_pending_settings s join public.ministries m on m.id=s.ministry_id where m.active and lower(m.name)~'mikopo|loan'and public.can_access_ministry(m.id));$$;

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
  else
    v_route:=nullif(p_payload->>'ministry_id','')::uuid;
    if v_route is not null and not exists(select 1 from public.ministries where id=v_route and active)then raise exception 'INVALID_MINISTRY';end if;
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
create or replace function public.assign_feedback_ministry(p_id uuid,p_ministry uuid)returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.is_super_admin()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 if p_ministry is not null and not exists(select 1 from public.ministries where id=p_ministry and active)then raise exception 'INVALID_MINISTRY';end if;
 update public.feedback set ministry_id=p_ministry,assigned_to=null,updated_at=now()where id=p_id;
 if not found then raise exception 'NOT_FOUND';end if;
end;$$;
revoke all on function public.assign_feedback_ministry(uuid,uuid)from public,anon,authenticated;
grant execute on function public.assign_feedback_ministry(uuid,uuid)to authenticated;

create or replace function public.reply_ministry_feedback(p_id uuid,p_status text,p_response text)returns void
language plpgsql security definer set search_path='' as $$
declare f public.feedback;
begin
 select * into f from public.feedback where id=p_id and public.can_access_ministry(ministry_id)for update;
 if not found or not public.can_access_ministry(f.ministry_id)then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 if p_status is null or p_status not in('New','Under Review','Assigned','In Progress','Awaiting Information','Resolved','Closed','Rejected/Invalid')or p_response is null or char_length(btrim(p_response))not between 3 and 2000 then raise exception 'INVALID_UPDATE';end if;
 update public.feedback set status=p_status,response=btrim(p_response),updated_at=now(),resolved_at=case when p_status in('Resolved','Closed')then coalesce(resolved_at,now())else null end where id=p_id;
 insert into public.feedback_status_history(feedback_id,old_status,new_status,changed_by)values(p_id,f.status,p_status,auth.uid());
end;$$;
revoke all on function public.reply_ministry_feedback(uuid,text,text)from public,anon,authenticated;
grant execute on function public.reply_ministry_feedback(uuid,text,text)to authenticated;

-- A predictable legacy reference must not expose the minister's reply.
alter table public.feedback add column if not exists tracking_token uuid not null default gen_random_uuid();
create or replace function public.submit_feedback_receipt(p_payload jsonb)returns jsonb
language plpgsql security definer set search_path='' as $$
declare ref text;t uuid;
begin
 ref:=public.submit_feedback(
  p_submission_type=>p_payload->>'p_submission_type',p_title=>p_payload->>'p_title',p_description=>p_payload->>'p_description',
  p_category_id=>nullif(p_payload->>'p_category_id','')::uuid,p_incident_date=>nullif(p_payload->>'p_incident_date','')::date,
  p_location=>p_payload->>'p_location',p_suggested_solution=>p_payload->>'p_suggested_solution',p_satisfaction_rating=>nullif(p_payload->>'p_satisfaction_rating','')::integer,
  p_priority=>coalesce(p_payload->>'p_priority','Medium'),p_is_anonymous=>coalesce((p_payload->>'p_is_anonymous')::boolean,false),
  p_student_id=>nullif(p_payload->>'p_student_id','')::uuid,p_student_name=>p_payload->>'p_student_name',p_student_reg=>p_payload->>'p_student_reg',
  p_student_programme=>p_payload->>'p_student_programme',p_student_year=>p_payload->>'p_student_year',p_student_phone=>p_payload->>'p_student_phone',p_student_email=>p_payload->>'p_student_email',
  p_ministry_id=>nullif(p_payload->>'p_ministry_id','')::uuid,p_attachment_url=>p_payload->>'p_attachment_url',p_attachment_name=>p_payload->>'p_attachment_name');
 select tracking_token into t from public.feedback where reference_number=ref;
 return jsonb_build_object('reference',ref,'tracking_token',t);
end;$$;
create or replace function public.track_feedback(p_ref text)returns table(reference_number text,submission_type text,category text,status text,response text,created_at timestamptz)
language sql stable security definer set search_path='' as $$
 select f.reference_number,f.submission_type,c.name,f.status,case when public.can_access_ministry(f.ministry_id)then f.response else null end,f.created_at
 from public.feedback f left join public.categories c on c.id=f.category_id where f.reference_number=p_ref limit 1;
$$;
create or replace function public.track_feedback(p_ref text,p_token uuid)returns table(reference_number text,submission_type text,category text,status text,response text,created_at timestamptz)
language sql stable security definer set search_path='' as $$
 select f.reference_number,f.submission_type,c.name,f.status,f.response,f.created_at
 from public.feedback f left join public.categories c on c.id=f.category_id where f.reference_number=p_ref and f.tracking_token=p_token limit 1;
$$;

create or replace function public.staff_portal_overview()returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare cards jsonb:='[]'::jsonb;n bigint;total bigint;
begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid()and p.active and not coalesce(p.must_change_password,false)and(p.role='super_admin'or(p.role='leader'and p.position='minister')))then return cards;end if;
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
 return(select jsonb_agg(jsonb_build_object('key',r.key,'ministry_id',r.mid,'ministry',m.name,'ministers',(select count(*)from public.profiles p where p.active and p.role='leader'and p.position='minister'and p.ministry_id=r.mid)))from(
 select 'education'as key,ministry_id as mid from public.education_settings where id=1 union all
 select 'security',security_ministry_id from public.student_service_settings where id=true union all
 select 'sports',ministry_id from public.sports_event where id=1 union all
 select 'loans',ministry_id from public.loan_pending_settings where id=1)r left join public.ministries m on m.id=r.mid);
end;$$;
create or replace function public.set_staff_portal_route(p_module text,p_ministry uuid)returns void
language plpgsql security definer set search_path='' as $$
declare n text;
begin
 if not public.is_super_admin()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 select lower(name)into n from public.ministries where id=p_ministry and active;
 if n is null or not(case p_module when 'education'then n~'elimu|education'when 'security'then n~'ulinzi|security|defen[cs]e'when 'sports'then n~'michezo|sport'when 'loans'then n~'mikopo|loan'else false end)then raise exception 'INVALID_MINISTRY';end if;
 case p_module
 when 'education'then update public.education_settings set ministry_id=p_ministry where id=1;
 when 'security'then
 perform pg_advisory_xact_lock(200020);
 update public.student_cases set ministry_id=p_ministry where kind in('lost','found')and ministry_id=(select security_ministry_id from public.student_service_settings where id=true);
 update public.student_service_settings set security_ministry_id=p_ministry where id=true;
 when 'sports'then update public.sports_event set ministry_id=p_ministry where id=1;
 when 'loans'then update public.loan_pending_settings set ministry_id=p_ministry where id=1;
 end case;
end;$$;
revoke update on public.student_service_settings from authenticated;
revoke update(security_ministry_id)on public.student_service_settings from authenticated;
revoke all on function public.can_access_ministry(uuid),public.staff_portal_overview(),public.staff_portal_routes(),public.set_staff_portal_route(text,uuid)from public,anon,authenticated;
grant execute on function public.can_access_ministry(uuid)to anon,authenticated;
grant execute on function public.staff_portal_overview(),public.staff_portal_routes(),public.set_staff_portal_route(text,uuid)to authenticated;
revoke all on function public.submit_feedback_receipt(jsonb),public.track_feedback(text),public.track_feedback(text,uuid)from public,anon,authenticated;
grant execute on function public.submit_feedback_receipt(jsonb),public.track_feedback(text),public.track_feedback(text,uuid)to anon,authenticated;
notify pgrst,'reload schema';
commit;
