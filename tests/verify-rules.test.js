#!/usr/bin/env node
// RUCUSO — registration number format + migration safety
//
// The format is now strict: RU/<COURSE_CODE>/<YEAR>/<STUDENT_NUMBER>. This file
// tests two things that matter and are easy to get wrong:
//
//   1. That the accepted set is EXACTLY the specified format, and that
//      near-misses are refused. A too-loose regex is how a student ends up
//      permanently unable to log in after a format change.
//   2. That the migration does not strand anyone. A format change with no
//      backfill is a lockout, and it is invisible until a real student tries.
//
// Run: node tests/verify-rules.test.js
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  failures.push(name + (detail ? "  ->  " + detail : ""));
}

// js/verify-ux.js is an IIFE that touches window and document at load, so it
// cannot be required. The regexes are read out of the source and re-run here,
// which is the point: if someone changes the rule, this test has to fail.
const src = fs.readFileSync(path.join(ROOT, "js", "verify-ux.js"), "utf8");
// Shorter aliases, because the assertions below read better as `js` and
// `appJs` than as the full paths repeated on every line.
const js = src;
const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");

function grab(name) {
  const m = src.match(new RegExp("var " + name + " = (/.+?/[a-z]*);"));
  if (!m) { ok("declares " + name, false, "not found in verify-ux.js"); return null; }
  return eval(m[1]); // eslint-disable-line no-eval -- parsing our own source
}

const NEW_RE = grab("NEW_RE");
const LEGACY_RE = grab("LEGACY_RE");
if (!NEW_RE || !LEGACY_RE) report();

const canonical = (raw) =>
  String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, "");
const loose = (raw) =>
  String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s*([\/\-])\s*/g, "$1");

// ---- MUST ACCEPT: the specified examples, verbatim --------------------------
// The three formats given in the requirement, plus the boundary widths the
// regex allows (2 and 6 letter course codes, 3 and 4 digit numbers).
const accept = [
  ["RU/BAFIT/2024/007", "example 1 from the requirement"],
  ["RU/BIT/2023/123", "example 2 from the requirement"],
  ["RU/BBA/2025/001", "example 3 from the requirement"],
  ["ru/bafit/2024/007", "lower case — normalised, not rejected"],
  ["  RU/BAFIT/2024/007  ", "surrounding whitespace from a paste"],
  ["RU / BAFIT / 2024 / 007", "spaces around the slashes"],
  ["RU/BA/2024/007", "two-letter course code, the short boundary"],
  ["RU/ABCDEF/2024/007", "six-letter course code, the long boundary"],
  ["RU/BAFIT/2024/0007", "four-digit student number, the long boundary"],
  ["RU/BAFIT/2024/999", "three-digit student number, the short boundary"],
];

for (const [value, why] of accept) {
  ok("accepts " + JSON.stringify(value) + " (" + why + ")", NEW_RE.test(loose(value)));
}

// ---- MUST REJECT ----------------------------------------------------------
// Each of these is one character away from valid. These are the cases a
// hand-written regex gets wrong, and every one of them would let a wrong number
// through to the database.
const reject = [
  ["", "empty"],
  ["RU", "no segments"],
  ["RU/BAFIT/2024", "missing the student number"],
  ["RU/2024/007", "missing the course code"],
  ["RU/BAFIT/007", "missing the year"],
  ["RUCU/2024/01", "the old format — the single most important reject"],
  ["RU/BAFIT/24/007", "two-digit year"],
  ["RU/BAFIT/20244/007", "five-digit year"],
  ["RU/BAFIT/2024/07", "two-digit student number"],
  ["RU/BAFIT/2024/00007", "five-digit student number"],
  ["RU/1BAFIT/2024/007", "course code starting with a digit"],
  ["RU/BAFIT1/2024/007", "course code ending with a digit"],
  ["RU/BAFIT/2024/00A", "student number containing a letter"],
  ["RU/BAFIT/ABCD/007", "year containing letters"],
  ["RU-BAFIT-2024-007", "hyphens instead of slashes"],
  ["RU/BAFIT/2024/007/1", "an extra segment"],
  ["RU/BAFIT//007", "an empty segment"],
  ["rucu/2024/01", "the old format, lower case"],
];

for (const [value, why] of reject) {
  ok("rejects " + JSON.stringify(value) + " (" + why + ")", !NEW_RE.test(loose(value)));
}

