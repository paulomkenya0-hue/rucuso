#!/usr/bin/env node
// RUCUSO — verification input rules
//
// The registration-number check in js/verify-ux.js is the one piece of this
// work that can actually hurt someone. Everything else degrades to "less pretty
// page". This one can refuse to let a registered student through, and the only
// symptom they would see is a button that stays greyed out.
//
// So the rule is tested against real formats, not the one the spec suggested.
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
// cannot simply be required. The regex is read out of the source and re-run
// here, which is deliberate: if someone changes the rule, this test has to fail.
const src = fs.readFileSync(path.join(ROOT, "js", "verify-ux.js"), "utf8");

const match = src.match(/var RE = (\/.*?\/[a-z]*);/);
ok("RE is declared in verify-ux.js", !!match, "no RE found");
if (!match) {
  report();
  process.exit(1);
}
const RE = eval(match[1]); // eslint-disable-line no-eval -- parsing our own source

// Same normalisation the module applies before testing.
const norm = (raw) =>
  String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, " ");

// ---- must ACCEPT ----------------------------------------------------------
// The important column. The database enforces no format at all, and these are
// the formats that appear in this repo's own UI.
const accept = [
  ["RUCU/2024/0456", "the bulk-import example from index.html"],
  ["RUCU/2024/01", "the original input placeholder"],
  ["RUCU/23/01", "two-digit year, as written in the hierarchy test fixtures"],
  ["RUCU/2023/1234", "four-digit index"],
  ["BFC/23/001", "a different faculty prefix"],
  ["RUCU/2024/1", "single-digit index"],
  ["rucu/2024/0456", "lower case — must normalise, the server matches case-insensitively"],
  ["  RUCU/2024/0456  ", "surrounding whitespace from a paste"],
  ["RUCU / 2024 / 0456", "spaces around the slashes"],
  ["RUCU/1999/9", "shortest plausible number"],
  ["RU/2024/0456", "two-letter prefix — accepted on purpose, see below"],
];

// A deliberately-strict-looking rule is the failure mode this file exists to
// prevent. A prefix nobody has ever seen is a far smaller problem than a
// registered student who cannot get in, so anything that is structurally a
// registration number is let through and resolved by the server.
for (const [value, why] of accept) {
  ok("accepts " + JSON.stringify(value) + " (" + why + ")", RE.test(norm(value)));
}

// ---- must REJECT ----------------------------------------------------------
// Genuinely malformed input, where a student has made a real mistake and a
// message telling them so is more useful than a round trip to the database.
const reject = [
  ["", "empty"],
  ["RUCU", "no separators"],
  ["RUCU/2024", "one separator only"],
  ["2024/0456", "no prefix letters"],
  ["RUCU/ABCD/01", "non-numeric year"],
  ["RUCU/2024/EFGH", "non-numeric index"],
  ["12345", "digits only"],
  ["RUCU-2024-0456", "wrong separator"],
  ["RUCU 2024 0456", "no separators at all"],
  ["RUCU/2024/0456/9", "one separator too many"],
  ["RUCU////0456", "empty segments"],
  ["RUCU/2024/012345678", "index far too long"],
];

for (const [value, why] of reject) {
  ok("rejects " + JSON.stringify(value) + " (" + why + ")", !RE.test(norm(value)));
}

// ---- the length ceiling ----------------------------------------------------
// Length is checked before the pattern, so a pathological paste can never become
// a rate-limit key or a query string.
const MAX_LEN = 24;
ok(
  "the longest real number is under the ceiling",
  norm("RUCU/2024/0456").length <= MAX_LEN,
  norm("RUCU/2024/0456").length + " > " + MAX_LEN,
);

// ---- attempt budget --------------------------------------------------------
// A real student who fat-fingers a number should not be locked out; a script
// should not get far. The window has to be a minute and the count small but
// survivable.
ok("attempt limit is small enough to matter", /MAX_ATTEMPTS = 5\b/.test(src));
ok("attempt window is one minute", /WINDOW_MS = 60_000\b/.test(src));
ok("attempts are stored per-session, not persistent", /sessionStorage/.test(src));
ok(
  "an in-memory fallback exists for blocked storage",
  /catch\s*\(_\)\s*\{[\s\S]{0,200}return null/.test(src),
  "private-mode path not found",
);

// ---- the rule must not be duplicated ---------------------------------------
// Two copies of a validation rule will drift, and the copy that drifts is the
// one that quietly starts rejecting real students.
const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
ok(
  "app.js defers to the shared rule instead of keeping its own",
  /window\.RucusoVerify\.validate/.test(appJs) && !/reg\.match\(\/\^/.test(appJs),
  "app.js appears to have its own pattern",
);

// ---- the button must actually be wired -------------------------------------
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
ok("the submit button carries an id for the guard to find", /id="ver1_btn"/.test(html));
ok("the registration input has a live counter", /id="ver1_counter"/.test(html));
ok("the rate-limit banner exists", /id="ver1_limit"/.test(html));
ok("a CAPTCHA mount point exists", /id="verCaptcha"/.test(html));
ok(
  "the button wraps its text in .btn__label so busy() can restore it",
  /btn__label/.test(html),
);

// ---- CAPTCHA must not be a browser-only checkbox ---------------------------
// The real check is that the token is verified on the server. A widget that
// renders and is never checked is security theatre.
const fnSrc = fs.readFileSync(
  path.join(ROOT, "supabase", "functions", "lookup-student", "index.ts"),
  "utf8",
);
ok("the token is verified server-side", /siteverify/.test(fnSrc));
ok("the server holds the secret, not the browser", /TURNSTILE_SECRET_KEY/.test(fnSrc));
ok("the token is checked before the rate-limit counters are spent",
  fnSrc.indexOf("verifyTurnstile") < fnSrc.indexOf("consume_student_lookup_attempt"));
ok("the site key lives in front-end config, which is correct for Turnstile",
  /TURNSTILE_SITE_KEY/.test(fs.readFileSync(path.join(ROOT, "supabase", "config.js"), "utf8")));
ok("no Turnstile secret was committed to the front-end config",
  !/TURNSTILE_SECRET_KEY["']?\s*:\s*["'][^"']+/.test(
    fs.readFileSync(path.join(ROOT, "supabase", "config.js"), "utf8")));

report();

function report() {
  const total = pass + fail;
  if (fail) {
    console.error("FAIL  verification rules  (" + fail + "/" + total + " checks failed)");
    failures.forEach((f) => console.error("  x " + f));
    process.exit(1);
  }
  console.log("PASS  verification rules  (" + total + " checks)");
}
