// RUCUSO — send-otp
//
// Issues a 6-digit code for a verified student and sends it by SMS.
// Called only by the browser's RucusoAPI.sendOtp(); the code itself never
// comes back in the response, and no SMS provider key is ever in the browser.
//
// Secrets required (supabase secrets set ...):
//   SMS_PROVIDER   beem | africastalking
//   SMS_API_KEY    provider key
//   SMS_API_SECRET provider secret (Beem only)
//   SMS_SENDER_ID  sender id / shortcode
//   OTP_PEPPER     long random string, keeps hashes from being brute-forced
// Optional:
//   OTP_STRICT_PHONE=1  refuse to send unless the phone matches the registry
//   OTP_LOG_CODE=1      log the code to function logs (LOCAL TESTING ONLY)

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  MAX_SENDS_PER_WINDOW, OTP_TTL_SECONDS, SEND_WINDOW_MINUTES,
  hashOtp, json, newOtp, normalizePhone, preflight, readJson, getSupabase, getPepper,
} from "../_shared/otp.ts";

serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const body = await readJson(req);
  const phone = normalizePhone(body.phone);
  const reg = typeof body.reg === "string" ? body.reg.trim() : "";

  if (!phone) return json(req, { error: "INVALID_PHONE" }, 400);
  if (!reg) return json(req, { error: "INVALID_REGISTRATION" }, 400);

  const supabase = getSupabase();

  // The registration number must already be in the registry — the front end
  // verified it with lookup_student() before this function is called.
  const { data: student, error: sErr } = await supabase
    .from("students")
    .select("id, full_name, phone_number")
    .eq("registration_number", reg)
    .limit(1)
    .maybeSingle();
  if (sErr) return json(req, { error: "LOOKUP_FAILED" }, 500);
  if (!student) return json(req, { error: "STUDENT_NOT_FOUND" }, 404);

  const stored = normalizePhone(student.phone_number);
  if (Deno.env.get("OTP_STRICT_PHONE") === "1" && stored && stored !== phone) {
    return json(req, { error: "PHONE_MISMATCH" }, 403);
  }

  // Rate limit per phone number.
  const since = new Date(Date.now() - SEND_WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await supabase
    .from("otp_verifications")
    .select("id", { count: "exact", head: true })
    .eq("phone_number", phone)
    .gte("created_at", since);
  if ((count ?? 0) >= MAX_SENDS_PER_WINDOW) {
    return json(req, { error: "TOO_MANY_REQUESTS" }, 429);
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
  if (insErr) return json(req, { error: "COULD_NOT_ISSUE" }, 500);

  // If the code never leaves this machine it must not stay in the table: it
  // would burn one of the 5 rate-limit slots and leave a code nobody has.
  const discard = () =>
    supabase.from("otp_verifications").delete().eq("phone_number", phone).eq("verified", false);

  if (Deno.env.get("OTP_LOG_CODE") === "1") {
    // Server-side log only. Useful while testing on a phone that cannot
    // receive the real SMS. Never enable this in production.
    console.log(`[send-otp] test code for ${phone}: ${otp}`);
  }

  const provider = (Deno.env.get("SMS_PROVIDER") ?? "").toLowerCase();
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
    } else if (provider === "africastalking") {
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
    } else {
      // No provider configured: say so plainly instead of pretending the SMS
      // went out.
      await discard();
      return json(req, { error: "SMS_PROVIDER_NOT_CONFIGURED" }, 503);
    }
  } catch (e) {
    console.error("[send-otp] provider call failed:", e);
    await discard();
    return json(req, { error: "SMS_SEND_FAILED" }, 502);
  }

  if (!sent) {
    await discard();
    return json(req, { error: "SMS_SEND_FAILED" }, 502);
  }

  return json(req, { ok: true, expires_in: OTP_TTL_SECONDS });
});
