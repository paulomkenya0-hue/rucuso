-- ============================================================
-- RUCUSO — Migration 006: reg-number + phone-on-file verification RPC
-- Run AFTER 005.
--
-- Context: SMS OTP delivery (send-otp / verify-otp Edge Functions) is not
-- yet wired to a working SMS provider, so students cannot complete the
-- OTP step at all right now. This RPC is a deliberately narrower stand-in
-- than "trust the registration number alone": it requires the student to
-- also enter the phone number already on file for that registration number
-- (entered by an admin during import/registration), which is not public
-- information the way a registration number often is. It never returns or
-- confirms the phone number itself, so it can't be used to enumerate phone
-- numbers either — a mismatch and a not-found registration number produce
-- the identical empty result.
--
-- IMPORTANT: this is a stopgap, not a replacement for OTP. Once SMS
-- delivery is working, re-enable REQUIRE_SMS_OTP in js/app.js and this
-- function becomes unused (safe to leave in place either way).
-- ============================================================

create or replace function public.verify_student_identity(p_reg text, p_phone text)
returns table (full_name text, programme text, year_of_study text, faculty text, department text)
language sql
stable
security definer
set search_path = public as $$
  select full_name, programme, year_of_study, faculty, department
  from students
  where lower(registration_number) = lower(btrim(p_reg))
    and phone_number is not null
    and right(regexp_replace(phone_number, '[^0-9]', '', 'g'), 9)
      = right(regexp_replace(btrim(p_phone), '[^0-9]', '', 'g'), 9)
    and coalesce(student_status, 'active') = 'active'
  limit 1;
$$;

grant execute on function public.verify_student_identity(text, text) to anon, authenticated;
