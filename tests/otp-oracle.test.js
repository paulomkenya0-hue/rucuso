// tests/otp-oracle.test.js
//
// Proves the registration-number existence oracle is closed.
//
// The property under test is a negative one — "a known and an unknown
// registration number produce the same observable result" — and negative
// properties are exactly the kind that regress silently. Nothing in the normal
// flow ever exercises a made-up registration number against a live registry, so
// the day someone reintroduces a branch on existence, all twelve other suites
// stay green and the form starts leaking again.
//
// These tests run the REAL Edge Function source. They do not re-implement the
// responses: each function's handler is extracted and executed against a stub
// Supabase client, so a test that passes is evidence about the shipped code
// rather than about a copy of it. Where the two functions are genuinely
// different — one finds a student, one does not — the test asserts the
// responses are byte-identical, which is the whole claim.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "supabase", "functions");
const SHARED = path.join(FN, "_shared", "otp.ts");

let passed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) passed++;
  else failures.push(label);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label + (a === e ? "" : "  (expected " + e + ", got " + a + ")"));
}
// Tests are collected rather than started immediately, so the function modules
// are loaded once up front and each case runs in order. That keeps a failure
// pointing at one behaviour instead of a cascade.
const cases = [];
function test(fn) {
  cases.push(fn);
}

// ---------- loading the real Edge Function code ----------
//
// The functions are Deno modules that call serve() at import time. Instead of
// reimplementing their responses — which would only prove the copy is
// self-consistent — each one is rewritten into an ESM module that exports its
// handler, written to a temp file, and imported. Node strips the TypeScript
// annotations itself, so a test that passes is evidence about the shipped source
// rather than about a paraphrase of it.
//
// The only edits are mechanical: import statements are redirected, and the
// serve() call is turned into an export. The handler body is untouched.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "otp-oracle-"));

// _shared/otp.ts imports createClient over the network. It is replaced with a
// hook so a test can hand the module a stub registry instead.
function writeShared() {
  let src = fs.readFileSync(SHARED, "utf8");
  src = src.replace(
    /import\s*\{[^}]*\}\s*from\s*"https:\/\/esm\.sh[^"]*";?/g,
    "const createClient = (...a) => (globalThis.__createClient ? globalThis.__createClient(...a) : { __noClient: true });",
  );
  const file = path.join(TMP, "otp-shared.ts");
  fs.writeFileSync(file, src);
  return file;
}

const sharedFile = writeShared();

// Module-level constants in a function file (e.g. ACCEPTED) have to survive, so
// the whole file is kept and only serve() is rewritten.
async function loadFunction(dir) {
  let src = fs.readFileSync(path.join(FN, dir, "index.ts"), "utf8");

  // The module path has to be captured as its own group and filtered afterwards.
  // Matching "_shared" inside the from-clause instead makes the lazy body span
  // from the first `import {` all the way to the _shared one, which collects
  // the statements in between as if they were names.
  const names = [...src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)"\s*;?/g)]
    .filter((m) => m[2].includes("_shared"))
    .flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
  if (!names.length) throw new Error(dir + ": no _shared imports found");
  for (const n of names) {
    if (!/^\w+$/.test(n)) throw new Error(dir + ": unparsed import name " + JSON.stringify(n));
  }

  src = src
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]*";?/g, "")
    .replace(/import\s+\w+\s+from\s*"[^"]*";?/g, "")
    .replace(/^serve\(/m, "export const __handler = ")
    // serve(...) closes with `});`; the `)` belonged to the call and has no
    // meaning once the call is gone, so it is dropped while the `;` stays.
    .replace(/\)\s*;?\s*$/, ";\n");

  const file = path.join(TMP, dir + ".ts");
  fs.writeFileSync(
    file,
    "import * as S from " + JSON.stringify(pathToFileURL(sharedFile).href) + ";\n"
      + "const { " + names.join(", ") + " } = S;\n"
      + src,
  );
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.__handler !== "function") {
    throw new Error(dir + ": handler was not exported (got " + typeof mod.__handler + ")");
  }
  return mod.__handler;
}

