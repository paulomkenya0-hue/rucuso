// Checks every local asset reference in every HTML page resolves, and that each
// page declares a favicon.
//
// Catches the two failure modes that are invisible in a browser until someone
// loads the page: a path that does not exist on disk, and a favicon link added to
// some pages but not others.
//
//   node tests/assets.test.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

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

const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) htmlFiles.push(p);
  }
})(ROOT);

htmlFiles.sort();

const missingRefs = [];
const missingFavicon = [];
let refCount = 0;

for (const f of htmlFiles) {
  const rel = path.relative(ROOT, f);
  const t = fs.readFileSync(f, "utf8");

  if (!/rel="icon"/i.test(t)) missingFavicon.push(rel);

  const seen = new Set();
  for (const m of t.matchAll(/(?:src|href)="([^"]+)"/g)) {
    let u = m[1];
    if (/^(https?:|mailto:|tel:|#|data:|javascript:)/i.test(u)) continue;
    u = u.split("#")[0].split("?")[0];
    if (!u) continue;
    // Root-relative paths are served from the site root, which is ROOT here.
    const abs = u.startsWith("/") ? path.join(ROOT, u.slice(1)) : path.join(path.dirname(f), u);
    const key = path.resolve(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    refCount++;
    if (!fs.existsSync(key)) missingRefs.push(rel + " -> " + u);
  }
}

console.log("checked " + htmlFiles.length + " HTML pages, " + refCount + " distinct local references\n");

check("every page declares a favicon", missingFavicon.length, 0);
if (missingFavicon.length) missingFavicon.forEach((p) => console.log("         no favicon: " + p));

check("every local reference resolves", missingRefs.length, 0);
if (missingRefs.length) missingRefs.forEach((p) => console.log("         missing:   " + p));

// The favicon files themselves must exist and not be empty: a zero-byte
// favicon.ico resolves fine but renders as nothing.
for (const f of ["favicon.ico", "assets/favicon-32.png", "assets/apple-touch-icon.png", "assets/ruc-logo.png"]) {
  const p = path.join(ROOT, f);
  const ok = fs.existsSync(p) && fs.statSync(p).size > 0;
  check(f + " exists and is not empty", ok, true);
}

// A .ico must start with the reserved 00 00 01 00 header.
const ico = path.join(ROOT, "favicon.ico");
if (fs.existsSync(ico)) {
  const head = Array.from(fs.readFileSync(ico).slice(0, 4));
  check("favicon.ico has a valid ICO header", head.join(","), "0,0,1,0");
}

// PNGs must carry the PNG signature. Compared as a string because
// 0x89 and friends are typed as negative numbers by a Buffer iterator.
for (const f of ["assets/favicon-32.png", "assets/apple-touch-icon.png", "assets/ruc-logo.png"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const sig = Array.from(fs.readFileSync(p).slice(0, 8), (b) => (b < 0 ? b + 256 : b));
  check(f + " has a valid PNG signature", sig.join(","), "137,80,78,71,13,10,26,10");
}

console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
process.exit(failures ? 1 : 0);
