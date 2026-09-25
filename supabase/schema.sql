-- ============================================================
-- RUCUSO — Supabase schema (Phase 2 backend)
-- Run this once in your Supabase project's SQL Editor.
-- Safe to re-run pieces individually if something fails partway —
-- everything uses IF NOT EXISTS / OR REPLACE where possible.
-- ============================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ============================================================
-- 1. PROFILES (admin/leader accounts — one row per auth.users user)
-- ============================================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'officer'
    check (role in ('super_admin','president','secretary_general','minister','deputy_minister','representative','officer')),
  ministry_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. ACADEMIC / REFERENCE DATA
-- ============================================================
create table if not exists academic_years (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,           -- e.g. '2026/2027'
  is_current boolean not null default false
);

create table if not exists faculties (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  faculty_id uuid references faculties(id) on delete set null,
  name text not null
);

create table if not exists programmes (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references departments(id) on delete set null,
  name text not null
);

-- ============================================================
-- 3. STUDENT REGISTRY
-- ============================================================
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  registration_number text not null unique,
  first_name text not null,
  middle_name text,
  last_name text not null,
  full_name text generated always as (
    trim(both ' ' from coalesce(first_name,'') || ' ' || coalesce(middle_name,'') || ' ' || coalesce(last_name,''))
  ) stored,
  programme text,
  faculty text,
  department text,
  year_of_study text,
  academic_year text,
  phone_number text,
  email text,
  gender text,
  student_status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_students_reg on students (lower(registration_number));

-- ============================================================
-- 4. CATEGORIES / MINISTRIES / SERVICES
-- ============================================================
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true
);

create table if not exists ministries (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  active boolean not null default true
);

alter table profiles
  add constraint profiles_ministry_fk foreign key (ministry_id) references ministries(id) on delete set null;

create table if not exists student_services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  contact text,
  active boolean not null default false
);