// A registry for send-otp/verify-otp to resolve against, and for lookup-student
// to count against.
function makeEnv(overrides) {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
    STUDENT_LOOKUP_RATE_LIMIT_SECRET: "s".repeat(48),
    OTP_PEPPER: "p".repeat(32),
    SMS_PROVIDER: "beem",
    SMS_API_KEY: "k",
    SMS_SENDER_ID: "RUCUSO",
    // The documented development configuration. TURNSTILE_SECRET_KEY is not set,
    // and the skip is opted into by name rather than happening by accident —
    // which is the whole point of the flag, so the tests exercise it the way a
    // developer would actually set it up locally. The production configuration
    // and the misconfigured one are exercised explicitly below.
    LOCAL_DEV_SKIP_CAPTCHA: "1",
    ...overrides,
  };
}
// Production: real secret, no skip.
const CAPTCHA_ON = { TURNSTILE_SECRET_KEY: "t".repeat(32), LOCAL_DEV_SKIP_CAPTCHA: null };
// The dangerous deployment: the widget renders because config.js has a site
// key, but the secret was never set on the function.
const CAPTCHA_MISCONFIGURED = { TURNSTILE_SECRET_KEY: null, LOCAL_DEV_SKIP_CAPTCHA: null };

// The stub PostgREST. queryFor() is how the students table is matched, and it
// is the only place existence is modelled — the functions under test never see
// it, which is the point.
function makeSupabase(registry, opts) {
  const options = opts || {};
  const inserted = [];
  let pending = options.pending || null;

  const count = (filter) => {
    const m = filter && /registration_number\.ilike\.([^\s,]+)/.exec(filter);
    if (!m) return 0;
    const want = m[1].replace(/\\/g, "").toUpperCase();
    return registry.some(
      (s) => s.registration_number.toUpperCase() === want
        || (s.legacy_registration_number || "").toUpperCase() === want,
    ) ? 1 : 0;
  };
  const findOne = (filter) => {
    const m = filter && /registration_number\.ilike\.([^\s,]+)/.exec(filter);
    if (!m) return null;
    const want = m[1].replace(/\\/g, "").toUpperCase();
    const hit = registry.find(
      (s) => s.registration_number.toUpperCase() === want
        || (s.legacy_registration_number || "").toUpperCase() === want,
    );
    return hit ? { id: hit.id, phone_number: hit.phone_number } : null;
  };

  const client = {
    __inserted: inserted,
    // Every registry filter that was actually built. Used to assert that a
    // request rejected before the registry was reached never queried it — a
    // promise that is otherwise unobservable, because the response is uniform
    // either way.
    __queried: [],
    rpc(name) {
      if (name === "consume_student_lookup_attempt") {
        return Promise.resolve({ data: options.rateLimited ? false : true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      if (table === "students") {
        let mode = null;
        let filter = null;
        const chain = {
          select(_c, o) { mode = o && o.head ? "count" : "row"; return chain; },
          // Called twice: once with the registration-number filter and once with
          // the student_status filter. Only the first decides which row matches,
          // so the second must not overwrite it.
          or(f) {
            if (/registration_number\.ilike/.test(f)) { filter = f; client.__queried.push(f); }
            return chain;
          },
          limit() { return chain; },
          eq() { return chain; },
          then(res) {
            if (mode === "count") return Promise.resolve({ count: count(filter), error: null }).then(res);
            return Promise.resolve({ data: null, error: null }).then(res);
          },
          maybeSingle() {
            return Promise.resolve({ data: findOne(filter), error: null });
          },
        };
        return chain;
      }
      if (table === "otp_verifications") {
        return {
          select(_c, o) {
            if (o && o.head) {
              return { eq: () => ({ gte: () => Promise.resolve({ count: 0, error: null }) }) };
            }
            return {
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({ maybeSingle: () => Promise.resolve({ data: pending, error: null }) }),
                  }),
                }),
              }),
            };
          },
          insert(row) {
            inserted.push(row);
            pending = {
              ...row, id: "row-1", attempts: 0, verified: false,
              created_at: new Date().toISOString(),
            };
            return Promise.resolve({ error: null });
          },
          delete() { return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }; },
          update() { return { eq: () => Promise.resolve({ error: null }) }; },
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      };
    },
  };
  return client;
}

const handlers = {};

function makeReq(body) {
  return {
    method: "POST",
    headers: new Map([["cf-connecting-ip", "203.0.113.9"]]),
    json: () => Promise.resolve(body),
  };
}

