-- ============================================================
-- RUCUSO — Migration 015: executive RBAC + announcement validation
-- Run AFTER 014.
--
-- Two independent hardening steps, both additive:
--
--   1. Executive leadership access permissions.
--      The President, Vice President, Prime Minister, General Secretary
--      and Speaker (the posts with sees_all_ministries = true in
--      leadership_positions, migration 013) get:
--        * full read access to the student directory (students table)
--        * the ability to publish and broadcast system-wide announcements
--      The leadership directory was already public via the public_leaders
--      view, so no change is needed there.
--
--   2. Server-side validation for announcements.
--      Announcements were written by the browser through a direct
--      PostgREST insert/update. RLS decides *who* may write, not *what*,
--      so nothing stopped an over-long title, an expiry date before the
--      publish date, or a non-http image URL from reaching the table.
--      publish_announcement() is a SECURITY DEFINER RPC that validates
--      every field with native type checks before the row is written —
--      the same pattern submit_feedback() already uses for feedback.
-- ============================================================


-- ============================================================
-- 1. EXECUTIVE RBAC
-- ============================================================

-- ---- students: executives get full read access ----
-- The existing policy allowed only super_admin and admins holding the
-- manage_students flag. is_executive_leader() is table-driven (it reads
-- leadership_positions.sees_all_ministries), so it names exactly the five
-- posts the spec lists and cannot drift from the hierarchy.
drop policy if exists "authorized read students" on students;
create policy "authorized read students" on students for select
  using (is_super_admin() or has_permission('manage_students') or is_executive_leader());

-- ---- announcements: executives may publish and edit ----
-- Insert (publish) and update (edit a published announcement) are granted
-- to executive leaders. Delete is deliberately NOT granted: removing a
-- system-wide announcement stays with super_admin / manage_announcements.
drop policy if exists "executive publish announcements" on announcements;
create policy "executive publish announcements" on announcements for insert
  with check (is_executive_leader());

drop policy if exists "executive edit announcements" on announcements;
create policy "executive edit announcements" on announcements for update
  using (is_executive_leader())
  with check (is_executive_leader());


-- ============================================================
-- 2. PUBLISH_ANNOUNCEMENT() — validated write path
-- ============================================================
-- Validates every field before the row is written. Runs as the function
-- owner (security definer), so it bypasses RLS the same way
-- submit_feedback() does — the validation below is what makes that safe.
--
-- AUTHORIZATION: SECURITY DEFINER runs as the function owner, so the RLS
-- policies on announcements do NOT apply inside this function — without an
-- explicit check, any authenticated user could publish. The guard below is
-- the real boundary: only super admins, admins holding the
-- manage_announcements permission, and executive leaders may publish.
--
-- The author is taken from auth.uid(), never from the payload: a caller
-- cannot publish an announcement attributed to someone else.

