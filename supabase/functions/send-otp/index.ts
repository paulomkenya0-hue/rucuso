// RUCUSO — send-otp
//
// Issues a 6-digit code for a student and sends it by SMS. The code itself
// never comes back in the response, and no SMS provider key is ever in the
// browser.
//
// WHAT CHANGED, AND WHY IT HAD TO
//
// This used to take { phone, reg }, look the student up, and answer with one of
// STUDENT_NOT_FOUND / INVALID_REGISTRATION / PHONE_MISMATCH / { ok: true }. Each
// of those is an existence oracle: a script could tell a real registration
// number from a fake one by the status code alone, without ever reading a name.
//
// Worse, it sent the SMS to the phone number THE BROWSER SUPPLIED. That is an
// oracle no response field can fix. An attacker submits a guessed registration
// number together with a phone they control, and learns the answer by watching
// whether an SMS arrives — the response is identical either way, and the signal
// is out of band. So the destination is no longer client-supplied: the code
// goes to the number already on file, which the caller cannot choose and does
// not get to see. An attacker guessing registration numbers receives nothing,
// because every SMS goes to the real student.
//
// The request is now { reg } and the response is the same { ok: true,
// expires_in } whether or not the number belongs to anyone. For a number that
// resolves to nobody, no code is generated, nothing is stored and no SMS is
// sent — and the caller cannot tell, which is the point. The student is left
// waiting for a code that will never arrive and gets exactly the same
// "invalid or expired code" as a wrong guess.
//
// Every other outcome that used to vary with existence has been folded into the
// same uniform response for the same reason: a per-phone send limit that only
// real students can trip, and an SMS provider that can only fail for a real
// student, were both 429s and 502s that a script could read. They are now logged
// and answered with the ordinary success shape.
//
// The deliberate cost: a student whose SMS genuinely failed to send is told the
// code is on its way and then cannot get in. That is the price of a response
// that carries no information. The alternative — reporting the failure — hands
// back the oracle, so the operator's copy of the log is the place that failure
// has to be visible, and OTP_LOG_CODE below is how a developer reproduces it.
//
// Secrets required (supabase secrets set ...):
//   SMS_PROVIDER   beem | africastalking
//   SMS_API_KEY    provider key
//   SMS_API_SECRET provider secret (Beem only)
//   SMS_SENDER_ID  sender id / shortcode
//   OTP_PEPPER     long random string, keeps hashes from being brute-forced
//   STUDENT_LOOKUP_RATE_LIMIT_SECRET  >= 32 chars, shared with lookup-student
//                                     so this endpoint cannot be called
//                                     directly to bypass that rate limit
// Required, in production only:
//   TURNSTILE_SECRET_KEY  the browser widget is checked in lookup-student; this
//                         function is only reachable from the form, which cannot
//                         be used at all without it
// Development only, never in production:
//   OTP_LOG_CODE=1  log the code to function logs so it can be read on a phone
//                  that cannot receive the real SMS

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  MAX_SENDS_PER_WINDOW, OTP_TTL_SECONDS, SEND_WINDOW_MINUTES,
  hashOtp, json, newOtp, preflight, readJson, getSupabase, getPepper,
  isRegistrationShaped, clientAddress, consumeRateLimit, resolveStudent,
} from "../_shared/otp.ts";

// The one response this function gives a registration number it is willing to
// work on. Same status, same keys, same values, whether a code was issued or
// not.
const ACCEPTED = { ok: true, expires_in: OTP_TTL_SECONDS } as const;

serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const body = await readJson(req);
  const reg = typeof body.reg === "string" ? body.reg.trim() : "";

  // A body that is not a registration number at all is answered the same way as
  // one that is. There is no phone field to validate any more, so nothing here
  // can depend on which student this might be.
  if (!isRegistrationShaped(reg)) return json(req, ACCEPTED);

  // Checked BEFORE the registry is touched, on purpose. If this ran after the
  // lookup it would fire only for registration numbers that resolve to a real
  // student, and a 503 is enough to enumerate with. Ahead of the lookup it
  // fires for every request, so it describes the deployment and not the
  // registry.
  const provider = (Deno.env.get("SMS_PROVIDER") ?? "").toLowerCase();
  if (provider !== "beem" && provider !== "africastalking") {
    return json(req, { error: "SMS_PROVIDER_NOT_CONFIGURED" }, 503);
  }

  const supabase = getSupabase();

  // Same secret and same two scopes as lookup-student. This matters for a
  // reason beyond politeness: lookup-student is the rate-limited front door, and
  // a send-otp with no limit of its own could be called directly, in a loop, to
  // spend SMS credit or to feel out numbers. The scopes are spent before
  // anything is looked up, so the 429 depends only on the caller's own history.
  const secret = Deno.env.get("STUDENT_LOOKUP_RATE_LIMIT_SECRET");
  if (!secret || secret.length < 32) return json(req, { error: "NOT_CONFIGURED" }, 503);

  const remoteIp = clientAddress(req);
  const allowed = await consumeRateLimit(supabase, secret, [
    { scope: "otp_reg", value: reg },
    { scope: "otp_ip", value: remoteIp },
  ]);
  if (!allowed) return json(req, { error: "TOO_MANY_REQUESTS" }, 429);

  // The only place the registry is consulted in this function. Everything after
  // this line is reachable for real students only, which is why none of it may
  // change the response.
  let student: { id: string; phone: string | null } | null = null;
  try {
    student = await resolveStudent(supabase, reg);
  } catch (e) {
    // Same reasoning as every other distinct failure here: a database fault is
    // not a statement about this number, but reporting it differently still
    // gives an attacker a way to separate "the query worked and found nobody"
    // from "the query failed", so it gets the uniform shape too.
    console.error("send-otp: registry query failed:", e);
    return json(req, ACCEPTED);
  }

  if (!student) {
    // No such student. Nothing is generated, nothing is stored, no SMS is sent,
    // and the response is byte-for-byte the one a real student would get. The
    // whole cost of this function being callable with any registration number
    // is one indexed SELECT.
    return json(req, ACCEPTED);
  }

  // A student with no usable number on file is in exactly the same position as
  // a number that resolves to nobody, and is answered identically. Logged,
  // because an import that leaves phone_number empty is an admin problem
  // someone needs to know about.
  if (!student.phone) {
    console.warn("send-otp: student row has no usable phone_number; code not sent");
    return json(req, ACCEPTED);
  }

  const phone = student.phone;

  // Per-phone limit. Only a real student reaches this, so returning 429 here
  // would say out loud that the number exists. It is enforced and then swallowed:
  // the limit still caps SMS spend, and the caller learns nothing beyond what it
  // would have learned from a success.
  const since = new Date(Date.now() - SEND_WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await supabase
    .from("otp_verifications")
    .select("id", { count: "exact", head: true })
    .eq("phone_number", phone)
    .gte("created_at", since);
  if ((count ?? 0) >= MAX_SENDS_PER_WINDOW) {
    console.warn("send-otp: per-phone send limit reached; code not sent");
    return json(req, ACCEPTED);
  }

  const otp = newOtp();
  const pepper = getPepper();

  // Drop stale pending codes for this number so only the newest one works.
  await supabase
    .from("otp_verifications")
    .delete()
    .eq("phone_number", phone)
    .eq("verified", false);

  const { error: insErr } = await supabase.from("otp_verifications").insert({
    phone_number: phone,
    student_id: student.id,
    otp_hash: await hashOtp(otp, pepper),
    expires_at: new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString(),
    attempts: 0,
    verified: false,
  });
  if (insErr) {
    console.error("send-otp: could not store the code hash:", insErr);
    return json(req, ACCEPTED);
  }

  // If the code never leaves this machine it must not stay in the table: it
  // would burn one of the per-phone slots and leave a code nobody has.
  const discard = () =>
    supabase.from("otp_verifications").delete().eq("phone_number", phone).eq("verified", false);

  if (Deno.env.get("OTP_LOG_CODE") === "1") {
    // Server-side log only. Useful while testing on a phone that cannot receive
    // the real SMS. Never enable this in production.
    console.log(`[send-otp] test code for ${phone}: ${otp}`);
  }

  const message = `RUCUSO: Namba yako ya uthibitisho ni ${otp}. Usimpe mtu mwingine. Haina muda wa dakika 5.`;

  let sent = false;
  try {
    if (provider === "beem") {
      const res = await fetch("https://api.beem.africa/v1/sms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SMS_API_KEY")}`,
        },
        body: JSON.stringify({
          to: [phone],
          from: Deno.env.get("SMS_SENDER_ID"),
          message,
        }),
      });
      sent = res.ok;
    } else {
      const res = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: "Basic " + btoa(
            `${Deno.env.get("SMS_API_KEY")}:${Deno.env.get("SMS_API_SECRET") ?? ""}`,
          ),
        },
        body: JSON.stringify({
          to: phone,
          from: Deno.env.get("SMS_SENDER_ID"),
          message,
        }),
      });
      sent = res.ok;
    }
  } catch (e) {
    console.error("[send-otp] provider call failed:", e);
  }

  if (!sent) {
    await discard();
    // Logged, not returned. A 502 here would only ever happen for a real
    // student, which makes it the same oracle as STUDENT_NOT_FOUND was.
    console.error("[send-otp] message was not delivered; reporting success to keep the response uniform");
  }

  return json(req, ACCEPTED);
});