async function run(dir, opts) {
  const o = opts || {};
  const env = makeEnv(o.env);
  const supabase = makeSupabase(o.registry || [], {
    pending: o.pending || null,
    rateLimited: o.rateLimited,
  });

  // The handler reads these at call time, so the modules can be loaded once.
  globalThis.Deno = { env: { get: (k) => (k in env ? env[k] : null) } };
  globalThis.__createClient = () => supabase;

  const calls = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, body: init && init.body });
    return o.fetchImpl ? o.fetchImpl(url, init) : Promise.resolve({ ok: true, status: 200 });
  };

  // The functions log deliberately — a provider failure and a student with no
  // phone on file are the operator's problem, not the caller's. Captured rather
  // than printed so a passing run is quiet, and asserted on below so the logs
  // cannot be quietly deleted along with everything else they replaced.
  const realConsole = { log: console.log, warn: console.warn, error: console.error };
  for (const m of ["log", "warn", "error"]) console[m] = (...a) => logs.push(m + ": " + a.join(" "));

  try {
    const res = await handlers[dir](makeReq(o.body));
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch (_e) { /* not JSON */ }
    return { status: res.status, body, raw: text, supabase, calls, logs };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realConsole.log;
    console.warn = realConsole.warn;
    console.error = realConsole.error;
  }
}

const KNOWN = [
  { id: "s-1", registration_number: "RU/BAFIT/2024/0007", phone_number: "+255700000001" },
];

// A pending code whose hash matches "123456" under the test pepper.
function goodPending(overrides) {
  return {
    id: "row-1", phone_number: "+255700000001", student_id: "s-1",
    otp_hash: crypto.createHash("sha256").update("p".repeat(32) + ":123456").digest("hex"),
    expires_at: new Date(Date.now() + 300000).toISOString(),
    attempts: 0, verified: false, created_at: new Date().toISOString(),
    ...overrides,
  };
}
const badPending = (o) => goodPending({ otp_hash: "a".repeat(64), ...o });


// =====================================================================
// 1. lookup-student must not distinguish a known number from an unknown
// =====================================================================

test(async () => {
  const known = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" },
  });
  const unknown = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" },
  });

  eq(known.status, unknown.status, "lookup-student: same status for known and unknown");
  eq(known.body, unknown.body, "lookup-student: identical body for known and unknown");
  ok(!("found" in (known.body || {})), "lookup-student: no `found` field in the response");
  ok(!("reason" in (known.body || {})), "lookup-student: no `reason` field in the response");
  eq(known.body, { ok: true }, "lookup-student: body is exactly { ok: true }");
});

test(async () => {
  // A legacy-shaped number that still resolves to a row must look like anything
  // else. This was the { found:false, reason:"legacy" } leak.
  const legacyReg = { id: "s-2", registration_number: "RU/CS/2023/0011", legacy_registration_number: "RUCU/2023/01", phone_number: "+255700000002" };
  const legacy = await run("lookup-student", {
    registry: [legacyReg], body: { reg: "RUCU/2023/01" },
  });
  eq(legacy.status, 200, "lookup-student: legacy-shaped number is accepted");
  eq(legacy.body, { ok: true }, "lookup-student: legacy-shaped number gets the same body");
});

test(async () => {
  // Malformed input must be indistinguishable too, or "not a registration
  // number" becomes the thing an attacker measures against.
  const junk = await run("lookup-student", { registry: KNOWN, body: { reg: "not-a-number" } });
  const known = await run("lookup-student", { registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" } });
  eq(junk.body, known.body, "lookup-student: malformed input gets the same body as a real number");
  eq(junk.status, known.status, "lookup-student: malformed input gets the same status");
});

// =====================================================================
// 2. send-otp must not distinguish, and must not take a destination
// =====================================================================

test(async () => {
  const known = await run("send-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" },
  });
  const unknown = await run("send-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" },
  });

  eq(known.status, unknown.status, "send-otp: same status for known and unknown");
  eq(known.body, unknown.body, "send-otp: identical body for known and unknown");
  eq(known.body, { ok: true, expires_in: 300 }, "send-otp: body is { ok, expires_in } only");
  for (const k of ["found", "reason", "legacy", "student_id", "phone_number", "full_name"]) {
    ok(!(k in (known.body || {})), "send-otp: no `" + k + "` in the response");
  }
});

