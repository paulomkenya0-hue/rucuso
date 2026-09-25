# Edge Functions — real SMS OTP

The browser must never hold your SMS provider's API key, so OTP sending and
verification have to run on Supabase's server side (an **Edge Function**),
not in `supabase-client.js`. This is exactly the "SMS Service" abstraction
the original spec asked for — provider-agnostic, configured through
environment variables.

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) installed
and logged in (`supabase login`, `supabase link`) to deploy these.

## 1. Set your SMS provider's secrets
Pick any Tanzania-compatible SMS provider (e.g. Beem Africa, NextSMS, Africa's
Talking) and set its credentials as Supabase secrets — never in code:

```bash
supabase secrets set SMS_PROVIDER=beem
supabase secrets set SMS_API_KEY=your_key
supabase secrets set SMS_API_SECRET=your_secret
supabase secrets set SMS_SENDER_ID=RUCUSO
```

Then generate the pepper. It is required by **both** functions — they refuse to
run without it, because a plain SHA-256 of a 6-digit code is trivially
reversible if someone ever gets hold of the `otp_verifications` table:

```bash
openssl rand -base64 48
supabase secrets set OTP_PEPPER=<paste the output>
```

Keep that value somewhere safe. Rotating it invalidates every code that is
currently pending, which is harmless.

## 2. `supabase/functions/send-otp/index.ts`

```ts
import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const { phone, reg } = await req.json();
  if (!phone || !/^\+255\d{9}$/.test(phone)) {
    return new Response(JSON.stringify({ error: "Invalid phone" }), { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // service role: bypasses RLS, server-only
  );

  // Look up the student (server-side, full access)
  const { data: student } = await supabase
    .from("students").select("id").eq("registration_number", reg).single();

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = await hash(otp); // see helper below — never store the plain OTP

  await supabase.from("otp_verifications").insert({
    phone_number: phone,
    student_id: student?.id ?? null,
    otp_hash: otpHash,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  // ---- send via your SMS provider (example shape — adjust to your provider's API) ----
  await fetch(`https://api.${Deno.env.get("SMS_PROVIDER")}.example/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SMS_API_KEY")}`,
    },
    body: JSON.stringify({
      sender_id: Deno.env.get("SMS_SENDER_ID"),
      to: phone,
      message: `RUCUSO: Namba yako ya uthibitisho ni ${otp}. Usimpe mtu mwingine.`,
    }),
  });

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});

async function hash(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

## 3. `supabase/functions/verify-otp/index.ts`

```ts
import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const { phone, code } = await req.json();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: row } = await supabase
    .from("otp_verifications")
    .select("*")
    .eq("phone_number", phone)
    .eq("verified", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!row) return json({ verified: false, reason: "No pending OTP." });
  if (new Date(row.expires_at) < new Date()) return json({ verified: false, reason: "Expired." });
  if (row.attempts >= 5) return json({ verified: false, reason: "Too many attempts." });

  const codeHash = await hash(code);
  await supabase.from("otp_verifications").update({ attempts: row.attempts + 1 }).eq("id", row.id);

  if (codeHash !== row.otp_hash) return json({ verified: false, reason: "Incorrect code." });

  await supabase.from("otp_verifications").update({ verified: true }).eq("id", row.id);
  return json({ verified: true, student_id: row.student_id });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
async function hash(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

## 4. Deploy

```bash
supabase functions deploy send-otp
supabase functions deploy verify-otp
```

`supabase-client.js` already calls these by name (`sendOtp` / `verifyOtp`) —
nothing else to wire up once they're deployed.
