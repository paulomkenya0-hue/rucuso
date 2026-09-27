// RUCUSO — lookup-student
//
// Public, unauthenticated, and deliberately dumb. It answers exactly one
// question — "is this registration number in the registry?" — and answers it
// as a bare boolean.
//
// It does NOT return the student's name, programme, year or faculty. That is
// the fix for the harvesting hole found on the live site: lookup_student() used
// to be a SECURITY DEFINER RPC granted to anon that returned those fields, so
// anyone could read a student's identity out of it with nothing but a guess at
// their registration number, and the verification screen then showed the result
// on screen before any OTP was sent. Identity is now revealed by verify-otp,
// and only after the student proves they hold the phone number on file.
//
// Rate limiting (spec item 3.3), same shape as the HESLB check in
// verify-heslb: two independent scopes, both HMAC-keyed with a server-side
// secret so this table never holds a registration number or an IP address.
//   * per registration number — 20 per 10 minutes
//   * per client address     — 60 per 10 minutes
// Neither limit says which one tripped.
//
// Secrets required:
//   STUDENT_LOOKUP_RATE_LIMIT_SECRET   >= 32 random characters
//
//   supabase secrets set STUDENT_LOOKUP_RATE_LIMIT_SECRET=<openssl rand -base64 32>
//   supabase functions deploy lookup-student

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { json, preflight, readJson, getSupabase, registrationPattern } from "../_shared/otp.ts";

// Same client-address resolution as verify-heslb: Supabase sets at least one
// of these on every request. "unknown-client" is a real bucket, not a bypass —
// it just means everyone who hit this path shares one bucket.
function clientAddress(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip")
    || req.headers.get("x-forwarded-for")?.split(",").map((v) => v.trim()).filter(Boolean).at(-1)
    || "unknown-client"
  );
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const supabase = getSupabase();
  const secret = Deno.env.get("STUDENT_LOOKUP_RATE_LIMIT_SECRET");
  if (!secret || secret.length < 32) return json(req, { error: "NOT_CONFIGURED" }, 503);

  const body = await readJson(req);
  const reg = typeof body.reg === "string" ? body.reg.trim() : "";
  // Same length ceiling the RPC used. Anything longer is rejected before it
  // becomes a rate-limit key.
  if (!reg || reg.length > 80) return json(req, { found: false });

  const [regHash, ipHash] = await Promise.all([
    hmac("reg:" + reg.toLowerCase(), secret),
    hmac("ip:" + clientAddress(req), secret),
  ]);

  for (const [scope, keyHash] of [["reg", regHash], ["ip", ipHash]] as const) {
    const { data: allowed, error } = await supabase.rpc("consume_student_lookup_attempt", {
      p_scope: scope,
      p_key_hash: keyHash,
    });
    if (error || allowed !== true) {
      // 429 tells the caller to stop, without saying why. It returns no
      // identity and no hint about whether the number exists.
      return json(req, { error: "TOO_MANY_REQUESTS" }, 429);
    }
  }

  // service_role, so this reads the registry directly. Only the count crosses
  // back out — never a column.
  //
  // Matched case-insensitively via registrationPattern(), which is also what
  // send-otp uses, so a lower-case registration number is found consistently at
  // both steps.
  //
  // student_status is matched with coalesce semantics, the same way
  // verify_student_identity does it: rows imported before the column existed
  // carry NULL, and a plain .eq() would silently drop every one of them.
  const { count, error: lookupError } = await supabase
    .from("students")
    .select("id", { count: "exact", head: true })
    .ilike("registration_number", registrationPattern(reg))
    .or("student_status.is.null,student_status.eq.active")
    .limit(1);

  if (lookupError) return json(req, { error: "LOOKUP_FAILED" }, 503);

  return json(req, { found: (count ?? 0) > 0 });
});
