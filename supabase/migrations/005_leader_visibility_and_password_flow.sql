-- ============================================================
-- RUCUSO — Migration 005: leader visibility + safe first-login password flow
-- Run AFTER 004.
-- ============================================================

-- ============================================================
-- 1. "Public Visibility" is its own field, separate from "Active Status"
--    (spec item 6: a leader account can be Active but hidden from the public
--    directory — e.g. between terms, or a leader who asked not to be listed).
-- ============================================================
alter table leaders add column if not exists public_visible boolean not null default true;

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
  where l.active = true and l.public_visible = true;

-- ============================================================
-- 2. REPLACE the broad "self update own row" policy from 004.
--    RLS can't restrict *which columns* an UPDATE touches, so a generic
--    self-update policy would let a leader rewrite their own role,
--    permissions, or ministry_id. Replace it with a narrow RPC instead:
--    the only thing a signed-in staff member can change about themselves
--    directly is clearing must_change_password, and only right after they've
--    actually changed their Supabase Auth password.
-- ============================================================
drop policy if exists "self update own row" on profiles;

create or replace function public.clear_must_change_password()
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  update profiles set must_change_password = false where id = auth.uid();
end;
$$;

grant execute on function public.clear_must_change_password() to authenticated;

-- Frontend flow on first login:
--   1. supabase.auth.signInWithPassword({ email, password: tempPassword })
--   2. read own profile row (allowed: "authorized read profiles" -> auth.uid() = id)
--   3. if must_change_password: force the change-password screen, nothing else
--   4. supabase.auth.updateUser({ password: newPassword })
--   5. on success: supabase.rpc('clear_must_change_password')
--   6. only then route to /leader/dashboard or /admin/dashboard
