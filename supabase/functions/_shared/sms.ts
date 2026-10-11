// Shared SMS delivery for RUCUSO Edge Functions.
//
// The OTP flow (send-otp) deliberately keeps its own copy of this provider
// block: tests/otp-oracle.test.js rewrites that function's imports before it
// runs, so pulling the provider call into a shared module would change how the
// test loads send-otp. This file is the reusable version for admin-triggered
// messages and is used only by send-bulk-sms.
//
// It holds the provider call and nothing else: no OTP, no registry lookup, no
// rate limiting. Credentials come from Supabase secrets at runtime and never
// reach the browser.

export const SMS_SEGMENT_CHARS = 160;

// A bulk message is capped at three segments. Beyond that the composer is not a
// notification any more, it is an unmoderated broadcast, and each extra segment
// multiplies the cost of every batch.
export const MAX_BULK_MESSAGE_CHARS = SMS_SEGMENT_CHARS * 3;

export type SmsProvider = "beem" | "africastalking";

export function smsProvider(): SmsProvider | null {
  const provider = (Deno.env.get("SMS_PROVIDER") ?? "").toLowerCase();
  return provider === "beem" || provider === "africastalking" ? provider : null;
}

export function smsSegments(message: string): number {
  return Math.max(1, Math.ceil(message.length / SMS_SEGMENT_CHARS));
}

// Sends one SMS and reports whether the provider accepted it. Never throws: a
// transport failure is logged and returned as false, because the caller counts
// successes and failures rather than aborting a batch halfway through.
export async function sendSms(phone: string, message: string): Promise<boolean> {
  const provider = smsProvider();
  if (!provider) return false;
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
      return res.ok;
    }
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
    return res.ok;
  } catch (e) {
    console.error("[sms] provider call failed:", e);
    return false;
  }
}
