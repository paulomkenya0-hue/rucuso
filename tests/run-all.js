// Runs every check in this directory and reports one summary.
//
//   node tests/run-all.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = __dirname;

const suites = fs.readdirSync(DIR)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

let failed = 0;
const results = [];

for (const f of suites) {
  console.log("\n" + "=".repeat(60));
  console.log("  " + f);
  console.log("=".repeat(60));
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ suite: f, ok });
}

// The JS the browser actually loads must parse, including the inline scripts in
// the HTML pages. This is separate from the suites above because a syntax error
// there breaks the site in a way none of the behavioural tests would notice.
console.log("\n" + "=".repeat(60));
console.log("  syntax");
console.log("=".repeat(60));

const standalone = ["js/app.js", "js/data.js", "supabase/supabase-client.js", "js/auth-guard.js", "js/config.js"];
const os = require("os");
let syntaxFailures = 0;

for (const f of standalone) {
  const p = path.join(DIR, "..", f);
  if (!fs.existsSync(p)) { console.log("  skip " + f + " (not present)"); continue; }
  const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
  const ok = r.status === 0;
  if (!ok) { syntaxFailures++; console.log("  FAIL " + f + "\n" + (r.stderr || "").slice(0, 400)); }
  else console.log("  ok   " + f);
}

const root = path.join(DIR, "..");
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) {
      const t = fs.readFileSync(p, "utf8");
      let i = 0;
      for (const m of t.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        i++;
        if (!m[1].trim()) continue;
        const tmp = path.join(os.tmpdir(), "inline-" + process.pid + "-" + i + ".js");
        fs.writeFileSync(tmp, m[1]);
        const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
        fs.unlinkSync(tmp);
        const rel = path.relative(root, p);
        if (r.status !== 0) {
          syntaxFailures++;
          console.log("  FAIL " + rel + " inline block " + i + "\n" + (r.stderr || "").slice(0, 400));
        }
      }
      if (i) console.log("  ok   " + path.relative(root, p) + " (" + i + " inline script block" + (i === 1 ? "" : "s") + ")");
    }
  }
})(root);

results.push({ suite: "syntax", ok: syntaxFailures === 0 });
if (syntaxFailures) failed++;

// A credential-shaped literal anywhere in the tree. This runs last because if it
// finds something, the other results are still worth reading but nothing should
// be pushed.
console.log("\n" + "=".repeat(60));
console.log("  secrets");
console.log("=".repeat(60));
const secretRun = spawnSync(process.execPath, [path.join(DIR, "no-secrets.js")], { encoding: "utf8" });
process.stdout.write((secretRun.stdout || "") + (secretRun.stderr || ""));
const secretsOk = secretRun.status === 0;
if (!secretsOk) failed++;
results.push({ suite: "secrets", ok: secretsOk });

console.log("\n" + "=".repeat(60));
console.log("  summary");
console.log("=".repeat(60));
for (const r of results) console.log("  " + (r.ok ? "PASS" : "FAIL") + "  " + r.suite);
console.log("\n" + (failed ? failed + " suite(s) FAILED" : "all " + results.length + " suites passed"));
process.exit(failed ? 1 : 0);