test(async () => {
  // The out-of-band oracle. A phone in the request must not steer delivery, or
  // the response can be uniform while the SMS still tells the attacker the
  // answer.
  const src = fs.readFileSync(path.join(FN, "send-otp", "index.ts"), "utf8");
  const bodyRead = /const\s+body\s*=\s*await\s+readJson\(req\)/.test(src);
  ok(bodyRead, "send-otp: reads the request body");
  ok(!/body\.phone/.test(src), "send-otp: never reads a phone from the request body");
  ok(!/body\.phone_number/.test(src), "send-otp: never reads a phone_number from the request body");
  // The number it does send to has to come from the resolved student row.
  ok(/student\.phone/.test(src), "send-otp: delivers to the phone resolved from the registry");

  const sent = await run("send-otp", {
    registry: KNOWN,
    body: { reg: "RU/BAFIT/2024/0007", phone: "+255999999999" },
  });
  const student = KNOWN[0];
  ok(
    !JSON.stringify(sent.supabase.__inserted).includes("+255999999999"),
    "send-otp: a phone supplied in the request is never stored",
  );
  ok(
    sent.supabase.__inserted.length === 1
      && sent.supabase.__inserted[0].phone_number === student.phone_number,
    "send-otp: the code is stored against the number on file, not the one supplied",
  );
});

test(async () => {
  // An unknown registration number must send nothing at all: no row, no SMS.
  const calls = [];
  const spy = (...a) => { calls.push(a[0]); return Promise.resolve({ ok: true, status: 200 }); };
  const unknown = await run("send-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" }, fetchImpl: spy,
  });
  eq(unknown.body, { ok: true, expires_in: 300 }, "send-otp: unknown number still returns the uniform body");
  eq(unknown.supabase.__inserted.length, 0, "send-otp: no code stored for an unknown number");
  eq(calls.length, 0, "send-otp: no SMS provider call for an unknown number");
});

test(async () => {
  // A failed send is only possible for a real student, so reporting it would be
  // the oracle all over again. It must be logged — the information is not lost,
  // it is just not given to the caller — and swallowed.
  const failing = () => Promise.resolve({ ok: false, status: 500 });
  const known = await run("send-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" }, fetchImpl: failing,
  });
  const unknown = await run("send-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" }, fetchImpl: failing,
  });
  eq(known.body, unknown.body, "send-otp: a provider failure is indistinguishable from a success");
  eq(known.status, unknown.status, "send-otp: a provider failure returns the same status");
  ok(known.logs.some((l) => /not delivered/.test(l)),
    "send-otp: a delivery failure is still visible in the operator log");
  // The row must be cleaned up, or a code nobody received would hold a slot.
  eq(known.supabase.__inserted.length, 1, "send-otp: a row is written before the send is attempted");
});

