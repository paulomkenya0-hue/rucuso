// Prints the shape of the values in the config file without printing the values,
// so it is safe to run and safe to paste the output anywhere.
//
// The anon / publishable key is designed to be public and is committed on
// purpose. A service role key is not, and must never appear in a committed file.
//
//   node tests/show-config.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

for (const rel of ["supabase/config.js", "js/config.js", "js/config.example.js"]) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log(rel + "  (not present)");
    continue;
  }
  const t = fs.readFileSync(p, "utf8");

  const pairs = [...t.matchAll(/([A-Za-z0-9_]+)\s*:\s*["']([^"']*)["']/g)]
    .filter((m) => /key|url|token|secret|pepper/i.test(m[1]));

  console.log("=== " + rel + " ===");
  if (!pairs.length) console.log("  (no key/url/secret-shaped values found)");
  for (const [, name, value] of pairs) {
    const isJwt = /^eyJ[A-Za-z0-9_-]{20,}\./.test(value);
    console.log(
      "  " + name.padEnd(22) +
      " " + String(value.length).padStart(4) + " chars" +
      (isJwt ? "  (JWT-shaped)" : ""),
    );
  }

  // A comment saying "never put your service_role key here" is the file warning
  // against exactly this, not a leak. Only a real value counts, so comments and
  // string literals are stripped before looking.
  const code = t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const serviceRoleValue = /service[_A-Za-z]*role[_A-Za-z]*\s*[:=]\s*["'][^"']+["']/i.test(code);
  console.log("  service role key value: " + (serviceRoleValue ? "PRESENT — must not be committed" : "absent"));
  console.log("");
}
