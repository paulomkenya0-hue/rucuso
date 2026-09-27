// RUCUSO — element wiring check
//
// The new enhancement modules look their targets up by string id. A typo there
// is a silent no-op: no error, no warning, the feature simply never appears and
// nothing in the test suite notices. This walks the source for those lookups
// and checks each one against index.html.
//
// Run: node tests/wiring.check.js
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const MODULES = ["js/verify-ux.js", "js/map.js", "js/tilt.js"];

// Classes the new modules attach to, which have to be styled somewhere.
// Classes that must be styled because markup or JS depends on them. Kept in
// step with what the verify view actually renders: the character counter, the
// support-link row and the on-demand format reveal have all been removed, so
// requiring them here would only keep dead CSS alive.
const NEEDS_STYLE = [".tilt", ".btn__spin", ".mapcard", ".ratelimit", ".vercaptcha", ".fhint"];

let problems = 0;
const seen = new Set();

for (const rel of MODULES) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");

  const ids = new Set();
  for (const m of src.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/querySelector\(\s*["']#([\w-]+)["']\s*\)/g)) ids.add(m[1]);

  for (const id of ids) {
    const key = rel + "#" + id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (html.includes('id="' + id + '"')) {
      console.log("  ok   " + rel + "  #" + id);
    } else {
      problems++;
      console.log("  FAIL " + rel + "  #" + id + "  (no such id in index.html)");
    }
  }
}

// Every new class has to have a rule, or it silently does nothing.
const css = fs.readFileSync(path.join(ROOT, "css", "motion.css"), "utf8");
for (const cls of NEEDS_STYLE) {
  if (new RegExp("\\" + cls + "(?![\\w-])").test(css)) {
    console.log("  ok   css/motion.css styles " + cls);
  } else {
    problems++;
    console.log("  FAIL css/motion.css has no rule for " + cls);
  }
}

// The stylesheet and the scripts actually have to be referenced by the page.
const LINKS = [
  ["css/motion.css", /<link[^>]+href="css\/motion\.css"/],
  ["js/verify-ux.js", /<script[^>]+src="js\/verify-ux\.js"/],
  ["js/tilt.js", /<script[^>]+src="js\/tilt\.js"/],
  ["js/map.js", /<script[^>]+src="js\/map\.js"/],
];
for (const [what, re] of LINKS) {
  if (re.test(html)) console.log("  ok   index.html loads " + what);
  else { problems++; console.log("  FAIL index.html never loads " + what); }
}

// Load order matters: the new modules read globals the earlier scripts define.
// map.js and verify-ux.js both touch window.RUCUSO_CONFIG / window.RucusoData at
// DOMContentLoaded, but data.js and config.js must already be parsed by then.
const order = (f) => {
  const m = html.match(new RegExp('<script[^>]+src="' + f.replace(/[.\/]/g, "\\$&") + '"'));
  return m ? html.indexOf(m[0]) : -1;
};
const seq = ["supabase/config.js", "supabase/supabase-client.js", "js/data.js", "js/app.js", "js/verify-ux.js", "js/tilt.js", "js/map.js"];
const positions = seq.map(order);
const monotonic = positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]));
if (monotonic) console.log("  ok   script load order is correct");
else { problems++; console.log("  FAIL script load order is wrong: " + JSON.stringify(seq.map((f, i) => f + "=" + positions[i]))); }

if (problems) {
  console.error("\nFAIL  wiring  (" + problems + " problems)");
  process.exit(1);
}
console.log("\nall wiring checks passed");
