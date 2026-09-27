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
// Optional CAPTCHA (spec item 3.2). If TURNSTILE_SECRET_KEY is set, a
// captchaToken is required and is verified here against Cloudflare's siteverify
// endpoint. It is verified HERE, on the server, holding the secret. A token
// checked in the browser is a checkbox anyone can tick, so the client-side
// widget is never the thing that decides. If the key is absent the site keeps
// working on the rate limits alone, which is the honest default: the limits are
// the actual control, and the CAPTCHA only raises the cost of an automated run.
//
// REGISTRATION NUMBER FORMAT
//
//   current:  RU/<COURSE_CODE>/<YEAR>/<STUDENT_NUMBER>   e.g. RU/BAFIT/2024/007
//   legacy:   <PREFIX>/<YEAR>/<INDEX>                    e.g. RUCU/2024/01
//
// The two coexist during the migration window. A number in the legacy shape is
// matched too, but it comes back as found:false with reason:"legacy" rather than
// found:true — because accepting it would let an unmigrated student through a
// flow whose next step assumes the new format, and rejecting it silently would
// tell a real student their number does not exist. The distinction is the whole
// point: same status code, same shape of response, but the client can say
// something true instead of something false.
//
// A legacy match is a deliberate, temporary widening. Remove it in the same
// release that finishes the backfill, once students.course_code is populated —
// see supabase/migrations/014_course_codes.sql.
//
// Secrets required:
//   STUDENT_LOOKUP_RATE_LIMIT_SECRET   >= 32 random characters  (required)
//   TURNSTILE_SECRET_KEY               (optional, enables CAPTCHA)
//
//   supabase secrets set STUDENT_LOOKUP_RATE_LIMIT_SECRET=<openssl rand -base64 32>
//   supabase functions deploy lookup-student

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { json, preflight, readJson, getSupabase, registrationPattern } from "../_shared/otp.ts";

// The current format. The course-code segment is the reason the students table
// needed a course_code column in migration 014 — without one there is nothing to
// migrate old numbers from.
const CURRENT_RE = /^RU\/[A-Z]{2,6}\/\d{4}\/\d{3,4}$/i;

// The pre-2026 shape. Detected only so the student can be told their record
// needs migrating; never used to authorise the flow.
const LEGACY_RE = /^[A-Z]{2,6}\s*\/\s*\d{2,4}\s*\/\s*\d{1,6}$/i;

// Spaces around the slashes are tolerated on input and removed before matching,
// so a number pasted as "RU / BAFIT / 2024 / 007" behaves identically to a typed
// one. Upper-cased too, so it matches the canonical form that is stored.
function normalise(reg: string): string {
  return reg.toUpperCase().replace(/\s*([\/\-])\s*/g, "$1");
}

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

