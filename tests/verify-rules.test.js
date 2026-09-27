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
  // Inverted form: the button is enabled only when all three hold. Matching
  // either "ready = a && b && c" or "disabled = !(a && b && c)" accepts both
  // the current code and a refactor that keeps the same gate.
  "the gate is regex AND captcha, not either",
  /var ready = result\.ok && left > 0 && captchaOk/.test(src)
  || /disabled = !\(result\.ok && left > 0 && captchaOk\)/.test(src),
  "setButtonState does not combine all three conditions",
);
ok(
  "an unconfigured CAPTCHA does not disable the button forever",
  /if \(!isCaptchaEnabled\(\)\) return true/.test(src),
  "with no site key the button could never enable",
);
ok("solving the CAPTCHA re-runs the gate", /callback: function \(token\) \{[\s\S]{0,400}setButtonState/.test(src));
ok("an expired CAPTCHA re-closes the gate", /expired-callback[\s\S]{0,120}setButtonState/.test(src));
ok("the guard re-checks the captcha, not just the button", /if \(!captchaSatisfied\(\)\)/.test(src));

// ---- helper text: must NOT leak the format --------------------------------
// The format and a live character counter together are an oracle: they tell a
// script the right length and the right general shape before it sends a single
// request. Both were removed, so both are asserted absent.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const verifyView = html.slice(html.indexOf('id="view-verify"'), html.indexOf('id="view-submit"'));

ok("the character counter is gone", !/id="ver1_counter"/.test(html));
ok("nothing renders a character counter", !/fcounter/.test(js) && !/fcounter/.test(html));
ok("the placeholder states no format", !/placeholder="[^"]*RU\//i.test(verifyView));
ok("the neutral instruction is present",
  /Andika Namba yako rasmi ya Usajili iliyotolewa na chuo/.test(verifyView));

// The format may still be available, but only behind a deliberate click.
ok("the format example is hidden in the served HTML",
  /id="ver1_example"[^>]*\bhidden\b/.test(verifyView));
ok("there is a control that reveals it", /id="ver1_reveal"/.test(verifyView));
ok("the reveal control is wired", /data-action="reveal-format"/.test(verifyView));
ok("the reveal is accessible",
  /aria-expanded="false"[^>]*aria-controls="ver1_example"/.test(verifyView));

// ---- no success oracle -----------------------------------------------------
// "that looks right" is as much a leak as the format itself.
ok("no success confirmation is shown for a valid number",
  !/Namba inaonekana sahihi/.test(js) && !/Namba inaonekana sahihi/.test(html));
ok("the hint never confirms correctness", !/fhint--ok/.test(js));

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

// ---- the contradictory pair ------------------------------------------------
// The reported bug: "Namba inaonekana sahihi" next to "Huduma ya kuangalia namba
// ya usajili haijawekwa bando". One is gone; the other must render in the same
// place as every other error rather than being appended alongside.
ok("the catch block is the single place server errors are rendered",
  /const text = await functionErrorText\(e\);\s*msg\.innerHTML/.test(appJs),
  "errors are still rendered from more than one place");
ok("a misconfigured backend is logged for the operator, not the student",
  /NOT_CONFIGURED/.test(appJs) && /console\.error/.test(appJs));

// ---- spinner ---------------------------------------------------------------
ok("the button has a spinner element", /id="ver1_btn"[\s\S]{0,200}btn__spin/.test(verifyView));
ok("busy() preserves the spinner markup", /querySelector\("\.btn__label"\)/.test(appJs));
ok("there is a minimum visible spinner duration", /MIN_SPIN_MS/.test(appJs));

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
const fn = fs.readFileSync(
  path.join(ROOT, "supabase", "functions", "lookup-student", "index.ts"), "utf8");
ok("the server enforces the same current format", /\^RU\\\/\[A-Z\]\{2,6\}\\\/\\d\{4\}\\\/\\d\{3,4\}\$/i.test(fn));
ok("the server rejects malformed input before spending rate-limit budget",
  fn.indexOf("CURRENT_RE.test") < fn.indexOf("consume_student_lookup_attempt"));
ok("the legacy switch still exists for deployments that want it off",
  /MIGRATION_LEGACY_LOOKUP/.test(fn));
ok("the server never returns a student column", !/select\([^)]*full_name/i.test(fn));

// The body is the last place a student can look, including without devtools —
// any script that can POST can read it. Every negative branch must therefore be
// the same { found:false }, with the reason kept in the server log.
ok("the server sends no reason field at all", !/found: false, reason/.test(fn));
ok("the legacy branch returns a bare found:false",
  /allowLegacy\) \{[\s\S]{0,200}return json\(req, \{ found: false \}\)/.test(fn));
ok("the legacy case is logged server-side instead",
  /console\.log\([^)]*legacy/.test(fn));
ok("the not-found branch returns a bare found:false too",
  /if \(!found\) \{[\s\S]{0,120}return json\(req, \{ found: false \}\)/.test(fn));

const client = fs.readFileSync(path.join(ROOT, "supabase", "supabase-client.js"), "utf8");
ok("the client returns found and nothing else",
  /return \{ found: !!\(data && data\.found === true\) \}/.test(client),
  "the client is still surfacing a second field to the page");
ok("the client no longer names the legacy case", !/"legacy"/.test(client));
ok("app.js does not branch on a reason", !/result\.reason/.test(appJs));

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