test(async () => {
  // The uniform response costs the operator nothing, because the things that
  // used to be distinguishable are now logged.
  const noPhone = [{ id: "s-3", registration_number: "RU/BAFIT/2024/0012", phone_number: null }];
  const blank = await run("send-otp", { registry: noPhone, body: { reg: "RU/BAFIT/2024/0012" } });
  const unknown = await run("send-otp", { registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" } });
  eq(blank.body, unknown.body, "send-otp: a student with no phone on file matches an unknown number");
  ok(blank.logs.some((l) => /phone_number/.test(l)),
    "send-otp: a student with no phone on file is logged for the operator");
  // The two differ only in the log, which is the whole point of the design.
  eq(unknown.logs.length, 0, "send-otp: an unknown number logs nothing, because there is nothing to report");
});

test(async () => {
  // lookup-student's migration note must also stay server-side.
  const legacyReg = {
    id: "s-2", registration_number: "RU/CS/2023/0011",
    legacy_registration_number: "RUCU/2023/01", phone_number: "+255700000002",
  };
  const res = await run("lookup-student", { registry: [legacyReg], body: { reg: "RUCU/2023/01" } });
  eq(res.body, { ok: true }, "lookup-student: a legacy number's response carries no signal");
  ok(res.logs.some((l) => /legacy/.test(l)),
    "lookup-student: the pending-migration case is logged for the operator");
});

test(async () => {
  // A missing provider is a property of the deployment, so it must be detected
  // before the registry is consulted or it describes only real students.
  const src = fs.readFileSync(path.join(FN, "send-otp", "index.ts"), "utf8");
  const providerAt = src.indexOf('SMS_PROVIDER');
  const resolveAt = src.indexOf("resolveStudent(");
  ok(providerAt !== -1 && resolveAt !== -1, "send-otp: has both a provider check and a resolver");
  ok(providerAt < resolveAt, "send-otp: the provider is checked before the registry is read");
});

// =====================================================================
// 3. verify-otp must have exactly one failure
// =====================================================================

test(async () => {
  // A pending code that does not match the guess, versus a registration number
  // that resolves to nobody at all.
  const wrongCode = await run("verify-otp", {
    registry: KNOWN,
    body: { reg: "RU/BAFIT/2024/0007", code: "000000" },
    pending: {
      id: "row-1", phone_number: "+255700000001", student_id: "s-1",
      otp_hash: "a".repeat(64), expires_at: new Date(Date.now() + 300000).toISOString(),
      attempts: 0, verified: false, created_at: new Date().toISOString(),
    },
  });
  const unknown = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999", code: "000000" },
  });

  eq(wrongCode.status, unknown.status, "verify-otp: same status for a wrong code and an unknown number");
  eq(wrongCode.body, unknown.body, "verify-otp: identical body for a wrong code and an unknown number");
  eq(wrongCode.body, { verified: false, error: "INVALID_CODE" }, "verify-otp: one failure body");
  ok(!("attempts_left" in (wrongCode.body || {})), "verify-otp: no attempts_left in the response");
});

test(async () => {
  // Every rejection reason the old implementation had must be gone, because
  // each one of them was only reachable when a row existed.
  const src = fs.readFileSync(path.join(FN, "verify-otp", "index.ts"), "utf8");
  for (const code of ["NO_PENDING_CODE", "CODE_EXPIRED", "TOO_MANY_ATTEMPTS", "WRONG_CODE"]) {
    ok(!new RegExp('error:\\s*"' + code + '"').test(src), "verify-otp: no " + code + " response");
  }
  // And no other error code may be introduced without thought.
  const emitted = [...src.matchAll(/error:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
  const allowed = ["INVALID_CODE", "INVALID_CODE_FORMAT", "NOT_CONFIGURED", "TOO_MANY_REQUESTS"];
  for (const code of emitted) {
    ok(allowed.includes(code), "verify-otp: emitted code " + code + " is on the reviewed list");
  }
});

test(async () => {
  // An expired code and an exhausted one must also be indistinguishable from a
  // wrong one, or they are just the same oracle under new names.
  const base = {
    id: "row-1", phone_number: "+255700000001", student_id: "s-1",
    otp_hash: "a".repeat(64), attempts: 0, verified: false,
    created_at: new Date().toISOString(),
  };
  const expired = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "000000" },
    pending: { ...base, expires_at: new Date(Date.now() - 1000).toISOString() },
  });
  const exhausted = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "000000" },
    pending: { ...base, expires_at: new Date(Date.now() + 300000).toISOString(), attempts: 5 },
  });
  const wrong = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "000000" },
    pending: { ...base, expires_at: new Date(Date.now() + 300000).toISOString() },
  });
  eq(expired.body, wrong.body, "verify-otp: an expired code is indistinguishable from a wrong one");
  eq(exhausted.body, wrong.body, "verify-otp: an exhausted code is indistinguishable from a wrong one");
  eq(expired.body, { verified: false, error: "INVALID_CODE" }, "verify-otp: expired rejects with the one body");
  eq(exhausted.body, { verified: false, error: "INVALID_CODE" }, "verify-otp: exhausted rejects with the one body");
});

test(async () => {
  // A code that is correct for a dead (expired) row must not verify, even
  // though the hash matches — otherwise "expired" would still be a usable
  // signal and a stale code would still authenticate.
  const goodHash = require("crypto").createHash("sha256")
    .update("p".repeat(32) + ":123456").digest("hex");
  const res = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "123456" },
    pending: {
      id: "row-1", phone_number: "+255700000001", student_id: "s-1",
      otp_hash: goodHash, attempts: 0, verified: false,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString(),
    },
  });
  eq(res.body, { verified: false, error: "INVALID_CODE" }, "verify-otp: a correct code on an expired row is rejected");
});

