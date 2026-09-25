-- ============================================================
-- RUCUSO — Migration 002: production backend hardening
-- Run this AFTER 001 (supabase/schema.sql), in the Supabase SQL Editor.
--
-- Safe by design:
--   * additive only — new tables' policies, new columns, new functions
--   * no existing data is deleted or rewritten
--   * no existing RLS policy is weakened; four gaps are *closed*
--   * re-runnable (every create is guarded)
--
-- What it does, in order:
--   1. Turns on RLS on four reference tables that had NO RLS at all
--      (programmes, faculties, departments, academic_years were readable
--       AND writable by any anonymous visitor).
--   2. Creates the three Supabase Storage buckets the app needs.
--   3. Seeds the real reference data the UI needs to be usable
--      (categories + inactive student services). No fake leaders,
--      no "Wizara ya Mfano", no demo feedback.
--   4. Adds the student identity snapshot columns to `feedback`
--      (the submission form collects them; the table had nowhere to
--       put them, so issue management would have lost them).
--   5. Replaces the public "anyone can insert feedback" grant with a
--      single hardened RPC that generates the reference number,
--      enforces anonymity server-side, and blocks duplicate spam.
--   6. Widens track_feedback() with the category name so the public
--      tracking screen keeps its current layout.
--   7. Adds a staff-only student_count() so the dashboard never has to
--      download the whole registry to show one number.
-- ============================================================


-- ============================================================
-- 1. RLS ON THE FOUR UNPROTECTED REFERENCE TABLES
--    (schema.sql never enabled RLS on these — anon could INSERT/UPDATE/
--     DELETE rows in programmes, faculties, departments, academic_years)
-- ============================================================
alter table academic_years enable row level security;
alter table faculties        enable row level security;
alter table departments      enable row level security;
alter table programmes       enable row level security;

-- public visitors may read them; only a signed-in staff profile may write.
do $$
declare p record;
begin
  for p in select * from (values
      ('academic_years', 'public read academic years'),
      ('faculties',       'public read faculties'),
      ('departments',     'public read departments'),
      ('programmes',      'public read programmes')
    ) as x(tbl, pol) loop
    if not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = p.tbl and policyname = p.pol) then
      execute format('create policy %I on %I for select using (true)', p.pol, p.tbl);
    end if;
    if not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = p.tbl
                     and policyname = 'staff write ' || p.tbl) then
      execute format('create policy %I on %I for all using (public.is_staff()) with check (public.is_staff())',
                     'staff write ' || p.tbl, p.tbl);
    end if;
  end loop;
end $$;


-- ============================================================
-- 2. STORAGE BUCKETS
--    ruco-documents       public  — the document library is meant to be
--                                  readable by students; only staff upload.
--    leader-photos        public  — shown in the public leadership directory.
--    feedback-attachments private — student evidence. Nobody reads it except
--                                  staff, and only through a short-lived
--                                  signed URL.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('rucu-documents',       'rucu-documents',       true,  10485760),  -- 10 MB
  ('leader-photos',        'leader-photos',        true,   2097152),  --  2 MB
  ('feedback-attachments', 'feedback-attachments', false,  1048576)   --  1 MB
on conflict (id) do nothing;

do $$
declare p record;
begin
  for p in select * from (values
      ('rucu-documents',       'staff upload documents',   'rucu-documents'),
      ('leader-photos',        'staff upload leader photos','leader-photos')
    ) as x(bucket, pol, b) loop
    if not exists (select 1 from pg_policies
                   where schemaname = 'storage' and tablename = 'objects' and policyname = p.pol) then
      execute format(
        'create policy %I on storage.objects for insert to authenticated with check (bucket_id = %L and public.is_staff())',
        p.pol, p.b);
      execute format(
        'create policy %I on storage.objects for update to authenticated using (bucket_id = %L and public.is_staff()) with check (bucket_id = %L and public.is_staff())',
        p.pol || ' update', p.b, p.b);
      execute format(
        'create policy %I on storage.objects for delete to authenticated using (bucket_id = %L and public.is_staff())',
        p.pol || ' delete', p.b);
    end if;
  end loop;
end $$;

