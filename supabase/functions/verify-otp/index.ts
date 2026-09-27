// RUCUSO — verify-otp
//
// Checks a 6-digit code against the stored hash. Runs entirely on the server:
// the browser never holds a hash, a pepper, or the SMS provider's credentials.
//
// Rules enforced here (not in the browser, so they cannot be bypassed):
//   * newest unverified code for that phone number only
//   * expired code rejected
//   * 5 wrong attempts per issued code, then the code is dead
//   * the code is single-use — it is marked verified (or deleted on failure)

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  MAX_ATTEMPTS, hashOtp, json, normalizePhone, preflight, readJson,
  safeEquals, getSupabase, getPepper,
} from "../_shared/otp.ts";

serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const body = await readJson(req);
  const phone = normalizePhone(body.phone);
  const code = typeof body.code === "string" ? body.code.trim() : "";

  if (!phone) return json(req, { error: "INVALID_PHONE" }, 400);
  if (!/^\d{6}$/.test(code)) return json(req, { error: "INVALID_CODE_FORMAT" }, 400);

  const supabase = getSupabase();

  const { data: row, error } = await supabase
    .from("otp_verifications")
    .select("*")
    .eq("phone_number", phone)
    .eq("verified", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return json(req, { error: "VERIFY_FAILED" }, 500);
  if (!row) return json(req, { verified: false, error: "NO_PENDING_CODE" }, 400);

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await supabase.from("otp_verifications").delete().eq("id", row.id);
    return json(req, { verified: false, error: "CODE_EXPIRED" }, 400);
  }

  if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
    await supabase.from("otp_verifications").delete().eq("id", row.id);
    return json(req, { verified: false, error: "TOO_MANY_ATTEMPTS" }, 429);
  }

  const pepper = getPepper();
  const candidate = await hashOtp(code, pepper);

  // Every guess burns an attempt, right or wrong.
  await supabase
    .from("otp_verifications")
    .update({ attempts: (row.attempts ?? 0) + 1 })
    .eq("id", row.id);

  if (!safeEquals(candidate, row.otp_hash)) {
    const left = MAX_ATTEMPTS - ((row.attempts ?? 0) + 1);
    if (left <= 0) await supabase.from("otp_verifications").delete().eq("id", row.id);
    return json(req, { verified: false, error: "WRONG_CODE", attempts_left: Math.max(0, left) }, 400);
  }

  await supabase.from("otp_verifications").update({ verified: true }).eq("id", row.id);

  // Student identity, returned only now — after the code was proved. This is
  // the first and only point in the whole verification flow at which a name,
  // programme or year leaves the server. (lookup_student() used to hand these
  // out to anyone with a registration number, before any OTP; that RPC is now
  // service_role only and the browser reaches the registry only through
  // lookup-student, which returns a bare boolean.)
  let fullName: string | null = null;
  let programme: string | null = null;
  let yearOfStudy: string | null = null;
  let faculty: string | null = null;
  if (row.student_id) {
    const { data: st } = await supabase
      .from("students")
      .select("full_name, programme, year_of_study, faculty")
      .eq("id", row.student_id)
      .maybeSingle();
    fullName = st?.full_name ?? null;
    programme = st?.programme ?? null;
    yearOfStudy = st?.year_of_study ?? null;
    faculty = st?.faculty ?? null;
  }

  return json(req, {
    verified: true,
    student_id: row.student_id,
    full_name: fullName,
    programme,
    year_of_study: yearOfStudy,
    faculty,
  });
});
