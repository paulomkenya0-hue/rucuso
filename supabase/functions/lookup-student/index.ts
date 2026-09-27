// RUCUSO — lookup-student
//
// Public, unauthenticated, and deliberately dumb. It used to answer exactly one
// question — "is this registration number in the registry?" — as a bare
// boolean.
//
// IT NO LONGER ANSWERS THAT QUESTION. It returns { ok: true } for every
// registration number, and that is the entire point: a boolean here, however
// bare, is an existence oracle. `found: true` versus `found: false` is one bit
// per guess, and 20 guesses per number per 10 minutes is a slow but perfectly
// reliable way to build a list of who studies at RUCUSO. Removing the name,
// programme and year fixed the *content* of the leak and left the leak itself
// intact, because the transition from step 1 to the OTP screen is itself the
// signal. The browser cannot be made to ignore a field it can read, so the
// field is not sent.
//
// What this function still does, and why it is not simply deleted:
//
//   * it is the CAPTCHA gate. A solved widget is verified HERE, on the server,
//     holding the secret, before any rate-limit budget is spent. A token
//     checked in the browser is a checkbox anyone can tick.
//   * it is the cheap rate limiter. Two independent scopes, both HMAC-keyed with
//     a server-side secret so the table never holds a registration number or an
//     IP address. Neither limit says which one tripped, and both are spent
//     before the registry is touched, so a flood never reaches Postgres at all
//     once a CAPTCHA is configured.
//   * it is where the migration queue is watched. A legacy-shaped number that
//     still resolves to a row is logged here, where the operator can see it,
//     instead of being returned as a field a script can read.
//
// The registry query is still performed even though its result is not returned,
// so that a found and a not-found request cost the same and cannot be told
// apart by how quickly the response came back.
//
// REGISTRATION NUMBER FORMAT
//
//   current:  RU/<COURSE_CODE>/<YEAR>/<STUDENT_NUMBER>   e.g. RU/BAFIT/2024/007
//   legacy:   <PREFIX>/<YEAR>/<INDEX>                    e.g. RUCU/2024/01
//
// Nothing in the response says which shape was sent or whether it exists, so
// the two formats are indistinguishable from outside — as they must be.
//
// Secrets required:
//   STUDENT_LOOKUP_RATE_LIMIT_SECRET   >= 32 random characters  (required)
//   TURNSTILE_SECRET_KEY               (required in production)
//
//   supabase secrets set STUDENT_LOOKUP_RATE_LIMIT_SECRET=<openssl rand -base64 32>
//   supabase functions deploy lookup-student

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import {
  clientAddress, consumeRateLimit, countStudentsMatching, isRegistrationShaped,
  json, preflight, readJson, getSupabase,
} from "../_shared/otp.ts";

// Every registration number gets this. Kept as one named constant so the
// uniformity is a single thing you can read and a single thing to break.
const ACCEPTED = { ok: true } as const;

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
  // becomes a rate-limit key. The response is the same as any other accepted
  // number, so this is not distinguishable from "a number nobody holds".
  if (!reg || reg.length > 80) return json(req, ACCEPTED);

  const remoteIp = clientAddress(req);

  // CAPTCHA gate, ahead of the rate limits on purpose. A solved widget costs
  // money and a network round-trip, so the cheaper counters should not be spent
  // on requests that are about to be rejected anyway.
  //
  // The ordering also means an unauthenticated flood never reaches Postgres at
  // all once a CAPTCHA is configured.
  //
  // Fail-closed, and the reasoning is worth stating because the earlier version
  // got it wrong. That version treated an absent TURNSTILE_SECRET_KEY as "no
  // CAPTCHA configured, carry on", which fails open in the one deployment that
  // matters: a site key set in config.js with the server secret forgotten. The
  // widget renders, the student solves it honestly, the token arrives — and the
  // server discards it without checking, so the CAPTCHA is decorative and any
  // script can skip it entirely. A blank site key is safe because the client
  // locks the form; a blank *secret* is not safe, because the client cannot see
  // it and will happily let a token through.
  //
  // So the secret is required. Running without one is now an explicit, loudly
  // named opt-in for local work, and it logs on every request so it cannot
  // quietly reach production.
  const captchaSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
  const devSkip = Deno.env.get("LOCAL_DEV_SKIP_CAPTCHA") === "1";
  if (!captchaSecret) {
    if (devSkip) {
      console.warn(
        "lookup: LOCAL_DEV_SKIP_CAPTCHA=1 — CAPTCHA is NOT being verified. " +
        "Never set this on a deployed function.");
    } else {
      return json(req, { error: "NOT_CONFIGURED" }, 503);
    }
  } else {
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

  // Anything that is neither format is not a registration number at all. It is
  // rejected before it can become a rate-limit key, so a fuzzer sending random
  // strings cannot consume another student's budget. The response is the same
  // { ok: true } as a real registration number, so this leaks nothing about the
  // registry.
  if (!isRegistrationShaped(reg)) return json(req, ACCEPTED);

  // Both scopes are spent before the registry is queried, and the answer is one
  // boolean. A 429 therefore says "you are going too fast", which depends only
  // on the caller's own history and never on whether the number exists.
  const allowed = await consumeRateLimit(supabase, secret, [
    { scope: "reg", value: reg },
    { scope: "ip", value: remoteIp },
  ]);
  if (!allowed) return json(req, { error: "TOO_MANY_REQUESTS" }, 429);

  // The query runs for known and unknown numbers alike and its result is used
  // only for the log line below. It is not returned, not counted, and not
  // branched on — see the note at the top of the file.
  let matched = 0;
  try {
    matched = await countStudentsMatching(supabase, reg);
  } catch (e) {
    // A database fault is not a statement about this number, but it is still not
    // something to report as a distinct outcome either: 503 is identical for
    // every number, so it cannot be used to probe.
    console.error("lookup: registry query failed:", e);
    return json(req, { error: "LOOKUP_FAILED" }, 503);
  }

  // Operator-visible only. This is the migration queue, watched here rather than
  // published to the browser — an earlier version returned
  // { found:false, reason:"legacy" } on the reasoning that disclosing "a real
  // student is pending migration" is strictly less than identity. It is less,
  // and it is still an oracle.
  if (matched > 0 && !/^RU\//i.test(reg)) {
    console.log("lookup: legacy-shaped number still resolves to a student row");
  }

  return json(req, ACCEPTED);
});
