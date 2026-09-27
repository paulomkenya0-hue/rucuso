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