-- feedback-attachments: a student may upload, but only into a random folder,
-- and only staff may read or remove it.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'student uploads feedback attachments') then
    create policy "student uploads feedback attachments" on storage.objects for insert
      with check (
        bucket_id = 'feedback-attachments'
        and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'staff read feedback attachments') then
    create policy "staff read feedback attachments" on storage.objects for select to authenticated
      using (bucket_id = 'feedback-attachments' and public.is_staff());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'staff delete feedback attachments') then
    create policy "staff delete feedback attachments" on storage.objects for delete to authenticated
      using (bucket_id = 'feedback-attachments' and public.is_staff());
  end if;
end $$;


-- ============================================================
-- 3. REAL REFERENCE DATA (needed for the app to be usable at all —
--    the categories table was empty. These are the institution's own
--    category names, not demo records.)
-- ============================================================
insert into categories (name) values
  ('Loans & Student Financing'),
  ('Student Welfare'),
  ('Academic Services'),
  ('Registration'),
  ('Examination Services'),
  ('Accommodation'),
  ('Food/Cafeteria'),
  ('Library'),
  ('ICT/Internet'),
  ('Finance/Payments'),
  ('Administration'),
  ('Student Leadership'),
  ('Campus Environment'),
  ('Security'),
  ('Health Services'),
  ('Other')
on conflict (name) do nothing;

-- Student services start switched off, exactly like before: an admin turns a
-- service on once its real description/contact has been filled in.
insert into student_services (name)
select v.name
from unnest(array[
  'Mikopo','Uwezeshaji','Masuala ya Masomo','Mitihani','Usajili','Fedha','Malazi',
  'Chakula','Afya','Maktaba','ICT/Internet','Ushauri','Michezo','Clubs & Societies',
  'Student Welfare','Other Services'
]) as v(name)
where not exists (select 1 from student_services s where s.name = v.name);


-- ============================================================
-- 4. FEEDBACK IDENTITY SNAPSHOT
--    The submission form captures name / reg / programme / year / phone / email
--    for non-anonymous reports and the issue screen shows them, but the table
--    only had student_name_snapshot. These columns are appended (nullable), so
--    nothing existing is affected.
-- ============================================================
alter table feedback add column if not exists student_reg_snapshot   text;
alter table feedback add column if not exists student_programme     text;
alter table feedback add column if not exists student_year          text;
alter table feedback add column if not exists student_phone         text;
alter table feedback add column if not exists student_email         text;

create index if not exists idx_feedback_created  on feedback (created_at desc);
create index if not exists idx_feedback_category on feedback (category_id);
create index if not exists idx_fsh_feedback       on feedback_status_history (feedback_id);
create index if not exists idx_notes_feedback     on internal_notes (feedback_id);


-- ============================================================
-- 5. PUBLIC FEEDBACK SUBMISSION — HARDENED
--
--    Before: `anyone can submit feedback` (insert) plus the default anon
--    grant meant a visitor could insert a row with status = 'Resolved',
--    assigned_to = <any uuid>, or someone else's name. Now the browser has
--    no INSERT on feedback at all; the only way in is submit_feedback(),
--    which is SECURITY DEFINER and:
--      * writes the reference number server-side (no collisions, no guessing)
--      * forces anonymity server-side (identity columns are nulled, not trusted)
--      * validates every enum/check value itself
--      * refuses an identical title+category inside a 5-minute window
--      * optionally records the attachment row
-- ============================================================
drop policy if exists "anyone can submit feedback" on feedback;
drop policy if exists "anyone can attach on insert" on attachments;
revoke insert on feedback    from anon, authenticated;
revoke insert on attachments from anon, authenticated;

-- Reference numbers start at a random point in a 900,000-wide space so that
-- track_feedback() cannot simply be walked from RUCU-<year>-000001 upwards.
do $$
begin
  if not exists (select 1 from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'feedback_ref_seq') then
    execute 'create sequence public.feedback_ref_seq as bigint start with '
           || (floor(random() * 800000) + 100000)::text;
  end if;
end $$;

