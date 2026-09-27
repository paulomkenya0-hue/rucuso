// RUCUSO — verify-otp
//
// Checks a 6-digit code against the stored hash. Runs entirely on the server:
// the browser never holds a hash, a pepper, or the SMS provider's credentials.
//
// The request carries { reg, code } rather than { phone, code }. The phone is
// resolved from the registry on the server, which is what lets this function
// work without the browser ever being told, or choosing, a phone number.
//
// WHAT CHANGED, AND WHY IT HAD TO
//
// This used to answer with one of NO_PENDING_CODE, CODE_EXPIRED,
// TOO_MANY_ATTEMPTS or WRONG_CODE, and to include attempts_left. Every one of
// those depended on a pending row existing, and a row only exists if send-otp
// found a student — so "NO_PENDING_CODE" was a way of asking "does this
// registration number exist?" through the OTP screen instead of the lookup one.
// attempts_left had the same problem, being present only when a row did.
//
// There is now exactly one failure, and every way of failing produces it:
// no pending code, expired code, exhausted attempts, wrong code. Same status,
// same body, same keys, and deliberately no attempts_left field to be absent in
// one case and present in another.
//
// Rules enforced here (not in the browser, so they cannot be bypassed):
//   * newest unverified code for that phone number only
//   * expired code rejected
//   * 5 wrong attempts per issued code, then the code is dead
//   * the code is single-use — it is marked verified (or deleted on failure)
//   * per-IP rate limit, so guessing is bounded even across issued codes
//
// Identity is disclosed here and only here, after the code has been proved.

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  MAX_ATTEMPTS, hashOtp, json, preflight, readJson,
  safeEquals, getSupabase, getPepper, clientAddress, consumeRateLimit, resolveStudent,
} from "../_shared/otp.ts";

// The one failure. Nothing about this object may vary with why it happened.
const REJECTED = { verified: false, error: "INVALID_CODE" } as const;

// A phone number that cannot exist: normalizePhone() only ever produces
// +255 followed by exactly nine digits, so this can never collide with a stored
// number. It is queried when the registration number resolves to no student, so
// that path runs the same SELECT a real attempt would and the two cannot be
// separated by how long the response took.
const ABSENT_PHONE = "+255000000000";

// A syntactically valid hash that no issued code will ever hash to, compared
// against when there is no row to compare against, so the constant-time
// comparison always does the same work.
const ABSENT_HASH = "0".repeat(64);

serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const body = await readJson(req);
  const reg = typeof body.reg === "string" ? body.reg.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";

  // About the code's own shape, not about the registry, so this says nothing
  // about whether the registration number exists.
  if (!/^\d{6}$/.test(code)) return json(req, { error: "INVALID_CODE_FORMAT" }, 400);
  if (!reg) return json(req, REJECTED);

  const supabase = getSupabase();

  // Per-IP, so an attacker cannot grind through issued codes by cycling through
  // phone numbers. Scoped on the client address rather than the registration
  // number: a 429 keyed on the number would be spent only for numbers that
  // resolve to a student, and would therefore confirm the ones that do.
  const secret = Deno.env.get("STUDENT_LOOKUP_RATE_LIMIT_SECRET");
  if (!secret || secret.length < 32) return json(req, { error: "NOT_CONFIGURED" }, 503);
  const allowed = await consumeRateLimit(supabase, secret, [
    { scope: "verify_ip", value: clientAddress(req) },
  ]);
  if (!allowed) return json(req, { error: "TOO_MANY_REQUESTS" }, 429);

  let student: { id: string; phone: string | null } | null = null;
  try {
    student = await resolveStudent(supabase, reg);
  } catch (e) {
    console.error("verify-otp: registry query failed:", e);
    return json(req, REJECTED);
  }

  // Unknown registration number, or a student with no usable phone on file. Both
  // fall through to the same comparisons below, against a phone and hash that
  // cannot match anything, and come out at the same REJECTED.
  const phone = student?.phone ?? ABSENT_PHONE;

  const { data: row, error } = await supabase
    .from("otp_verifications")
    .select("*")
    .eq("phone_number", phone)
    .eq("verified", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A database fault gets the same shape as a wrong code for the same reason
  // everything else here does: a distinct error would let a script separate "the
  // query failed" from "the query worked and found no code", and the second of
  // those is the answer to the question it is trying to ask.
  if (error) {
    console.error("verify-otp: pending-code query failed:", error);
    return json(req, REJECTED);
  }

  // Expired and exhausted codes are cleaned up exactly as before, so the
  // housekeeping is unchanged; only the reply is unified. Both leave `dead`, and
  // a dead row can never be verified even when the guess is correct — the row it
  // was matched against has just been deleted.
  let dead = false;
  if (row && new Date(row.expires_at).getTime() < Date.now()) {
    await supabase.from("otp_verifications").delete().eq("id", row.id);
    dead = true;
  } else if (row && (row.attempts ?? 0) >= MAX_ATTEMPTS) {
    await supabase.from("otp_verifications").delete().eq("id", row.id);
    dead = true;
  }

  const pepper = getPepper();
  const candidate = await hashOtp(code, pepper);

  // Every guess against a live code burns an attempt, right or wrong.
  if (row && !dead) {
    await supabase
      .from("otp_verifications")
      .update({ attempts: (row.attempts ?? 0) + 1 })
      .eq("id", row.id);
  }

  // The comparison runs whether or not there is a row: against the stored hash
  // if there is one, against a decoy if there is not, so the same work happens
  // in both cases and a rejection cannot be separated from a success by timing.
  const matches = safeEquals(candidate, row?.otp_hash ?? ABSENT_HASH);

  if (!row || dead || !matches) {
    // The fifth wrong guess kills the code, so the sixth is answered as "no
    // such code" — the same rejection as everything else.
    if (row && !dead && (row.attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
      await supabase.from("otp_verifications").delete().eq("id", row.id);
    }
    return json(req, REJECTED);
  }

  await supabase.from("otp_verifications").update({ verified: true }).eq("id", row.id);

  // Student identity, returned only now — after the code was proved. This is
  // the first and only point in the whole verification flow at which a name,
  // programme or year leaves the server. lookup_student() used to hand these out
  // to anyone with a registration number, before any OTP; that RPC is now
  // service_role only, and the browser reaches the registry only through
  // lookup-student (which returns nothing) and the two OTP functions.
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
    // The number the code was just delivered to. It is returned here and
    // nowhere earlier, and only to the caller who has proved they hold it, which
    // is the one moment at which telling someone their own phone number discloses
    // nothing. The client used to supply this value and so had no reason to be
    // told it; now that the server resolves it, this is how the session records
    // which number was verified.
    phone_number: phone,
  });
});
