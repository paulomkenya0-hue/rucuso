-- ============================================================
-- RUCUSO — Migration 018: announcement management + Parliament (Wabunge)
-- Run AFTER 017. Additive and idempotent: no table is dropped, no row is
-- deleted or rewritten, and every existing announcement keeps showing exactly
-- as before (new columns default to "published, not featured").
--
--   1. announcements: status (draft/published), featured flag, image_path,
--      updated_at; public read policy now also requires status = 'published'.
--   2. save_announcement(): one validated create/update RPC that can also
--      CLEAR an expiry date or image (update_announcement() could not,
--      because it used coalesce()).
--   3. parliament_members table + public_parliament_members view.
--      Phone / email are only exposed publicly when contact_public = true.
--   4. Storage: announcement-images and parliament-photos buckets, with a
--      server-side MIME allow-list and size cap. The existing public buckets
--      (leader-photos, rucu-documents) get the same allow-list so an SVG or
--      HTML file can never be served from a public bucket on our origin.
-- ============================================================


-- ============================================================
-- 1. ANNOUNCEMENTS
-- ============================================================
alter table public.announcements add column if not exists status     text        not null default 'published';
alter table public.announcements add column if not exists featured   boolean     not null default false;
alter table public.announcements add column if not exists image_path text;
alter table public.announcements add column if not exists updated_at timestamptz not null default now();

alter table public.announcements drop constraint if exists announcements_status_chk;
alter table public.announcements
  add constraint announcements_status_chk check (status in ('draft', 'published'));

create index if not exists idx_announcements_public
  on public.announcements (status, publish_date desc);

-- Public sees only published + within its date window. Drafts (and everything
-- else) are visible to the people who may manage announcements.
drop policy if exists "public read current announcements" on public.announcements;
create policy "public read current announcements" on public.announcements for select
  using (
    (status = 'published'
      and publish_date <= current_date
      and (expiry_date is null or expiry_date >= current_date))
    or is_super_admin()
    or has_permission('manage_announcements')
    or is_executive_leader()
  );

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_announcements_touch on public.announcements;
create trigger trg_announcements_touch before update on public.announcements
  for each row execute function public.touch_updated_at();


