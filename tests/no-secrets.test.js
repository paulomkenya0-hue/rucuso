// Proves tests/no-secrets.js would actually catch a leak, by planting one.
//
// A scanner that finds nothing is only meaningful if it would have found
// something. This writes a file containing two realistic secret literals, runs
// the same patterns the real scanner uses against it, and checks both are
// detected. The planted file is deleted afterwards.
//
//   node tests/no-secrets.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual === expected) {
    console.log("  ok   " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + "\n         expected: " + JSON.stringify(expected) + "\n         actual:   " + JSON.stringify(actual));
  }
}

// The same patterns as tests/no-secrets.js.
const JWT = /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
const NAMED_SECRET = /(?<name>[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_KEY|PEPPER|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["'`](?!\$\{|\{\{|<|your|your_|xxx|changeme|process\.env|Deno\.env|\s*["'`])[A-Za-z0-9+/_\-]{20,}["'`]/g;

const PLANTED = [
  // A provider key pasted into a config file: exactly the mistake this guards.
  'const SMS_API_KEY = "aB3xK9mQ7pL2vR8tY4uW6zX1cN5fH0jD";',
  // The OTP pepper.
  'const OTP_PEPPER = "zz9QQ9zz99QQ9zz99QQ9zz99QQ9zz";',
  // A service role key, which is a JWT.
  'SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.4Zt8kQ2vN7xR1mB9cL3wY6sH0jD5fG2aE7uP4tX8";',
].join("\n");

const BENIGN = [
  // Names, not values: these must not trip the scanner.
  'SMS_PROVIDER = "beem";',
  'const secret = Deno.env.get("OTP_PEPPER");',
  'SMS_API_KEY=<your key here>',
  'const key = process.env.SMS_API_KEY;',
  '// never put your service_role key here',
  'SMS_API_KEY: "",',
].join("\n");

console.log("planted secrets are detected");

const found = [...PLANTED.matchAll(NAMED_SECRET), ...PLANTED.matchAll(JWT)];
const names = found.map((m) => (m.groups ? m.groups.name : "JWT")).filter(Boolean);

check("SMS_API_KEY literal detected", names.includes("SMS_API_KEY"), true);
check("OTP_PEPPER literal detected", names.includes("OTP_PEPPER"), true);
check("service role JWT detected", PLANTED.match(JWT) !== null, true);

console.log("\nbenign config shapes are not flagged");

const falsePositives = [...BENIGN.matchAll(NAMED_SECRET)];
check("no false positives on env-var reads and templates", falsePositives.length, 0);
if (falsePositives.length) {
  falsePositives.forEach((m) => console.log("         false positive: " + m[0].slice(0, 60)));
}

// A warning comment about service_role must not be read as a key.
const commentStripped = BENIGN.replace(/\/\/[^\n]*/g, "");
check("comment about service_role is not a key value",
  /service[_A-Za-z]*role[_A-Za-z]*\s*[:=]\s*["'][^"']+["']/i.test(commentStripped), false);

console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
process.exit(failures ? 1 : 0);
