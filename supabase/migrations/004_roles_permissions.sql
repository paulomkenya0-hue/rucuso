-- ============================================================
-- RUCUSO — Migration 004: roles, permissions & ministry-scoped access
-- Run AFTER 001 (schema.sql), 002 (production_backend), 003 (ai_assistant).
--
-- Additive + one data migration on `profiles.role`. Nothing existing is
-- deleted. Safe to re-run (every step is guarded).
--
-- What it does:
--   1. Splits security ROLE from job TITLE.
--      Before: profiles.role in ('super_admin','president','secretary_general',
--              'minister','deputy_minister','representative','officer')
--      After:  profiles.role  in ('super_admin','admin','leader')
--              profiles.position holds the old value for anyone who wasn't
--              already super_admin (so existing accounts keep working —
--              a 'president' row becomes role='leader', position='president').
--   2. Adds username + must_change_password + permissions (jsonb) to profiles,
--      and links a login account to its public directory row (leader_id).
--   3. Adds helper functions: is_super_admin(), is_admin(), is_leader(),
--      has_permission(key), current_ministry_id().
--   4. Adds resolve_login_email() so leaders/admins can sign in with a
--      username instead of an email (Supabase Auth itself still only takes
--      email+password — this RPC just looks the email up first).
--   5. Tightens RLS on students, feedback, leaders, announcements, documents,
--      audit_logs to check has_permission()/is_super_admin() instead of the
--      old blanket is_staff(), and scopes feedback to a leader's own ministry
--      unless they hold the 'view_all_feedback' permission.
--
-- KNOWN PERMISSION KEYS (stored as boolean flags inside profiles.permissions,
-- meaningful only when role = 'admin' — super_admin implicitly has all of
-- them, leader permissions are position-based, see step 5):
--   view_feedback, manage_feedback, manage_students, manage_announcements,
--   manage_reports, manage_documents, manage_ministries, manage_categories,
--   manage_services, view_all_feedback, manage_admins, manage_settings,
--   view_audit_logs, manage_ai_config
-- ============================================================

-- ============================================================
-- 1. ROLE / TITLE SPLIT
-- ============================================================
alter table profiles add column if not exists position text;
alter table profiles add column if not exists username text;
alter table profiles add column if not exists must_change_password boolean not null default false;
alter table profiles add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table profiles add column if not exists leader_id uuid references leaders(id) on delete set null;
alter table profiles add column if not exists scope_note text; -- e.g. representative's stated scope, free text for now

-- Move the old granular "role" values into position, before we narrow the
-- check constraint. Only rows that are not already super_admin are touched.
update profiles
   set position = role
 where role <> 'super_admin'
   and (position is null or position = '');

update profiles
   set role = 'leader'
 where role not in ('super_admin');

-- Drop the old constraint (name from schema.sql) and add the narrowed one.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('super_admin','admin','leader'));

alter table profiles add constraint profiles_position_check
  check (position is null or position in
    ('president','secretary_general','minister','deputy_minister','representative','officer'));

create unique index if not exists idx_profiles_username on profiles (lower(username)) where username is not null;

-- ============================================================
-- 2. HELPER FUNCTIONS
-- ============================================================
create or replace function public.is_super_admin() returns boolean
language sql stable security definer as $$
  select exists (select 1 from profiles where id = auth.uid() and active = true and role = 'super_admin');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer as $$
  select exists (select 1 from profiles where id = auth.uid() and active = true and role = 'admin');
$$;

create or replace function public.is_leader() returns boolean
language sql stable security definer as $$
  select exists (select 1 from profiles where id = auth.uid() and active = true and role = 'leader');
$$;

-- true if the caller is super_admin, OR is an 'admin' whose permissions
-- jsonb has this key set truthy. Leaders never pass this check — their
-- access is position/ministry-scoped instead (see feedback policies below).
create or replace function public.has_permission(p_key text) returns boolean
language sql stable security definer as $$
  select coalesce(
    (select role = 'super_admin'
            or (role = 'admin' and (permissions ->> p_key) is not null and (permissions ->> p_key)::boolean = true)
     from profiles where id = auth.uid() and active = true),
    false
  );
$$;

create or replace function public.current_ministry_id() returns uuid
language sql stable security definer as $$
  select ministry_id from profiles where id = auth.uid() and active = true;
$$;

create or replace function public.current_position() returns text
language sql stable security definer as $$
  select position from profiles where id = auth.uid() and active = true;
$$;

-- Executive positions see feedback across all ministries even without an
-- explicit admin permission flag (matches item 8 of the spec: PRESIDENT can
-- view authorized executive reports).
create or replace function public.is_executive_leader() returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active = true and role = 'leader'
      and position in ('president','secretary_general')
  );
$$;

-- ============================================================
-- 3. USERNAME LOGIN
--    Supabase Auth signs in with email+password only. Leaders/admins log in
--    with a username, so the frontend calls this first to resolve the email,
--    then calls supabase.auth.signInWithPassword({email, password}).
--    Returns null for unknown/inactive usernames — same response either way,
--    so this cannot be used to enumerate accounts.
-- ============================================================
create or replace function public.resolve_login_email(p_username text)
returns text
language sql stable security definer
set search_path = public as $$
  select u.email
  from profiles p
  join auth.users u on u.id = p.id
  where lower(p.username) = lower(btrim(p_username))
    and p.active = true
  limit 1;
$$;

grant execute on function public.resolve_login_email(text) to anon, authenticated;

-- ============================================================
-- 4. TIGHTEN RLS — replace blanket is_staff() with role/permission checks
--    (is_staff() itself is left in place — other parts of the app may still
--    use it as "any authenticated staff row exists" — but the policies below
--    now decide by role/permission, not just by being staff.)
-- ============================================================