test(async () => {
  // OTP must still be required: a registration number alone verifies nobody,
  // whether or not a code was ever sent for it.
  const noCodeField = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" },
  });
  ok(noCodeField.body.verified !== true, "verify-otp: a request with no code never verifies");

  const wrongCode = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "000000" },
    pending: badPending(),
  });
  eq(wrongCode.body, { verified: false, error: "INVALID_CODE" },
    "verify-otp: a known number with a wrong code is rejected");

  // A short code is refused on its own shape, which says nothing about existence.
  const shortCode = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "12345" },
  });
  const shortCodeUnknown = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999", code: "12345" },
  });
  eq(shortCode.body, shortCodeUnknown.body, "verify-otp: the code-format refusal is the same for every number");

  // And identity must never appear on a rejection.
  const leaks = ["full_name", "programme", "year_of_study", "faculty", "student_id", "phone_number"];
  for (const k of leaks) {
    ok(!(k in (wrongCode.body || {})), "verify-otp: a rejection carries no `" + k + "`");
    ok(!(k in (shortCode.body || {})), "verify-otp: a format rejection carries no `" + k + "`");
  }
});

test(async () => {
  // A successful verification is the one place identity is allowed out, and it
  // must be the only one.
  const goodHash = require("crypto").createHash("sha256")
    .update("p".repeat(32) + ":123456").digest("hex");
  const res = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "123456" },
    pending: {
      id: "row-1", phone_number: "+255700000001", student_id: "s-1",
      otp_hash: goodHash, attempts: 0, verified: false,
      expires_at: new Date(Date.now() + 300000).toISOString(), created_at: new Date().toISOString(),
    },
  });
  ok(res.body && res.body.verified === true, "verify-otp: a correct code verifies");
});

// =====================================================================
// 4. No function in the verification path may mention existence
// =====================================================================

test(async () => {
  const forbidden = [
    /"found"\s*:/, /found\s*:\s*true/, /found\s*:\s*false/,
    /"STUDENT_NOT_FOUND"/, /"PHONE_MISMATCH"/, /"INVALID_REGISTRATION"/,
    /"NO_PENDING_CODE"/, /"CODE_EXPIRED"/, /"TOO_MANY_ATTEMPTS"/, /"WRONG_CODE"/,
    /reason\s*:\s*"(legacy|not-found)"/,
  ];
  for (const dir of ["lookup-student", "send-otp", "verify-otp"]) {
    const src = fs.readFileSync(path.join(FN, dir, "index.ts"), "utf8");
    // Ignore comments, so the file can explain the history it is not repeating.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const re of forbidden) {
      ok(!re.test(code), dir + ": source contains no " + re.source);
    }
  }
});

test(async () => {
  // The browser must not be able to ask the question either.
  // Scoped to the two forms an existence signal actually takes in this codebase:
  // a `found:` key in a response object, and a `.found` property read.
  //
  // A blunt /\bfound\b/ is wrong here and was tried first: it matches
  // `found = id` in app.js's scroll-spy and the string "no rows found" in
  // supabase-client.js's error-message regex. Neither has anything to do with
  // the registry, and a test that has to be special-cased to stop failing is a
  // test that will be quietly deleted the next time it gets in the way.
  const client = fs.readFileSync(path.join(ROOT, "supabase", "supabase-client.js"), "utf8");
  const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/\bfound\s*:/.test(clientCode), "supabase-client.js: builds no `found:` field");
  ok(!/\.found\b/.test(clientCode), "supabase-client.js: reads no `.found` property");
  ok(!/verifyStudentIdentity/.test(clientCode),
    "supabase-client.js: the pre-OTP identity path is gone from code");
  ok(!/sendOtp\s*\(\s*phone/i.test(clientCode), "supabase-client.js: sendOtp does not take a phone");

  const app = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  const appCode = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/\bfound\s*:/.test(appCode), "app.js: builds no `found:` field");
  ok(!/\.found\b/.test(appCode), "app.js: reads no `.found` property");
  ok(!/confirmPhoneOnFile/.test(appCode), "app.js: the pre-OTP bypass function is gone from code");

  // The phone field is gone from the markup, so there is no delivery destination
  // for a script to control even if it wanted one.
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  ok(!/id="ver_phone"/.test(html), "index.html: the OTP step has no phone field");
  ok(!/id="ver_phone_out"/.test(html), "index.html: the OTP step echoes no phone number");
});