// Verifies a Turnstile token against Cloudflare. Returns a reason on failure so
// the server log says why, while the response to the caller stays identical —
// the same 403 either way, so this is not an oracle for whether a token merely
// expired versus was forged.
async function verifyTurnstile(token: string, remoteIp: string): Promise<{ ok: boolean; reason?: string }> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return { ok: true, reason: "not-configured" };

  // remoteip is how Cloudflare cross-checks the token against the address that
  // solved it. The hostname binding is not posted here: it is implied by the
  // secret, which is tied to one sitekey, and therefore to the hostnames that
  // widget is registered for. A token solved on an attacker's domain cannot
  // verify against this secret.
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp && remoteIp !== "unknown-client") form.append("remoteip", remoteIp);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    if (!res.ok) return { ok: false, reason: "siteverify-http-" + res.status };

    // Typed explicitly because res.json() is `unknown` in current Deno, and
    // reading .success off that would be a type error rather than a runtime one.
    const result = await res.json() as { success?: boolean; [k: string]: unknown };
    if (result?.success !== true) {
      // result["error-codes"] is deliberately not echoed to the client, and not
      // logged here either: it would say more about our configuration to anyone
      // reading the logs than it is worth.
      return { ok: false, reason: "siteverify-rejected" };
    }
    return { ok: true };
  } catch (_e) {
    // A network fault must not silently pass a forged token, and locking out
    // every real student is the lesser evil for an endpoint that gates identity.
    // Fail-closed: a Cloudflare outage blocks verification until it clears,
    // rather than opening the gate.
    return { ok: false, reason: "siteverify-unreachable" };
  }
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

  const remoteIp = clientAddress(req);

  // CAPTCHA gate, ahead of the rate limits on purpose. A solved widget costs
  // money and a network round-trip, so the cheaper counters should not be spent
  // on requests that are about to be rejected anyway.
  //
  // The ordering also means an unauthenticated flood never reaches Postgres at
  // all once a CAPTCHA is configured.
  if (Deno.env.get("TURNSTILE_SECRET_KEY")) {
    const token = typeof body.captchaToken === "string" ? body.captchaToken : "";
    if (!token) return json(req, { error: "CAPTCHA_REQUIRED" }, 403);
    const verdict = await verifyTurnstile(token, remoteIp);
    if (!verdict.ok) {
      // Logged server-side, never returned: the reason would tell an attacker
      // whether their forged token was rejected as forged or merely stale.
      console.warn("turnstile rejected:", verdict.reason);
      return json(req, { error: "CAPTCHA_FAILED" }, 403);
    }
  }

  const normalised = normalise(reg);

  // Anything that is neither format is not a registration number at all. It is
  // rejected before it can become a rate-limit key, so a fuzzer sending random
  // strings cannot consume another student's budget. The response is the same
  // { found: false } either way, so this leaks nothing about the registry.
  if (!CURRENT_RE.test(normalised) && !LEGACY_RE.test(normalised)) {
    return json(req, { found: false, reason: "malformed" });
  }

  const [regHash, ipHash] = await Promise.all([
    hmac("reg:" + normalised, secret),
    hmac("ip:" + remoteIp, secret),
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

  // Matched case-insensitively via registrationPattern(), which is also what
  // send-otp uses, so a lower-case registration number is found consistently at
  // both steps. The normalised form is sent, not reg, so a spaced or lower-case
  // entry hits the same row.
  //
  // Two columns are searched, OR'd, so which one matched is never revealed:
  //   registration_number        — the current format after the 014 backfill
  //   legacy_registration_number — the pre-2026 number, preserved on backfill
  //
  // Searching the legacy column is what keeps an unmigrated student from being
  // told their number does not exist. It only ever produces found:false with
  // reason:"legacy" (see below), so it discloses that a real student record is
  // pending migration and nothing more.
  //
  // student_status is matched with coalesce semantics, the same way
  // verify_student_identity does it: rows imported before the column existed
  // carry NULL, and a plain .eq() would silently drop every one of them.
  const legacyClause = `legacy_registration_number.ilike.${registrationPattern(normalised)}`;
  const { count, error: lookupError } = await supabase
    .from("students")
    .select("id", { count: "exact", head: true })
    .or(
      `registration_number.ilike.${registrationPattern(normalised)},${legacyClause}`,
    )
    .or("student_status.is.null,student_status.eq.active")
    .limit(1);

  if (lookupError) return json(req, { error: "LOOKUP_FAILED" }, 503);

  const found = (count ?? 0) > 0;

  // A legacy-shaped number that resolves to a row is reported as found:false
  // with reason:"legacy". Not found:false plain — the student's record does
  // exist, and telling them otherwise is simply untrue. Not found:true either,
  // because the rest of the flow assumes the current format and there is no
  // course code to build the next screen with.
  //
  // A response with found:false, reason:"legacy" still discloses that the
  // number belongs to a real, unmigrated student. That is an acceptable, bounded
  // disclosure — strictly less than identity, and rate limited identically. If
  // even that is too much for a deployment, set MIGRATION_LEGACY_LOOKUP=false and
  // every legacy number collapses to an ordinary not-found.
  if (found && LEGACY_RE.test(normalised)) {
    const allowLegacy = (Deno.env.get("MIGRATION_LEGACY_LOOKUP") || "true") !== "false";
    if (allowLegacy) return json(req, { found: false, reason: "legacy" });
  }

  return json(req, { found, ...(found ? {} : { reason: "not-found" }) });
});