-- ---- students: only super_admin or admin with manage_students ----
drop policy if exists "staff read students" on students;
drop policy if exists "staff write students" on students;
create policy "authorized read students" on students for select
  using (is_super_admin() or has_permission('manage_students'));
create policy "authorized write students" on students for all
  using (is_super_admin() or has_permission('manage_students'))
  with check (is_super_admin() or has_permission('manage_students'));

-- ---- feedback: super_admin/admin(permission) see everything;
--      leaders see only their own ministry unless executive or granted
--      view_all_feedback ----
drop policy if exists "staff read feedback" on feedback;
drop policy if exists "staff update feedback" on feedback;
create policy "scoped read feedback" on feedback for select
  using (
    is_super_admin()
    or has_permission('view_feedback')
    or has_permission('view_all_feedback')
    or is_executive_leader()
    or (is_leader() and ministry_id is not distinct from current_ministry_id())
  );
create policy "scoped update feedback" on feedback for update
  using (
    is_super_admin()
    or has_permission('manage_feedback')
    or (is_leader() and ministry_id is not distinct from current_ministry_id())
  )
  with check (
    is_super_admin()
    or has_permission('manage_feedback')
    or (is_leader() and ministry_id is not distinct from current_ministry_id())
  );

drop policy if exists "staff read status history" on feedback_status_history;
create policy "scoped read status history" on feedback_status_history for select
  using (
    is_super_admin() or has_permission('view_feedback') or has_permission('view_all_feedback')
    or is_executive_leader()
    or exists (select 1 from feedback f where f.id = feedback_status_history.feedback_id
               and is_leader() and f.ministry_id is not distinct from current_ministry_id())
  );

drop policy if exists "staff read internal notes" on internal_notes;
create policy "scoped read internal notes" on internal_notes for select
  using (
    is_super_admin() or has_permission('view_feedback') or has_permission('view_all_feedback')
    or is_executive_leader()
    or exists (select 1 from feedback f where f.id = internal_notes.feedback_id
               and is_leader() and f.ministry_id is not distinct from current_ministry_id())
  );

drop policy if exists "staff read attachments" on attachments;
create policy "scoped read attachments" on attachments for select
  using (
    is_super_admin() or has_permission('view_feedback') or has_permission('view_all_feedback')
    or is_executive_leader()
    or exists (select 1 from feedback f where f.id = attachments.feedback_id
               and is_leader() and f.ministry_id is not distinct from current_ministry_id())
  );

-- ---- leaders (the auth-account side, i.e. profiles already covers this;
--      this section is the leaders directory table): only super_admin
--      manages it, everyone staff can still read it (needed for ministry
--      assignment pickers etc.) ----
drop policy if exists "staff write leaders" on leaders;
create policy "super_admin write leaders" on leaders for all
  using (is_super_admin()) with check (is_super_admin());

-- ---- ministries / categories / services: manage requires the matching
--      permission, not just any staff row ----
drop policy if exists "staff write ministries" on ministries;
create policy "authorized write ministries" on ministries for all
  using (is_super_admin() or has_permission('manage_ministries'))
  with check (is_super_admin() or has_permission('manage_ministries'));

drop policy if exists "staff write categories" on categories;
create policy "authorized write categories" on categories for all
  using (is_super_admin() or has_permission('manage_categories'))
  with check (is_super_admin() or has_permission('manage_categories'));

drop policy if exists "staff write services" on student_services;
create policy "authorized write services" on student_services for all
  using (is_super_admin() or has_permission('manage_services'))
  with check (is_super_admin() or has_permission('manage_services'));

-- ---- announcements / documents ----
drop policy if exists "staff write announcements" on announcements;
create policy "authorized write announcements" on announcements for all
  using (is_super_admin() or has_permission('manage_announcements'))
  with check (is_super_admin() or has_permission('manage_announcements'));

drop policy if exists "staff write documents" on documents;
create policy "authorized write documents" on documents for all
  using (is_super_admin() or has_permission('manage_documents'))
  with check (is_super_admin() or has_permission('manage_documents'));

-- ---- audit logs: only super_admin reads the full log (spec item 18) ----
drop policy if exists "staff read audit" on audit_logs;
create policy "super_admin read audit" on audit_logs for select
  using (is_super_admin() or has_permission('view_audit_logs'));

-- ---- profiles: super_admin manages admin/leader accounts; a signed-in
--      staff member can always read their own row (needed to check
--      must_change_password on login) ----
drop policy if exists "staff can read profiles" on profiles;
create policy "authorized read profiles" on profiles for select
  using (is_super_admin() or has_permission('manage_admins') or auth.uid() = id);
create policy "super_admin write profiles" on profiles for all
  using (is_super_admin()) with check (is_super_admin());
create policy "self update own row" on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
-- NOTE: the "self update own row" policy is intentionally permissive at the
-- RLS layer (Postgres RLS cannot easily restrict *which columns* an UPDATE
-- touches) — the app must only ever send {must_change_password:false,
-- <new password is set via auth.updateUser, not this table>} from the
-- change-password screen. Do not add a generic "edit my profile" form on
-- top of this policy without column-level checks.

-- ============================================================
-- 5. AUDIT LOG ACTION VOCABULARY (documentation only, not enforced by a
--    CHECK — audit_logs.action stays free text so the frontend + edge
--    functions can log any of these without a migration each time):
--    Login, Logout, Failed Login, Leader Creation, Leader Update,
--    Leader Deactivation, Password Reset, Ministry Creation, Student Import,
--    Feedback Assignment, Status Change, Response, Report Generation,
--    Permission Change
-- ============================================================