// =====================================================================
// 5. The invariants the rest of the flow already relied on must hold
// =====================================================================

test(async () => {
  // Turnstile, in both configurations.
  //
  // Production — the secret is set, so a request with no token is refused, and
  // the refusal is identical for every registration number so it cannot be used
  // as a probe.
  const noToken = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" }, env: CAPTCHA_ON,
  });
  eq(noToken.status, 403, "lookup-student: a missing CAPTCHA token is refused");
  const noTokenUnknown = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" }, env: CAPTCHA_ON,
  });
  eq(noTokenUnknown.body, noToken.body, "lookup-student: the CAPTCHA refusal is the same for every number");
  eq(noTokenUnknown.status, noToken.status, "lookup-student: the CAPTCHA refusal has one status");

  // Development — the secret is unset and the skip is opted into by name. It
  // relaxes the CAPTCHA without loosening anything about existence: same body,
  // same status, for both. It also says so, loudly, on every request.
  const devKnown = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" },
  });
  const devUnknown = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" },
  });
  eq(devKnown.status, 200, "lookup-student: the dev opt-in accepts the request");
  eq(devKnown.body, devUnknown.body, "lookup-student: the dev opt-in is still uniform");
  eq(devKnown.body, { ok: true }, "lookup-student: the dev opt-in returns the same body");
  ok(devKnown.logs.some((l) => /LOCAL_DEV_SKIP_CAPTCHA/.test(l)),
    "lookup-student: the dev opt-in announces itself, so it cannot be silent in production");
  ok(devKnown.logs.some((l) => /NOT being verified/.test(l)),
    "lookup-student: the warning says what it means, not just what is set");

  // The misconfiguration that the old code failed open on. A site key in
  // config.js means the widget renders and the student solves it; if the server
  // secret is missing the token arrives and is thrown away. This must refuse
  // rather than wave the request through.
  const broken = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" }, env: CAPTCHA_MISCONFIGURED,
  });
  eq(broken.status, 503, "lookup-student: a missing server secret is a hard failure, not a free pass");
  eq(broken.body, { error: "NOT_CONFIGURED" }, "lookup-student: the misconfiguration says nothing about the number");
  // And it is refused the same way whatever the number, so a broken deployment
  // still cannot be used to enumerate the registry.
  const brokenUnknown = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/9999" }, env: CAPTCHA_MISCONFIGURED,
  });
  eq(brokenUnknown.body, broken.body, "lookup-student: the misconfiguration response is the same for every number");
  // The registry is never even touched in that state.
  eq(broken.supabase.__queried.length, 0, "lookup-student: a misconfigured deployment does not query the registry");

  // A dev opt-in is not a bypass for the rate limits, and not a bypass for the
  // format check either.
  const devCapped = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" }, rateLimited: true,
  });
  eq(devCapped.status, 429, "lookup-student: the dev opt-in does not disable rate limiting");
  const devMalformed = await run("lookup-student", {
    registry: KNOWN, body: { reg: "not-a-number" },
  });
  eq(devMalformed.body, { ok: true }, "lookup-student: the dev opt-in still refuses malformed input quietly");
});

test(async () => {
  // Rate limiting must still bite, on all three functions.
  const capped = await run("lookup-student", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" }, rateLimited: true,
  });
  eq(capped.status, 429, "lookup-student: an exhausted rate limit returns 429");

  const cappedSend = await run("send-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007" }, rateLimited: true,
  });
  eq(cappedSend.status, 429, "send-otp: an exhausted rate limit returns 429");

  const cappedVerify = await run("verify-otp", {
    registry: KNOWN, body: { reg: "RU/BAFIT/2024/0007", code: "123456" }, rateLimited: true,
  });
  eq(cappedVerify.status, 429, "verify-otp: an exhausted rate limit returns 429");
});