// ---- the legacy regex must NOT be a way in --------------------------------
// It exists only to produce a specific error message. If it ever starts
// authorising a lookup, unmigrated students would be pushed into a flow that
// assumes the new format.
const legacy = [
  ["RUCU/2024/01", "the old shape from the old placeholder"],
  ["BFC/23/001", "a different prefix, two-digit year"],
  ["RUCU/2023/1234", "a wider index"],
];
for (const [value, why] of legacy) {
  ok("legacy shape recognised: " + value + " (" + why + ")", LEGACY_RE.test(loose(value)));
  ok("legacy shape is not accepted as current: " + value, !NEW_RE.test(loose(value)));
}

// ---- the spec's exact regex must be what shipped ---------------------------
// Guards against the rule drifting into something that merely resembles it.
ok(
  "NEW_RE is exactly /^RU\\/[A-Z]{2,6}\\/\\d{4}\\/\\d{3,4}$/i",
  NEW_RE.source === "^RU\\/[A-Z]{2,6}\\/\\d{4}\\/\\d{3,4}$" && NEW_RE.flags === "i",
  "got source=" + JSON.stringify(NEW_RE.source) + " flags=" + JSON.stringify(NEW_RE.flags),
);

// ---- auto upper-case -------------------------------------------------------
ok("input is forced to upper case on entry", /function forceUpper/.test(src));
ok(
  "upper-casing preserves the caret rather than jumping to the end",
  /setSelectionRange/.test(src),
  "caret restoration missing — typing mid-number would be impossible",
);
ok("pasted text is normalised too", /"paste"/.test(src));

