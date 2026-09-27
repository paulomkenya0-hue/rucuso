// Scans the working tree for anything that looks like a real credential, so a
// secret cannot reach GitHub by being pasted into a config file or a comment.
//
// This looks for the shape of a leak, not for the words: a long opaque literal
// assigned to a name that suggests a key, a JWT, or a Supabase service-role key.
// Deno/Supabase secret *names* (SMS_API_KEY, OTP_PEPPER and so on) are fine and
// expected in docs and code; values are not.
//
//   node tests/no-secrets.js

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist"]);

// A JWT: three base64url segments starting with the header prefix "eyJ". A
// Supabase service role key is one of these.
const JWT = /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
// Also flag a bare long literal assigned to a key-ish name, which is how a
// provider secret would usually be pasted in by mistake.
const NAMED_SECRET = /(?<name>[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_KEY|PEPPER|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["'`](?!\$\{|\{\{|<|your|your_|xxx|changeme|process\.env|Deno\.env|\s*["'`])[A-Za-z0-9+/_\-]{20,}["'`]/g;
// A config file that pairs a project URL with a long key value.
const CONFIG_WITH_KEY = /supabaseUrl\s*:\s*["']https:\/\/[a-z0-9]+\.supabase\.co["'][\s\S]{0,400}?(anon|publishable|service)Key\s*:\s*["'](eyJ|[A-Za-z0-9]{40})/gi;

const findings = [];
let scanned = 0;

function scan(label, text) {
  scanned++;
  for (const re of [JWT, NAMED_SECRET]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({
        file: label,
        line,
        kind: re === JWT ? "JWT-shaped literal" : "value assigned to " + (m.groups ? m.groups.name : "a secret-looking name"),
        // Never print the value itself.
        preview: String(m[0]).slice(0, 24) + "...",
      });
    }
  }
  CONFIG_WITH_KEY.lastIndex = 0;
  let c;
  while ((c = CONFIG_WITH_KEY.exec(text))) {
    const line = text.slice(0, c.index).split("\n").length;
    findings.push({ file: label, line, kind: "config file with a real key value", preview: "..." });
  }
}

// This file's own test plants fake credentials to prove the scanner works, so
// scanning it would always report those. Excluded, and the exclusion is reported
// rather than hidden.
// Normalised to forward slashes: the walk below produces forward slashes, while
// path.relative produces backslashes on Windows, and comparing the two silently
// failed to match.
const slash = (p) => p.split(path.sep).join("/");
const skip = new Set([
  slash(path.relative(ROOT, __filename)),
  slash(path.relative(ROOT, path.join(__dirname, "no-secrets.test.js"))),
]);

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|ts|html|css|json|md|txt|sql|yml|yaml|toml)$/.test(e.name)) {
      const rel = slash(path.relative(ROOT, p));
      // config.example.js is a template and is meant to be committed.
      if (e.name === "config.example.js") continue;
      if (skip.has(rel)) continue;
      scan(rel, fs.readFileSync(p, "utf8"));
    }
  }
})(ROOT);

if (skip.size) {
  console.log("  note  skipping " + [...skip].join(", ") + " (planted test credentials)");
}

// .env files, if any exist, must not be tracked.
let envTracked = [];
try {
  const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" });
  envTracked = tracked.split("\n").filter((f) => /(^|\/)\.env|\.env\./.test(f));
} catch (_) { /* not a git repo, or git unavailable */ }

console.log("scanned " + scanned + " files for credentials\n");

if (envTracked.length) {
  findings.push({ file: envTracked.join(", "), line: 0, kind: "a .env file is tracked by git", preview: "" });
} else {
  console.log("  ok   no .env file is tracked by git");
}

// The committed config file is the real risk. The anon / publishable key in it is
// designed to be public; a service-role key would not be.
//
// Comments are stripped first: supabase/config.js contains a comment reading
// "Never put your service_role key here", and matching that would report a
// warning that is actually the file doing its job.
for (const rel of ["supabase/config.js", "js/config.js"]) {
  const cfg = path.join(ROOT, rel);
  if (!fs.existsSync(cfg)) continue;
  const code = fs.readFileSync(cfg, "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (/service[_A-Za-z]*role[_A-Za-z]*\s*[:=]\s*["'][^"']+["']/i.test(code)) {
    console.log("  FAIL " + rel + " contains a service role key value");
    findings.push({ file: rel, line: 0, kind: "service role key in a committed config", preview: "" });
  } else {
    console.log("  ok   " + rel + " carries no service role key");
  }
}

if (findings.length) {
  console.log("\nPOTENTIAL SECRETS:");
  for (const f of findings) {
    console.log("  " + f.file + (f.line ? ":" + f.line : "") + "  " + f.kind + (f.preview ? "  " + f.preview : ""));
  }
  console.log("\nIf any of these are real, rotate them before pushing.");
  process.exit(1);
} else {
  console.log("  ok   no credential-shaped literals found");
  console.log("\nno secrets found");
}