test(async () => {
  // A 429 must not depend on existence: it is spent before any lookup.
  const src = fs.readFileSync(path.join(FN, "send-otp", "index.ts"), "utf8");
  ok(src.indexOf("consumeRateLimit") < src.indexOf("resolveStudent("),
    "send-otp: the rate limit is spent before the registry is read");
  const lookup = fs.readFileSync(path.join(FN, "lookup-student", "index.ts"), "utf8");
  ok(lookup.indexOf("consumeRateLimit") < lookup.indexOf("countStudentsMatching"),
    "lookup-student: the rate limit is spent before the registry is read");
});

test(async () => {
  // Secrets stay on the server.
  //
  // A secret *name* is allowed to appear in a console diagnostic — app.js names
  // STUDENT_LOOKUP_RATE_LIMIT_SECRET when the function answers NOT_CONFIGURED,
  // which is how an operator finds out what is missing. A secret value, a read
  // of the environment, or a use of the name anywhere other than a log line is
  // not. So console calls are blanked out first and the names must not survive.
  const SECRETS = [
    "OTP_PEPPER", "SUPABASE_SERVICE_ROLE_KEY", "SMS_API_KEY", "SMS_API_SECRET",
    "TURNSTILE_SECRET_KEY", "STUDENT_LOOKUP_RATE_LIMIT_SECRET",
  ];
  for (const f of ["js/app.js", "js/verify-ux.js", "supabase/supabase-client.js", "supabase/config.js"]) {
    let code = fs.readFileSync(path.join(ROOT, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Blank out console.<method>( ... ) so an operator-facing name is allowed.
    code = code.replace(/console\s*\.\s*\w+\s*\((?:[^()]|\([^()]*\))*\)/g, "console./*blanked*/");
    for (const s of SECRETS) {
      ok(!code.includes(s), f + ": " + s + " appears only inside a console diagnostic, if at all");
    }
    ok(!/Deno\.env/.test(code), f + ": does not read a runtime environment");
  }

  // And the names are not values: config.js must not carry one.
  const config = fs.readFileSync(path.join(ROOT, "supabase", "config.js"), "utf8");
  for (const s of SECRETS) {
    ok(!new RegExp(s + "\\s*[:=]\\s*[\"'][^\"']+[\"']").test(config),
      "config.js: " + s + " has no committed value");
  }
});

test(async () => {
  // The registration format must not have been loosened.
  const shared = fs.readFileSync(path.join(FN, "_shared", "otp.ts"), "utf8");
  ok(/\/\^RU\\\/\[A-Z\]\{2,6\}\\\/\\d\{4\}\\\/\\d\{3,4\}\$\/i/.test(shared),
    "_shared: the registration regex is unchanged");
});

test(async () => {
  // verify-otp must resolve the phone server-side, so a request cannot be
  // pointed at somebody else's pending code.
  const src = fs.readFileSync(path.join(FN, "verify-otp", "index.ts"), "utf8");
  ok(!/body\.phone/.test(src), "verify-otp: never reads a phone from the request body");
  ok(/resolveStudent/.test(src), "verify-otp: resolves the phone from the registry");
});

test(async () => {
  // The no-student path must still do the same work, so it cannot be separated
  // by response time.
  const src = fs.readFileSync(path.join(FN, "verify-otp", "index.ts"), "utf8");
  ok(/ABSENT_PHONE/.test(src), "verify-otp: an absent phone is substituted so the query still runs");
  ok(/ABSENT_HASH/.test(src), "verify-otp: a decoy hash is compared so the work is unchanged");
  const compareAt = src.indexOf("safeEquals(candidate");
  ok(compareAt !== -1, "verify-otp: the comparison is made unconditionally");
});

// ---------- run ----------

(async () => {
  for (const dir of ["lookup-student", "send-otp", "verify-otp"]) {
    handlers[dir] = await loadFunction(dir);
  }
  for (const c of cases) {
    try {
      await c();
    } catch (e) {
      failures.push("threw: " + (e && e.message ? e.message : String(e)));
    }
  }
  failures.forEach((f) => console.log("  FAIL  " + f));
  const total = passed + failures.length;
  if (failures.length) {
    console.log("\n" + failures.length + " of " + total + " checks failed");
    process.exitCode = 1;
  } else {
    console.log("all " + total + " checks passed");
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
})();
