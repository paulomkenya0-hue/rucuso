// RUCUSO — send-bulk-sms
//
// Staff-triggered bulk SMS to HESLB loan beneficiaries. Whoever may manage the
// HESLB register may message it: a super admin, an admin granted
// manage_heslb_beneficiaries, or a leader whose active ministry is loans and
// empowerment (the Waziri/Naibu wa Mikopo). That is the set
// public.is_heslb_manager() describes in the database; requireHeslbManager()
// mirrors it here because this function runs with the service role and
// therefore bypasses RLS entirely.
//
// The browser picks the recipient list (it can already read and export the
// register), but this function does not trust it: every number must belong to a
// row in heslb_beneficiaries, so the endpoint cannot be turned into an open SMS
// gateway to arbitrary numbers.
//
// Batching is the caller's job. One call accepts at most MAX_RECIPIENTS_PER_CALL
// numbers so the request finishes well inside the function timeout; the composer
// page walks the list in batches and shows progress. Every batch is written to
// audit_logs with counts only — never phone numbers and never the message body.
//
// Secrets required (supabase secrets set ...):
//   SMS_PROVIDER   beem | africastalking
//   SMS_API_KEY    provider key
//   SMS_API_SECRET provider secret (Beem only)
//   SMS_SENDER_ID  sender id / shortcode

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { getSupabase, json, normalizePhone, preflight, readJson } from "../_shared/otp.ts";
import { isResponse, logAudit, requireHeslbManager } from "../_shared/admin.ts";
import { MAX_BULK_MESSAGE_CHARS, sendSms, smsProvider } from "../_shared/sms.ts";

const MAX_RECIPIENTS_PER_CALL = 100;
const SEND_CONCURRENCY = 10;

serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  let supabase: any;
  try {
    supabase = getSupabase();
  } catch (e) {
    console.error("[send-bulk-sms] missing Supabase configuration:", e);
    return json(req, { error: "INTERNAL_ERROR" }, 500);
  }

  const auth = await requireHeslbManager(req, supabase);
  if (isResponse(auth)) return auth;

  if (!smsProvider()) {
    return json(req, { error: "SMS_PROVIDER_NOT_CONFIGURED" }, 503);
  }

  const body = await readJson(req);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_BULK_MESSAGE_CHARS || /[\u0000-\u001f\u007f]/.test(message)) {
    return json(req, { error: "INVALID_MESSAGE" }, 400);
  }
  const messageLength = message.length;

  const raw = Array.isArray(body.phones) ? body.phones : [];
  if (raw.length === 0 || raw.length > MAX_RECIPIENTS_PER_CALL) {
    return json(req, { error: "INVALID_RECIPIENTS" }, 400);
  }
  const phones = [...new Set(raw.map(normalizePhone).filter((p): p is string => p !== null))];
  if (phones.length === 0) {
    return json(req, { error: "INVALID_RECIPIENTS" }, 400);
  }

  // Only numbers already on the register are spendable. A number that no row
  // holds is counted as skipped rather than sent.
  const { data: known, error: lookupError } = await supabase
    .from("heslb_beneficiaries")
    .select("phone")
    .in("phone", phones);
  if (lookupError) {
    console.error("[send-bulk-sms] beneficiary lookup failed:", lookupError);
    return json(req, { error: "INTERNAL_ERROR" }, 500);
  }
  const allowed = new Set((known || []).map((row: { phone: string }) => row.phone));
  const targets = phones.filter((p) => allowed.has(p));
  const skipped = phones.length - targets.length;

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += SEND_CONCURRENCY) {
    const slice = targets.slice(i, i + SEND_CONCURRENCY);
    const results = await Promise.all(slice.map((phone) => sendSms(phone, message)));
    for (const delivered of results) delivered ? sent++ : failed++;
  }

  // Counts only. The message may name amounts or deadlines and a phone number
  // is personal data; neither belongs in an audit row.
  await logAudit(
    supabase,
    auth.id,
    auth.full_name,
    "HESLB Bulk SMS Sent",
    `recipients=${targets.length}; sent=${sent}; failed=${failed}; skipped=${skipped}; chars=${messageLength}`,
  );

  return json(req, { requested: phones.length, sent, failed, skipped });
});