// ---- the button gate -------------------------------------------------------
// The requirement is regex AND captcha. A gate that ignores either one is a
// regression against a stated requirement, so both are asserted.
ok("button state consults the CAPTCHA gate", /captchaSatisfied\(\)/.test(src));
ok(
  "the gate is regex AND captcha, not either",
  /var ready = result\.ok && left > 0 && captchaOk/.test(src)
  || /disabled = !\(result\.ok && left > 0 && captchaOk\)/.test(src),
  "setButtonState does not combine all three conditions",
);
// Inverted on purpose. The previous assertion here was the opposite of this —
// it required a missing site key to count as a satisfied CAPTCHA, so that a
// deployment which forgot to configure Turnstile would light the button up and
// look exactly like one where a CAPTCHA had been solved. That is a control that
// fails to the permissive side, so it is asserted in the strict direction now.
ok(
  "an unconfigured CAPTCHA does NOT count as satisfied",
  /function captchaSatisfied\(\) \{\s*if \(!isCaptchaEnabled\(\)\) return false;/.test(src)
  && !/if \(!isCaptchaEnabled\(\)\) return true/.test(src),
  "a missing site key is being treated as a solved CAPTCHA",
);
ok("solving the CAPTCHA re-runs the gate", /callback: function \(token\) \{[\s\S]{0,400}setButtonState/.test(src));
ok("an expired CAPTCHA re-closes the gate", /expired-callback[\s\S]{0,120}setButtonState/.test(src));
ok("the guard re-checks the captcha, not just the button", /if \(!captchaSatisfied\(\)\)/.test(src));

// ---- the format must not appear in the visible UI at all -------------------
// Not hidden, not behind a click: absent. A control that reveals the format on
// demand was tried and reverted, because "Namba haijasikika? Onyesha mfano" is
// itself a statement that a format exists, and the shape then lives in the
// served JS bundle for anyone who opens the source. If the shape has to be kept
// out of the page, the way to do that is to not have it there.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const verifyView = html.slice(html.indexOf('id="view-verify"'), html.indexOf('id="view-submit"'));
const motionCss = fs.readFileSync(path.join(ROOT, "css", "motion.css"), "utf8");
const lookupFn = fs.readFileSync(
  path.join(ROOT, "supabase", "functions", "lookup-student", "index.ts"), "utf8");
const configJs = fs.readFileSync(path.join(ROOT, "supabase", "config.js"), "utf8");

ok("the character counter is gone", !/id="ver1_counter"/.test(html));
ok("nothing renders a character counter", !/fcounter/.test(js) && !/fcounter/.test(html));
ok("the placeholder states no format", !/placeholder="[^"]*RU\//i.test(verifyView));
ok("the neutral instruction is present",
  /Ingiza Registration Number yako ili kuanza uthibitisho/.test(verifyView));
ok("there is no reveal control", !/id="ver1_reveal"/.test(html));
ok("there is no format example element", !/id="ver1_example"/.test(html));
ok("no format example is served in the verify view", !/RU\/BAFIT/.test(verifyView));
ok("no control offers to show the format", !/Onyesha mfano/.test(verifyView));
ok("the reveal handler is gone from the script", !/toggleFormat|reveal-format/.test(js));
ok("no reveal styles remain", !/freveal/.test(motionCss));
// A literal example anywhere in the view is a leak, hidden or not.
ok("the verify view never spells out a sample number",
  !/RU\/[A-Z]{2,6}\/\d{4}\/\d{3,4}/.test(verifyView));

// ---- no success oracle -----------------------------------------------------
// "that looks right" is as much a leak as the format itself.
ok("no success confirmation is shown for a valid number",
  !/Namba inaonekana sahihi/.test(js) && !/Namba inaonekana sahihi/.test(html));
ok("the hint never confirms correctness", !/fhint--ok/.test(js));

// The hint's *presence* is a signal too. It used to render only when the number
// was well-formed, which meant watching #ver1_hint told you whether the shape
// matched without sending a request.
const hintBlock = js.slice(js.indexOf("if (els.hint)"), js.indexOf("function renderLimit"));
ok("the hint does not branch on whether the number validated",
  !/result\.ok\s*&&/.test(hintBlock) && !/result\.ok\s*\|\|/.test(hintBlock),
  "the hint text still depends on the number's validity, which is an oracle");

// ---- one message for every failure ----------------------------------------
ok("a single failure string is defined", /var FAIL_TEXT =/.test(js));
ok(
  "every failure code returns the same message",
  /code: "too-long", message: FAIL_TEXT/.test(js)
  && /code: "legacy", message: FAIL_TEXT/.test(js)
  && /code: "shape", message: FAIL_TEXT/.test(js),
  "a failure path returns a distinct message — that is an oracle",
);
// Matches a definition, not the name in a comment explaining its removal.
ok("no code path still builds a legacy-specific message",
  !/function legacyMessage/.test(js) && !/legacyMessage\(/.test(appJs));
ok("support links are not attached to individual failures", !/supportHtml/.test(appJs));
ok("the unused support-link builder was removed", !/function supportHtml/.test(js));

// ---- the static "not configured" message is gone ---------------------------
// The reported bug: a permanent "Huduma ya kuangalia namba ya usajili
// haijawekwa bado" that appeared for every visitor who mistyped a number.
//
// Comments are stripped first. The prose explaining why the string was removed
// necessarily quotes it, and a test that fails on its own explanation is a test
// that pushes the next person to delete the explanation instead of the string.
const appCode = appJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
ok("the static not-configured sentence is gone from the shipped bundle",
  !/Huduma ya kuangalia namba ya usajili/.test(appCode),
  "the deployment's configuration is still being announced to visitors");
// Anchored to the start of a line so SMS_PROVIDER_NOT_CONFIGURED, which is a
// different code with a legitimately different message, is not matched by the
// substring NOT_CONFIGURED.
ok("it is not in the message table either", !/^[ \t]*NOT_CONFIGURED:/m.test(appCode));
ok("the unrelated SMS code keeps its own message",
  /^[ \t]*SMS_PROVIDER_NOT_CONFIGURED:/m.test(appCode));
ok("the lookup catch renders the generic sentence, not the code's own text",
  /esc\(lookupFailureText\(\)\)/.test(appCode),
  "the catch block is still rendering a per-code message");
ok("the catch block does not consult the per-code message table",
  !/functionErrorText/.test(appCode.slice(
    appCode.indexOf("async function verifyStep1"), appCode.indexOf("let otpTimer"))),
  "the lookup step is still able to render a code-specific sentence");
ok("the real reason is still logged for the operator",
  /console\.error\("verify: lookup-student failed\./.test(appCode));

// ---- uppercase + caret -----------------------------------------------------
ok("input is forced to upper case", /function forceUpper/.test(js));
ok("the caret is saved and restored around the transform",
  /selectionStart/.test(js) && /selectionEnd/.test(js) && /setSelectionRange/.test(js));
ok("a paste is normalised too", /addEventListener\("paste"/.test(js));

// ---- CAPTCHA ---------------------------------------------------------------
ok("the button gate combines the number, the budget and the CAPTCHA",
  /disabled = !\(result\.ok && left > 0 && captchaOk\)/.test(js));
ok("the CAPTCHA mount sits inside the form",
  verifyView.indexOf('id="verCaptcha"') > -1
  && verifyView.indexOf('id="verCaptcha"') < verifyView.indexOf('id="ver1_btn"'),
  "Turnstile must mount immediately above the button");
ok("a missing site key fails closed rather than passing",
  /function captchaSatisfied\(\) \{\s*if \(!isCaptchaEnabled\(\)\) return false;/.test(js),
  "a deployment with no Turnstile key is running with no CAPTCHA and no warning");
ok("a Turnstile load failure also fails closed", /captchaFault = "load-failed"/.test(js));
ok("the fault is reported to the operator", /TURNSTILE_SITE_KEY is not set/.test(js));
ok("the fault message says nothing about configuration",
  /function captchaFaultText\(\) \{\s*return CAPTCHA_FAULT_TEXT;/.test(js)
  && !/haijasajiliwa|not configured/i.test(js.slice(
    js.indexOf("var CAPTCHA_FAULT_TEXT"), js.indexOf("function captchaFaultText"))),
  "the student-facing fault text is explaining the deployment");
ok("the token is read only from the widget", /function captchaTokenValue/.test(js));
ok("the secret is never referenced in the browser",
  !/TURNSTILE_SECRET_KEY/.test(js) && !/TURNSTILE_SECRET_KEY/.test(appJs));
ok("the token is sent with the lookup",
  /lookupRegistrationNumber\(reg, captchaToken\)/.test(appJs));
ok("the server verifies the token", /siteverify/.test(lookupFn));

// The client fails closed on a blank site key, but the client cannot see the
// secret — so a site key without a secret is a deployment where the widget
// renders, the student solves it, and the server discards the token. The server
// has to refuse that outright rather than treat the missing secret as "no
// CAPTCHA configured".
ok("the server requires the secret rather than skipping the check when it is absent",
  /if \(!captchaSecret\)/.test(lookupFn)
  && !/if \(Deno\.env\.get\("TURNSTILE_SECRET_KEY"\)\) \{/.test(lookupFn),
  "an absent secret is being treated as no CAPTCHA configured");
ok("an absent secret with no opt-in is a hard failure",
  /return json\(req, \{ error: "NOT_CONFIGURED" \}, 503\)/.test(lookupFn));
ok("running without the secret is an explicit, named opt-in",
  /LOCAL_DEV_SKIP_CAPTCHA/.test(lookupFn));
ok("the opt-in must be set to exactly 1, so a typo cannot enable it",
  /Deno\.env\.get\("LOCAL_DEV_SKIP_CAPTCHA"\) === "1"/.test(lookupFn));
ok("the opt-in warns on every request, so it cannot be silent in production",
  /LOCAL_DEV_SKIP_CAPTCHA[\s\S]{0,200}console\.warn/.test(lookupFn));
ok("the opt-in is not wired into the browser or the committed config",
  !/LOCAL_DEV_SKIP_CAPTCHA/.test(js) && !/LOCAL_DEV_SKIP_CAPTCHA/.test(appJs)
  && !/LOCAL_DEV_SKIP_CAPTCHA/.test(configJs));

// ---- spinner + duplicate submits -------------------------------------------
ok("the button has a spinner element", /id="ver1_btn"[\s\S]{0,200}btn__spin/.test(verifyView));
ok("busy() preserves the spinner markup", /querySelector\("\.btn__label"\)/.test(appJs));
ok("the button is disabled and marked busy on click",
  /busy\(btn, true, "Inathibitisha\.\.\."\)/.test(appJs));
ok("there is a minimum visible spinner duration", /MIN_SPIN_MS/.test(appJs));
ok("the spinner floor is 1500ms", /MIN_SPIN_MS = 1500/.test(appJs));
ok("the floor only waits out the remainder",
  /remaining = MIN_SPIN_MS - \(Date\.now\(\) - startedAt\)/.test(appJs),
  "the floor must not delay the request itself");
ok("duplicate submits are refused while one is in flight",
  /let verifyInFlight = false/.test(appJs) && /if \(verifyInFlight\) return;/.test(appJs)
  && /verifyInFlight = false/.test(appJs));
ok("the in-flight flag is released in a finally block",
  /finally \{[\s\S]{0,400}verifyInFlight = false/.test(appJs),
  "a thrown request would leave the form permanently locked");

// ---- success only after the last-name check --------------------------------
ok("the success sentence is defined once",
  /const VERIFIED_TEXT = "Utambulisho umethibitishwa kikamilifu!"/.test(appJs));
const studentFn = appJs.slice(
  appJs.indexOf("async function verifyStudentLastName"),
  appJs.indexOf("function studentLogout"));
ok("identity is revealed only after verifyStudent succeeds",
  studentFn.indexOf("await API.verifyStudent") < studentFn.indexOf("verifiedStudentInfo")
  && studentFn.indexOf("await API.verifyStudent") < studentFn.indexOf("status.textContent = VERIFIED_TEXT"),
  "identity or success is shown before the last-name verification returns");
ok("a rejection renders the shared verification failure text",
  /VERIFY_FAIL_TEXT/.test(studentFn) && /catch \(e\)/.test(studentFn),
  "the last-name rejection is not handled as a verification failure");
ok("the success message does not use the error class",
  /status\.className = "ok-msg"/.test(studentFn));

// ---- the map ---------------------------------------------------------------
const mapJs = fs.readFileSync(path.join(ROOT, "js", "map.js"), "utf8");
ok("the map lives inside the verify view",
  html.indexOf('id="mapHost"') > html.indexOf('id="view-verify"')
  && html.indexOf('id="mapHost"') < html.indexOf('id="view-submit"'));
ok("the map has a reliable init for a hidden view", /function ensure\(\)/.test(mapJs));
ok("app.js triggers it on navigation", /RucusoMap\.ensure\(\)/.test(appJs));
ok("the pin is the RUCU campus", /lat: -7\.7760, lng: 35\.6963/.test(mapJs));
ok("the popup label is correct",
  /RUCUSO Headquarters/.test(mapJs) && /Ruaha Catholic University/.test(mapJs));
ok("the popup links to Google Maps", /google\.com\/maps\/dir/.test(mapJs));

// The reported 404: the map linked to /leader/, which does not exist. The live
// links are all /leader/login/, which does exist, so this has to match the bare
// path and not merely the substring. Comments are stripped first, because both
// files explain in prose that /leader/ was removed and that is not a link.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/^[ \t]*\/\/.*$/gm, "");
ok("nothing links to the non-existent /leader/ index",
  !/href="\/leader\/"/.test(stripComments(mapJs) + stripComments(verifyView))
  && !/rucuso\.online\/leader\//.test(stripComments(mapJs) + stripComments(verifyView)));
ok("the working /leader/login/ links are still there",
  /href="\/leader\/login\/"/.test(verifyView) || /leader\/login/.test(html));
ok("leader/index.html genuinely does not exist",
  !fs.existsSync(path.join(ROOT, "leader", "index.html")));

// ---- no raw developer email in the header ----------------------------------
const header = html.slice(0, html.indexOf('id="homeview"'));
const emails = header.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
ok("no hardcoded email address in the header", emails.length === 0, emails.join(", "));
ok("no hardcoded email anywhere in the verify script",
  !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(js));

// ---- migration safety ------------------------------------------------------
const mig = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "014_course_codes.sql"), "utf8");
ok("migration adds course_code", /add column if not exists course_code/.test(mig));
ok("migration preserves the old number", /legacy_registration_number/.test(mig));
ok("the backfill skips rows with no course code", /where course_code is not null/.test(mig));
ok(
  "the backfill never invents a course code",
  !/course_code\s*=\s*'XXX'|course_code\s+default\s+'/i.test(mig),
  "a default course code would mint numbers that look valid but are wrong",
);
ok("the backfill is not run automatically", !/^\s*select backfill_student_registration_numbers\(\);/mi.test(mig));
ok("the format is enforced in the database, not only the form", /students_current_format_chk/.test(mig));
ok("the constraint permits legacy rows while they exist", /registration_format <> 'current'/.test(mig));
ok("duplicate course codes abort the backfill loudly", /duplicate registration numbers/.test(mig));
ok("the backfill is idempotent", /already in the new shape|!~ '\^RU\//.test(mig));
ok("no RLS policy is added over the new columns", !/create policy[\s\S]{0,80}course_code/i.test(mig));
ok("there is a worklist for whoever supplies course codes", /registration_course_code_worklist/.test(mig));
ok("there is a report to confirm the migration finished", /registration_migration_report/.test(mig));

// ---- server and client must agree on the format ---------------------------
//
// The format now lives in one place — _shared/otp.ts — so that lookup-student,
// send-otp and verify-otp cannot drift apart and start disagreeing about which
// numbers exist. That was a real bug once: lookup-student and send-otp each
// built their own match, and a student could pass step 1 and then be told the
// same number did not exist.
const sharedFn = fs.readFileSync(
  path.join(ROOT, "supabase", "functions", "_shared", "otp.ts"), "utf8");
const fn = fs.readFileSync(
  path.join(ROOT, "supabase", "functions", "lookup-student", "index.ts"), "utf8");
ok("the server enforces the same current format",
  /\^RU\\\/\[A-Z\]\{2,6\}\\\/\\d\{4\}\\\/\\d\{3,4\}\$\/i/.test(sharedFn));
ok("the format check is a single shared helper",
  /isRegistrationShaped/.test(fn) && /export function isRegistrationShaped/.test(sharedFn));
ok("the server rejects malformed input before spending rate-limit budget",
  // Compare call sites, not first mentions — both names appear in the import
  // block, so indexOf finds the import first and says nothing.
  fn.indexOf("isRegistrationShaped(reg)") < fn.indexOf("await consumeRateLimit("));
ok("the server never returns a student column", !/select\([^)]*full_name/i.test(fn));

// The existence oracle.
//
// The body is the last place a student can look, including without devtools —
// any script that can POST can read it — so there is nothing left in it to read.
// These are stronger than the old "every negative branch returns the same
// found:false", because there is no longer a positive branch to leak.
ok("the server sends no reason field at all", !/found: false, reason/.test(fn));
ok("lookup-student has no existence field at all",
  !/\bfound\b/.test(fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
  "lookup-student still mentions `found` in code");
ok("every accepted response is the same constant",
  /const ACCEPTED = \{ ok: true \}/.test(fn)
  && (fn.match(/return json\(req, ACCEPTED\)/g) || []).length >= 3,
  "the uniform response is not used everywhere it must be");
ok("the registry query is still made, so timing does not leak",
  /countStudentsMatching/.test(fn));
// The one thing the count may do is reach the log. It must not reach a response.
ok("the count cannot reach a response body",
  !(fn.match(/return json\([^)]*matched/g) || []).length,
  "the matched count is interpolated into a response");
ok("the count is logged instead, for the operator",
  /console\.log\([^)]*legacy/.test(fn));
ok("the legacy case is logged server-side instead",
  /console\.log\([^)]*legacy/.test(fn));

const client = fs.readFileSync(path.join(ROOT, "supabase", "supabase-client.js"), "utf8");
const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok("the client returns no existence value at all",
  !/\bfound\s*:/.test(clientCode) && !/\.found\b/.test(clientCode),
  "the client is still surfacing an existence field to the page");
ok("the client's lookup resolves to nothing",
  /async lookupRegistrationNumber\(/.test(clientCode)
  && !/return \{[^{}]*found/.test(clientCode));
ok("the client no longer names the legacy case", !/"legacy"/.test(clientCode));
ok("app.js does not branch on a reason", !/result\.reason/.test(appCode));
ok("app.js does not branch on existence", !/\.found\b/.test(appCode));
ok("there is no pre-OTP identity path in the browser",
  !/verifyStudentIdentity/.test(clientCode) && !/confirmPhoneOnFile/.test(appCode));
ok("the OTP step cannot be pointed at another destination",
  !/id="ver_phone"/.test(html) && !/sendOtp\s*\(\s*phone/i.test(clientCode));
ok("the last-name verification is keyed on the registration number",
  /verifyStudent\(verifyMatch\.reg, lastName\)/.test(appCode));

report();

function report() {
  const total = pass + fail;
  if (fail) {
    console.error("FAIL  registration format  (" + fail + "/" + total + " checks failed)");
    failures.forEach((f) => console.error("  x " + f));
    process.exit(1);
  }
  console.log("PASS  registration format  (" + total + " checks)");
}