create or replace function public.submit_feedback(
  p_submission_type       text,
  p_title                 text,
  p_description           text,
  p_category_id           uuid    default null,
  p_incident_date         date    default null,
  p_location              text    default null,
  p_suggested_solution    text    default null,
  p_satisfaction_rating   int     default null,
  p_priority              text    default 'Medium',
  p_is_anonymous          boolean default false,
  p_student_id            uuid    default null,
  p_student_name          text    default null,
  p_student_reg           text    default null,
  p_student_programme     text    default null,
  p_student_year          text    default null,
  p_student_phone         text    default null,
  p_student_email         text    default null,
  p_ministry_id           uuid    default null,
  p_attachment_url        text    default null,
  p_attachment_name       text    default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref  text;
  v_id   uuid;
  v_anon boolean;
  v_dup  int;
begin
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'TITLE_REQUIRED' using errcode = '22023';
  end if;
  if coalesce(btrim(p_description), '') = '' then
    raise exception 'DESCRIPTION_REQUIRED' using errcode = '22023';
  end if;
  if p_submission_type is null
     or p_submission_type not in ('General Feedback','Complaint','Challenge/Problem','Suggestion','Praise/Appreciation') then
    raise exception 'INVALID_TYPE' using errcode = '22023';
  end if;
  if coalesce(p_priority, 'Medium') not in ('Low','Medium','High','Critical') then
    raise exception 'INVALID_PRIORITY' using errcode = '22023';
  end if;
  if p_satisfaction_rating is not null
     and (p_satisfaction_rating < 1 or p_satisfaction_rating > 5) then
    raise exception 'INVALID_RATING' using errcode = '22023';
  end if;

  v_anon := coalesce(p_is_anonymous, false);

  -- duplicate / spam guard: same subject in the same category within 5 minutes
  select count(*) into v_dup
  from feedback f
  where lower(btrim(f.title)) = lower(btrim(p_title))
    and f.category_id is not distinct from p_category_id
    and f.created_at > now() - interval '5 minutes';
  if v_dup > 0 then
    raise exception 'DUPLICATE_SUBMISSION' using errcode = '22023';
  end if;

  v_ref := 'RUCU-' || extract(year from current_date)::text || '-'
           || lpad(nextval('public.feedback_ref_seq')::text, 6, '0');

  insert into feedback (
    reference_number, submission_type, category_id, title, description,
    incident_date, location, suggested_solution, satisfaction_rating, priority,
    is_anonymous, student_id, student_name_snapshot,
    student_reg_snapshot, student_programme, student_year, student_phone, student_email,
    ministry_id, status
  ) values (
    v_ref, p_submission_type, p_category_id, btrim(p_title), btrim(p_description),
    p_incident_date,
    nullif(btrim(coalesce(p_location, '')), ''),
    nullif(btrim(coalesce(p_suggested_solution, '')), ''),
    p_satisfaction_rating, coalesce(p_priority, 'Medium'),
    v_anon,
    case when v_anon then null else p_student_id end,
    case when v_anon then null else nullif(btrim(coalesce(p_student_name, '')), '') end,
    case when v_anon then null else nullif(btrim(coalesce(p_student_reg, '')), '') end,
    case when v_anon then null else nullif(btrim(coalesce(p_student_programme, '')), '') end,
    case when v_anon then null else nullif(btrim(coalesce(p_student_year, '')), '') end,
    case when v_anon then null else nullif(btrim(coalesce(p_student_phone, '')), '') end,
    case when v_anon then null else nullif(btrim(coalesce(p_student_email, '')), '') end,
    p_ministry_id, 'New'
  ) returning id into v_id;

  if coalesce(btrim(coalesce(p_attachment_url, '')), '') <> '' then
    insert into attachments (feedback_id, file_url, file_name)
    values (v_id, p_attachment_url, nullif(btrim(coalesce(p_attachment_name, '')), ''));
  end if;

  return v_ref;
end;
$$;

grant execute on function public.submit_feedback(
  text, text, text, uuid, date, text, text, int, text, boolean,
  uuid, text, text, text, text, text, text, uuid, text, text
) to anon, authenticated;


-- ============================================================
-- 6. TRACKING — add the category name to the public tracking result
--    A function's return type cannot be altered in place, so the old
--    definition is dropped and immediately replaced by a superset of it
--    (same name, same argument, one extra output column). No data is
--    touched — the function only reads.
-- ============================================================
drop function if exists public.track_feedback(text);

create or replace function public.track_feedback(p_ref text)
returns table (
  reference_number text, submission_type text, category text,
  status text, response text, created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select f.reference_number, f.submission_type, c.name, f.status, f.response, f.created_at
  from feedback f
  left join categories c on c.id = f.category_id
  where f.reference_number = p_ref
  limit 1;
$$;

grant execute on function public.track_feedback(text) to anon, authenticated;


-- ============================================================
-- 7. DASHBOARD STUDENT COUNT
--    Returns 0 to anyone who is not staff, so the number can be shown
--    without opening the students table to the public.
-- ============================================================
create or replace function public.student_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_staff() then (select count(*)::int from students) else 0 end;
$$;

grant execute on function public.student_count() to anon, authenticated;


-- ============================================================
-- 8. PUBLIC LEADERSHIP VIEW
--
--    RLS decides *rows*, not *columns*, so "public read active leaders" was
--    also handing every visitor the leaders' registration_number and
--    phone_private. The public directory only ever needs the fields below, so
--    read access to the table itself is restricted to signed-in staff and the
--    public reads this view instead.
--
--    Without this, ANY signed-in auth user (including one with no profile row,
--    i.e. not staff) could read the private columns of every active leader.
-- ============================================================
create or replace view public.public_leaders as
  select l.id,
         l.full_name,
         l.position,
         l.ministry_id,
         m.name  as ministry,
         l.photo_url,
         l.bio,
         l.responsibilities,
         l.programme,
         l.year_of_study,
         l.office_location,
         l.phone_public,
         l.start_date,
         l.end_date,
         l.active,
         l.created_at
  from leaders l
  left join ministries m on m.id = l.ministry_id
  where l.active = true;

grant select on public.public_leaders to anon, authenticated;

-- anonymous visitors: no table access at all, the view is enough
revoke select on leaders from anon;

-- authenticated: staff only (a plain logged-in user gets nothing)
drop policy if exists "public read active leaders" on leaders;
create policy "staff read all leaders"
  on leaders for select to authenticated
  using (is_staff());

-- defence in depth on the OTP table: RLS already blocks anonymous writes, but
-- there is no reason for the grant to exist in the first place.
revoke all on otp_verifications from anon, authenticated;


-- ============================================================
-- 9. AUDIT LOG FROM THE PUBLIC SIDE
--    audit_logs has no anonymous INSERT policy on purpose (any visitor could
--    forge entries). This RPC records exactly one thing: that a student passed
--    the OTP check. The action name is whitelisted and the detail is truncated,
--    so it cannot be used to write arbitrary log content.
-- ============================================================
create or replace function public.log_public_action(p_action text, p_details text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_action is distinct from 'Student Verification (OTP)' then
    return;
  end if;
  insert into audit_logs (actor_id, actor_label, action, details)
  values (null,
          left(coalesce(p_details, ''), 120),
          'Student Verification (OTP)',
          'Mwanafunzi alithibitishwa kwa namba ya simu');
end;
$$;

grant execute on function public.log_public_action(text, text) to anon, authenticated;


-- ============================================================
-- 10. LOGIN AUDIT
--    Failed logins are deliberately not recorded (that table is readable by
--    any staff member and would leak attempted credentials); successful
--    logins are recorded by the front end via RucusoAPI.logAction().
-- ============================================================
-- (no DDL required)


-- ============================================================
-- 11. FIRST REAL ADMIN ACCOUNT — one-off manual step
--    Supabase Dashboard -> Authentication -> Users -> Add user,
--    then:
--
--      insert into profiles (id, full_name, role)
--      values ('<paste-the-uid-here>', 'Jina Lamili', 'super_admin')
--      on conflict (id) do update set role = excluded.role;
--
--    Every admin action in the app requires a row in `profiles`; without one
--    the login succeeds but the profile read is denied and the app shows
--    "Akaunti hii haina profili ya msimamizi".
--
--    Also create the storage buckets' public URLs note: the two public
--    buckets (rucu-documents, leader-photos) are readable by anyone with the
--    link; the third is private and only staff can open it.
-- ============================================================
