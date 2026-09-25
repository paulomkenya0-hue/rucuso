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

  // Best-effort identity for the "you are verified as ..." banner. The front
  // end already has these values from lookup_student(), so this is a
  // convenience, not a trust boundary.
  let fullName: string | null = null;
  if (row.student_id) {
    const { data: st } = await supabase
      .from("students").select("full_name").eq("id", row.student_id).maybeSingle();
    fullName = st?.full_name ?? null;
  }

  return json(req, { verified: true, student_id: row.student_id, full_name: fullName });
});