-- ============================================================
-- 5. LEADERSHIP DIRECTORY
-- ============================================================
create table if not exists leaders (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  position text not null,
  ministry_id uuid references ministries(id) on delete set null,
  registration_number text,          -- private
  phone_public text,                 -- shown to students for direct contact
  phone_private text,
  email text,
  photo_url text,
  bio text,
  responsibilities text,
  programme text,
  year_of_study text,
  office_location text,
  start_date date,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 6. FEEDBACK / COMPLAINTS / SUGGESTIONS
-- ============================================================
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  reference_number text not null unique,
  submission_type text not null check (submission_type in ('General Feedback','Complaint','Challenge/Problem','Suggestion','Praise/Appreciation')),
  category_id uuid references categories(id),
  title text not null,
  description text not null,
  incident_date date,
  location text,
  suggested_solution text,
  satisfaction_rating int check (satisfaction_rating between 1 and 5),
  priority text not null default 'Medium' check (priority in ('Low','Medium','High','Critical')),
  is_anonymous boolean not null default false,
  student_id uuid references students(id),
  student_name_snapshot text,        -- only filled when NOT anonymous
  ministry_id uuid references ministries(id),
  status text not null default 'New'
    check (status in ('New','Under Review','Assigned','In Progress','Awaiting Information','Resolved','Closed','Rejected/Invalid')),
  assigned_to uuid references profiles(id),
  response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_feedback_ref on feedback (reference_number);
create index if not exists idx_feedback_status on feedback (status);

create table if not exists feedback_status_history (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid references feedback(id) on delete cascade,
  old_status text,
  new_status text not null,
  changed_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists internal_notes (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid references feedback(id) on delete cascade,
  admin_id uuid references profiles(id),
  note text not null,
  created_at timestamptz not null default now()
);

create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid references feedback(id) on delete cascade,
  file_url text not null,
  file_name text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 7. ANNOUNCEMENTS / DOCUMENTS
-- ============================================================
create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  image_url text,
  category text,
  publish_date date not null default current_date,
  expiry_date date,
  audience text default 'All Students',
  author uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text,
  file_url text not null,
  file_name text,
  uploaded_by uuid references profiles(id),
  uploaded_at timestamptz not null default now()
);

-- ============================================================
-- 8. OTP VERIFICATION (real SMS OTP goes through an Edge Function,
--    not directly from the browser — this table just stores state)
-- ============================================================
create table if not exists otp_verifications (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  student_id uuid references students(id),
  otp_hash text not null,          -- store a hash, never the plain OTP
  expires_at timestamptz not null,
  attempts int not null default 0,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 9. AUDIT LOG
-- ============================================================
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,                    -- profile id, or null for anonymous/system
  actor_label text,                 -- readable fallback (e.g. student reg number)
  action text not null,
  details text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10. SYSTEM SETTINGS
-- ============================================================
create table if not exists system_settings (
  key text primary key,
  value text
);
insert into system_settings (key, value) values ('academic_year','2026/2027')
  on conflict (key) do nothing;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table profiles enable row level security;
alter table students enable row level security;
alter table categories enable row level security;
alter table ministries enable row level security;
alter table student_services enable row level security;
alter table leaders enable row level security;
alter table feedback enable row level security;
alter table feedback_status_history enable row level security;
alter table internal_notes enable row level security;
alter table attachments enable row level security;
alter table announcements enable row level security;
alter table documents enable row level security;
alter table otp_verifications enable row level security;
alter table audit_logs enable row level security;
alter table system_settings enable row level security;

-- Helper: is the current request from a logged-in admin/leader profile?
create or replace function is_staff() returns boolean
language sql stable security definer as $$
  select exists (select 1 from profiles where id = auth.uid() and active = true);
$$;

-- ---- profiles ----
create policy "staff can read profiles" on profiles for select using (is_staff());
create policy "user can read own profile" on profiles for select using (auth.uid() = id);
-- Inserting/updating profiles (creating new admin accounts) is done via the
-- Supabase dashboard or a service-role Edge Function — not from the browser.

-- ---- reference data: public read of ACTIVE rows, staff full access ----
create policy "public read active categories" on categories for select using (active = true or is_staff());
create policy "staff write categories" on categories for all using (is_staff()) with check (is_staff());

create policy "public read active ministries" on ministries for select using (active = true or is_staff());
create policy "staff write ministries" on ministries for all using (is_staff()) with check (is_staff());

create policy "public read active services" on student_services for select using (active = true or is_staff());
create policy "staff write services" on student_services for all using (is_staff()) with check (is_staff());

create policy "public read active leaders" on leaders for select using (active = true or is_staff());
create policy "staff write leaders" on leaders for all using (is_staff()) with check (is_staff());

create policy "public read current announcements" on announcements for select
  using (publish_date <= current_date and (expiry_date is null or expiry_date >= current_date) or is_staff());
create policy "staff write announcements" on announcements for all using (is_staff()) with check (is_staff());

create policy "public read documents" on documents for select using (true);
create policy "staff write documents" on documents for all using (is_staff()) with check (is_staff());

-- ---- students: NO direct public select (privacy) — see lookup_student() RPC below ----
create policy "staff read students" on students for select using (is_staff());
create policy "staff write students" on students for all using (is_staff()) with check (is_staff());

-- ---- feedback: public can insert; cannot directly select (privacy) — see track_feedback() RPC ----
create policy "anyone can submit feedback" on feedback for insert with check (true);
create policy "staff read feedback" on feedback for select using (is_staff());
create policy "staff update feedback" on feedback for update using (is_staff()) with check (is_staff());

create policy "staff read status history" on feedback_status_history for select using (is_staff());
create policy "staff write status history" on feedback_status_history for insert with check (is_staff());

create policy "staff read internal notes" on internal_notes for select using (is_staff());
create policy "staff write internal notes" on internal_notes for insert with check (is_staff());

create policy "anyone can attach on insert" on attachments for insert with check (true);
create policy "staff read attachments" on attachments for select using (is_staff());

create policy "staff only otp" on otp_verifications for all using (is_staff()) with check (is_staff());
-- NOTE: real OTP send/verify should go through an Edge Function using the
-- service role key, not the browser's anon key — this table is written by
-- that function, which bypasses RLS via the service role.

create policy "staff read audit" on audit_logs for select using (is_staff());
create policy "staff write audit" on audit_logs for insert with check (is_staff());

create policy "staff manage settings" on system_settings for all using (is_staff()) with check (is_staff());
create policy "public read settings" on system_settings for select using (true);

-- ============================================================
-- SECURITY-DEFINER RPC FUNCTIONS
-- (limited, controlled access for anonymous students — avoids exposing
-- the full students/feedback tables via direct select policies)
-- ============================================================

-- Look up a student by registration number for the verification flow.
-- Returns only what the student-facing UI needs — never exposes the whole table.
create or replace function lookup_student(p_reg text)
returns table (full_name text, programme text, year_of_study text, faculty text)
language sql security definer as $$
  select full_name, programme, year_of_study, faculty
  from students
  where lower(registration_number) = lower(p_reg)
  limit 1;
$$;

-- Track a feedback submission by its reference number — returns only
-- the fields a student is allowed to see, never the internal notes or
-- (for anonymous submissions) any identity fields.
create or replace function track_feedback(p_ref text)
returns table (
  reference_number text, submission_type text, status text,
  response text, created_at timestamptz
)
language sql security definer as $$
  select reference_number, submission_type, status, response, created_at
  from feedback
  where reference_number = p_ref
  limit 1;
$$;

-- ============================================================
-- FIRST ADMIN ACCOUNT — do this manually, not in this script:
-- 1. Supabase Dashboard -> Authentication -> Users -> Add user
--    (set an email + a real password).
-- 2. Copy that user's UID, then run:
--
--    insert into profiles (id, full_name, role)
--    values ('PASTE-UID-HERE', 'Your Name', 'super_admin');
--
-- That account can then log in through supabase-client.js's
-- adminLogin() using the email/password you set in step 1.
-- ============================================================
