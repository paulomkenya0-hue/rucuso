-- ============================================================
-- RUCUSO — Migration 012: stop the public from reading student identity
-- Run AFTER 011.
--
-- Context (found on the live site, security spec items 3.2 and 3.3):
--
--   1. lookup_student() is SECURITY DEFINER and was granted to anon, and it
--      returns full_name, programme, year_of_study and faculty. Anyone could
--      call it with a registration number and read back a student's identity —
--      no session, no rate limit, no ownership check. "Thibitisha
--      Utambulisho" then displayed that name, programme and year on screen
--      BEFORE any OTP was sent, so a script could walk a list of registration
--      numbers and harvest the registry, and could tell which numbers exist.
--
--   2. js/app.js also called lookupStudent() from the feedback form's
--      registration-number field to autofill the student's name. Same oracle,
--      reachable with no OTP at all.
--
-- Fix, in two parts:
--
--   A. The public loses this RPC entirely. lookup_student() stays in the
--      database but is now service_role only, so the browser cannot call it
--      under any circumstances, whatever the anon key can do.
--
--   B. A new Edge Function, lookup-student, answers the one question the form
--      actually needs — "is this registration number in the registry?" — and
--      answers it as a bare boolean, rate-limited per registration number and
--      per client IP. Identity is revealed later, and only by verify-otp, i.e.
--      only after the student has proved they hold the phone on file.
--
-- The rate-limit ledger below is keyed by HMAC, not by the raw value, and is
-- service_role only with no policy: it never becomes a copy of the registry or
-- a list of visitor addresses. It mirrors migration 008's HESLB limiter.
-- ============================================================

-- ---------- rate-limit ledger ----------

create table if not exists public.student_lookup_rate_limits (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempt_count smallint not null check (attempt_count > 0)
);

create index if not exists idx_student_lookup_rate_limits_window
  on public.student_lookup_rate_limits (window_started_at);

alter table public.student_lookup_rate_limits enable row level security;
revoke all on public.student_lookup_rate_limits from public, anon, authenticated;
grant all on public.student_lookup_rate_limits to service_role;

-- Returns false when the caller is over its limit, true when the attempt may
-- proceed. Two independent scopes are checked on every call, and the caller
-- must not reveal which one tripped.
create or replace function public.consume_student_lookup_attempt(
  p_scope text,
  p_key_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_count smallint;
  v_max   smallint;
begin
  if p_key_hash !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  -- A real student mistypes a number a handful of times; a harvest needs
  -- thousands. Per number stops one person grinding a whole faculty, per IP
  -- stops one script spraying many numbers.
  v_max := case p_scope
    when 'reg' then 20
    when 'ip'  then 60
    else null
  end;
  if v_max is null then
    return false;
  end if;

  insert into public.student_lookup_rate_limits (key_hash, window_started_at, attempt_count)
  values (p_key_hash, v_now, 1)
  on conflict (key_hash) do update set
    window_started_at = case
      when public.student_lookup_rate_limits.window_started_at < v_now - interval '10 minutes' then v_now
      else public.student_lookup_rate_limits.window_started_at
    end,
    attempt_count = case
      when public.student_lookup_rate_limits.window_started_at < v_now - interval '10 minutes' then 1
      else least(v_max + 1, public.student_lookup_rate_limits.attempt_count + 1)::smallint
    end
  returning attempt_count into v_count;

  delete from public.student_lookup_rate_limits
  where window_started_at < v_now - interval '1 day';

  return v_count <= v_max;
end;
$$;

revoke all on function public.consume_student_lookup_attempt(text, text) from public, anon, authenticated;
grant execute on function public.consume_student_lookup_attempt(text, text) to service_role;

-- ---------- take the registry away from the public ----------

-- Same definition, unchanged behaviour — it stays here because the
-- lookup-student Edge Function uses it through the service role, and because a
-- later admin-only tool may want it. Only the grants change.
revoke all on function public.lookup_student(text) from public, anon, authenticated;
grant execute on function public.lookup_student(text) to service_role;

-- Belt and braces: drop the overloaded form too if any earlier migration left
-- one behind, so nothing can slip past the revoke by calling a different
-- argument list.
do $$
declare
  v record;
begin
  for v in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'lookup_student'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v.signature);
  end loop;
end;
$$;

-- ---------- and the phone-on-file stopgap, now dead code ----------

-- verify_student_identity() (migration 006) is the stand-in that let a student
-- skip SMS entirely: reg number + the phone number on file, and it returns
-- full_name, programme, year, faculty and department. REQUIRE_SMS_OTP is true,
-- so nothing in the app calls it any more — but the anon grant is still live
-- and an RPC does not care that the UI stopped using it. It also has no rate
-- limit, so it could be ground against a list of registration numbers paired
-- with the phone numbers the OTP flow itself asks people to type in.
--
-- Revoked here for the same reason as lookup_student(): an unreachable grant on
-- a function that returns identity is still a way to get identity. The
-- definition is left in place so a deliberate rollback does not need to
-- recreate it — re-granting is one line, and the commit that does so should say
-- why.
revoke all on function public.verify_student_identity(text, text) from public, anon, authenticated;
grant execute on function public.verify_student_identity(text, text) to service_role;

-- If this is ever rolled back to the phone-on-file path, that path needs its
-- own rate limit before it is re-exposed; consume_student_lookup_attempt above
-- is the function to reuse.