-- ============================================================
-- 2. save_announcement() — validated create / update
-- ============================================================
-- p_id null  -> create (author = auth.uid(), never taken from the payload)
-- p_id given -> full replace of the editable fields. A null expiry or image
--               really clears it. The author is never changed by an edit.
-- SECURITY DEFINER bypasses RLS, so the guard at the top IS the boundary.
create or replace function public.save_announcement(
  p_id           uuid,
  p_title        text,
  p_description  text,
  p_category     text,
  p_audience     text,
  p_publish_date date,
  p_expiry_date  date,
  p_image_url    text,
  p_image_path   text,
  p_status       text,
  p_featured     boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_title   text := btrim(coalesce(p_title, ''));
  v_desc    text := btrim(coalesce(p_description, ''));
  v_publish date := coalesce(p_publish_date, current_date);
  v_status  text := coalesce(nullif(btrim(p_status), ''), 'published');
begin
  if not (is_super_admin() or has_permission('manage_announcements') or is_executive_leader()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if v_title = '' then raise exception 'TITLE_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_title) > 200 then raise exception 'TITLE_TOO_LONG' using errcode = '22023'; end if;
  if v_desc = '' then raise exception 'DESCRIPTION_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_desc) > 5000 then raise exception 'DESCRIPTION_TOO_LONG' using errcode = '22023'; end if;
  if char_length(coalesce(p_category, '')) > 100 then raise exception 'CATEGORY_TOO_LONG' using errcode = '22023'; end if;
  if char_length(coalesce(p_audience, '')) > 100 then raise exception 'AUDIENCE_TOO_LONG' using errcode = '22023'; end if;
  if v_status not in ('draft', 'published') then raise exception 'INVALID_STATUS' using errcode = '22023'; end if;
  if p_expiry_date is not null and p_expiry_date < v_publish then
    raise exception 'EXPIRY_BEFORE_PUBLISH' using errcode = '22023';
  end if;
  if p_image_url is not null and btrim(p_image_url) <> '' and btrim(p_image_url) !~ '^https://' then
    raise exception 'INVALID_IMAGE_URL' using errcode = '22023';
  end if;
  if p_image_path is not null and btrim(p_image_path) <> '' and btrim(p_image_path) !~ '^announcements/[A-Za-z0-9._-]{1,120}$' then
    raise exception 'INVALID_IMAGE_PATH' using errcode = '22023';
  end if;

  if p_id is null then
    insert into announcements
      (title, description, category, audience, publish_date, expiry_date,
       image_url, image_path, status, featured, author)
    values
      (v_title, v_desc,
       nullif(btrim(coalesce(p_category, '')), ''),
       coalesce(nullif(btrim(p_audience), ''), 'All Students'),
       v_publish, p_expiry_date,
       nullif(btrim(coalesce(p_image_url, '')), ''),
       nullif(btrim(coalesce(p_image_path, '')), ''),
       v_status, coalesce(p_featured, false), auth.uid())
    returning id into v_id;
  else
    update announcements
       set title        = v_title,
           description  = v_desc,
           category     = nullif(btrim(coalesce(p_category, '')), ''),
           audience     = coalesce(nullif(btrim(p_audience), ''), 'All Students'),
           publish_date = v_publish,
           expiry_date  = p_expiry_date,
           image_url    = nullif(btrim(coalesce(p_image_url, '')), ''),
           image_path   = nullif(btrim(coalesce(p_image_path, '')), ''),
           status       = v_status,
           featured     = coalesce(p_featured, false)
     where id = p_id
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_announcement(uuid, text, text, text, text, date, date, text, text, text, boolean) from public, anon;
grant execute on function public.save_announcement(uuid, text, text, text, text, date, date, text, text, text, boolean) to authenticated;


-- ============================================================
-- 3. PARLIAMENT (WABUNGE)
-- ============================================================
create table if not exists public.parliament_members (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null check (char_length(btrim(full_name)) between 2 and 120),
  photo_url      text check (photo_url is null or photo_url ~ '^https://'),
  photo_path     text,
  constituency   text check (constituency  is null or char_length(constituency)  <= 150),
  faculty        text check (faculty       is null or char_length(faculty)       <= 150),
  academic_year  text check (academic_year is null or char_length(academic_year) <= 40),
  position       text check (position      is null or char_length(position)      <= 100),
  biography      text check (biography     is null or char_length(biography)     <= 1500),
  phone          text check (phone         is null or char_length(phone)         <= 30),
  email          text check (email         is null or char_length(email)         <= 150),
  -- Contact details are PRIVATE unless a super admin deliberately flips this.
  contact_public boolean not null default false,
  active         boolean not null default true,
  display_order  integer not null default 100,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_parliament_active_order
  on public.parliament_members (active, display_order, full_name);

drop trigger if exists trg_parliament_touch on public.parliament_members;
create trigger trg_parliament_touch before update on public.parliament_members
  for each row execute function public.touch_updated_at();

alter table public.parliament_members enable row level security;

-- has_permission() is true for super_admin implicitly, and for an admin only
-- when the super admin granted manage_parliament. Leaders and the public get
-- no direct table access at all.
drop policy if exists "manage parliament members" on public.parliament_members;
create policy "manage parliament members" on public.parliament_members for all
  using (has_permission('manage_parliament'))
  with check (has_permission('manage_parliament'));

revoke all on public.parliament_members from anon;

-- The public page reads this view. Private contact details are NULL unless
-- contact_public is set; inactive members are not listed.
create or replace view public.public_parliament_members as
  select id,
         full_name,
         photo_url,
         constituency,
         faculty,
         academic_year,
         position,
         biography,
         case when contact_public then phone end as phone,
         case when contact_public then email end as email,
         display_order
  from public.parliament_members
  where active = true;

grant select on public.public_parliament_members to anon, authenticated;


-- ============================================================
-- 4. STORAGE
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('announcement-images', 'announcement-images', true, 3145728,
     array['image/jpeg', 'image/png', 'image/webp']),
  ('parliament-photos',   'parliament-photos',   true, 2097152,
     array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Existing public buckets: allow-list only, nothing renamed or moved.
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'leader-photos';

update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'text/plain', 'text/csv',
     'image/jpeg', 'image/png', 'image/webp']
 where id = 'rucu-documents';

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'manage announcement images') then
    create policy "manage announcement images" on storage.objects for all to authenticated
      using (bucket_id = 'announcement-images'
             and (public.is_super_admin() or public.has_permission('manage_announcements') or public.is_executive_leader()))
      with check (bucket_id = 'announcement-images'
             and (public.is_super_admin() or public.has_permission('manage_announcements') or public.is_executive_leader()));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'manage parliament photos') then
    create policy "manage parliament photos" on storage.objects for all to authenticated
      using (bucket_id = 'parliament-photos' and public.has_permission('manage_parliament'))
      with check (bucket_id = 'parliament-photos' and public.has_permission('manage_parliament'));
  end if;
end $$;


-- ============================================================
-- 5. DASHBOARD HELPERS (aggregate numbers only, no personal data)
-- ============================================================
create or replace function public.admin_content_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (is_super_admin() or has_permission('manage_announcements') or has_permission('manage_parliament')
          or has_permission('view_audit_logs')) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'announcements_live', (select count(*) from announcements
        where status = 'published' and publish_date <= current_date
          and (expiry_date is null or expiry_date >= current_date)),
    'announcements_scheduled', (select count(*) from announcements
        where status = 'published' and publish_date > current_date),
    'announcements_draft', (select count(*) from announcements where status = 'draft'),
    'parliament_active', (select count(*) from parliament_members where active),
    'parliament_total', (select count(*) from parliament_members),
    'documents', (select count(*) from documents),
    'admins', (select count(*) from profiles where role = 'admin' and active),
    'services', (select count(*) from student_services where active)
  );
end;
$$;

revoke all on function public.admin_content_counts() from public, anon;
grant execute on function public.admin_content_counts() to authenticated;