create or replace function public.publish_announcement(
  p_title        text,
  p_description  text,
  p_category     text   default null,
  p_audience     text   default 'All Students',
  p_publish_date date   default current_date,
  p_expiry_date  date   default null,
  p_image_url    text   default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Authorization first: SECURITY DEFINER bypasses RLS, so this check —
  -- not the table policy — is what decides who may publish.
  if not (is_super_admin() or has_permission('manage_announcements') or is_executive_leader()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  -- title: required, trimmed, length-capped
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'TITLE_REQUIRED' using errcode = '22023';
  end if;
  if char_length(btrim(p_title)) > 200 then
    raise exception 'TITLE_TOO_LONG' using errcode = '22023';
  end if;

  -- description: required, trimmed, length-capped
  if coalesce(btrim(p_description), '') = '' then
    raise exception 'DESCRIPTION_REQUIRED' using errcode = '22023';
  end if;
  if char_length(btrim(p_description)) > 5000 then
    raise exception 'DESCRIPTION_TOO_LONG' using errcode = '22023';
  end if;

  -- expiry must not precede publish date
  if p_expiry_date is not null and p_expiry_date < p_publish_date then
    raise exception 'EXPIRY_BEFORE_PUBLISH' using errcode = '22023';
  end if;

  -- image URL, when present, must be an absolute http(s) URL
  if p_image_url is not null and btrim(p_image_url) !~ '^https?://' then
    raise exception 'INVALID_IMAGE_URL' using errcode = '22023';
  end if;

  insert into announcements (title, description, category, audience, publish_date, expiry_date, image_url, author)
  values (
    btrim(p_title),
    btrim(p_description),
    nullif(btrim(coalesce(p_category, '')), ''),
    coalesce(nullif(btrim(p_audience), ''), 'All Students'),
    coalesce(p_publish_date, current_date),
    p_expiry_date,
    nullif(btrim(coalesce(p_image_url, '')), ''),
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- Only signed-in users may call it; the NOT_AUTHORIZED guard inside the
-- function body decides what they may publish (SECURITY DEFINER bypasses RLS).
revoke all on function public.publish_announcement(text, text, text, text, date, date, text) from public, anon;
grant execute on function public.publish_announcement(text, text, text, text, date, date, text) to authenticated;


-- ============================================================
-- 3. UPDATE_ANNOUNCEMENT() — validated edit path
-- ============================================================
-- Same field checks as publish_announcement(), for the edit flow, plus a
-- check that the announcement exists. The author column is deliberately not
-- touched: an edit updates the content, not who published it, so a post
-- cannot be silently re-attributed to the person who edited it.
--
-- AUTHORIZATION: same reasoning as publish_announcement() — SECURITY DEFINER
-- bypasses RLS, so the guard below (not the table policy) is the boundary.

create or replace function public.update_announcement(
  p_id           uuid,
  p_title        text,
  p_description  text,
  p_category     text   default null,
  p_audience     text   default 'All Students',
  p_publish_date date   default null,
  p_expiry_date  date   default null,
  p_image_url    text   default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Authorization first: SECURITY DEFINER bypasses RLS, so this check —
  -- not the table policy — is what decides who may edit.
  if not (is_super_admin() or has_permission('manage_announcements') or is_executive_leader()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if p_id is null then
    raise exception 'ID_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from announcements a where a.id = p_id) then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;

  if coalesce(btrim(p_title), '') = '' then
    raise exception 'TITLE_REQUIRED' using errcode = '22023';
  end if;
  if char_length(btrim(p_title)) > 200 then
    raise exception 'TITLE_TOO_LONG' using errcode = '22023';
  end if;

  if coalesce(btrim(p_description), '') = '' then
    raise exception 'DESCRIPTION_REQUIRED' using errcode = '22023';
  end if;
  if char_length(btrim(p_description)) > 5000 then
    raise exception 'DESCRIPTION_TOO_LONG' using errcode = '22023';
  end if;

  -- publish_date may be null on edit (keep the stored one); expiry is only
  -- checked against the date that will actually be in effect.
  if p_expiry_date is not null then
    if p_expiry_date < coalesce(p_publish_date, (select publish_date from announcements where id = p_id)) then
      raise exception 'EXPIRY_BEFORE_PUBLISH' using errcode = '22023';
    end if;
  end if;

  if p_image_url is not null and btrim(p_image_url) !~ '^https?://' then
    raise exception 'INVALID_IMAGE_URL' using errcode = '22023';
  end if;

  update announcements
     set title = btrim(p_title),
         description = btrim(p_description),
         category = nullif(btrim(coalesce(p_category, '')), ''),
         audience = coalesce(nullif(btrim(p_audience), ''), 'All Students'),
         publish_date = coalesce(p_publish_date, publish_date),
         expiry_date = coalesce(p_expiry_date, expiry_date),
         image_url = case when p_image_url is null then image_url
                           else nullif(btrim(p_image_url), '') end
   where id = p_id
     returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.update_announcement(uuid, text, text, text, text, date, date, text) from public, anon;
grant execute on function public.update_announcement(uuid, text, text, text, text, date, date, text) to authenticated;
