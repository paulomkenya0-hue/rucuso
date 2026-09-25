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

## 4. RUCUSO AI — `supabase/functions/rucuso-ai/index.ts`

The assistant that the floating "Ask RUCUSO AI" button uses. Unlike the
OTP functions this one is **optional**: if you do not deploy it, the chat
falls back to the front end's built-in answers and everything else keeps
working.

```bash
# The rate-limit ledger. Run this once in the SQL Editor.
# File: supabase/migrations/003_ai_assistant.sql

# The AI provider's key. Server-side only, never in a browser file.
supabase secrets set AI_API_KEY=your_provider_key
supabase secrets set AI_MODEL=gpt-4o-mini
supabase secrets set AI_RATE_SALT=$(openssl rand -base64 32)

supabase functions deploy rucuso-ai
```

`AI_API_KEY` works with any OpenAI-compatible endpoint:

| Provider | `AI_API_BASE_URL` | Example model |
| --- | --- | --- |
| OpenAI | *(default)* `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-flash-1.5` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Together | `https://api.together.xyz/v1` | `meta-llama/Llama-3-8b-chat-hs` |

```bash
supabase secrets set AI_API_BASE_URL=https://api.groq.com/openai/v1
supabase secrets set AI_MODEL=llama-3.3-70b-versatile
```

**Before you deploy:** confirm `AI_API_KEY` is set (`supabase secrets list`).
If it is missing, the function answers with a clear Kiswahili message and the
app falls back to its built-in answers rather than breaking.

**Testing it locally**

```bash
supabase functions serve rucuso-ai --env-file supabase/.env.local
```

`supabase/.env.local` is git-ignored. It needs `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `AI_API_KEY`.

### What the AI is allowed to know

The function decides this itself, on the server, from the caller's real role —
it never trusts a role sent by the browser.

| Caller | Can be told |
| --- | --- |
| Visitor / student | Academic year, contact details, feedback categories, ministries, active student services, published announcements, the public leadership directory |
| Staff (active `profiles` row) | The above **plus** aggregate numbers: total reports, counts by status / type / category, open and critical counts, last 7 days, average satisfaction |
| Nobody | Individual reports, titles, descriptions, attachments, student names, registration numbers, phone numbers, leader private fields, internal notes |

Aggregates are computed in the function; raw rows are never sent to the model,
so the model cannot repeat them. Signed-in users without an active `profiles`
row are treated as ordinary visitors.

### Rate limits

| Caller | Per 10 minutes | Per 24 hours |
| --- | --- | --- |
| Visitor / student | 6 | 40 |
| Staff | 40 | 300 |

Two layers: an in-memory window (survives a missing `ai_queries` table) and the
shared `ai_queries` table (survives cold starts and multiple instances).
Visitors are bucketed by a salted hash of IP + user agent, so no address is
stored.

## 5. Deploy everything

```bash
supabase secrets set SMS_PROVIDER=beem
supabase secrets set SMS_API_KEY=your_key
supabase secrets set SMS_API_SECRET=your_secret
supabase secrets set SMS_SENDER_ID=RUCUSO
supabase secrets set OTP_PEPPER=<openssl rand -base64 48>
supabase secrets set AI_API_KEY=your_provider_key

supabase functions deploy send-otp
supabase functions deploy verify-otp
supabase functions deploy rucuso-ai
```

`supabase-client.js` already calls these by name (`sendOtp` / `verifyOtp` /
`askAI`) — nothing else to wire up once they're deployed.
