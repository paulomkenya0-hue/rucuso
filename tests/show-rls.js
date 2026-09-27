// Reads migration 013 and reports the RLS objects it declares, so the policies
// and the grants can be compared by eye without launching psql.
//
//   node tests/show-rls.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MIG = path.join(ROOT, "supabase/migrations");

const files = fs.existsSync(path.join(MIG, "013_leadership_hierarchy.sql"))
  ? ["013_leadership_hierarchy.sql"]
  : fs.readdirSync(MIG).filter((f) => f.includes("leadership_hierarchy"));

for (const f of files) {
  const sql = fs.readFileSync(path.join(MIG, f), "utf8");
  console.log("=== " + f + " ===\n");

  const rls = [...sql.matchAll(/alter table public\.([a-z0-9_]+) enable row level security/gi)];
  console.log("RLS enabled on:");
  rls.forEach((m) => console.log("  " + m[1]));

  const policies = [...sql.matchAll(
    /create policy\s+"([^"]+)"\s+on\s+public\.([a-z0-9_]+)\s+for\s+([a-z]+)\s*([\s\S]{0,120}?);/gi,
  )];
  console.log("\npolicies (" + policies.length + "):");
  policies.forEach((m) => {
    const body = m[4].replace(/\s+/g, " ").trim();
    console.log("  " + m[2] + "  [" + m[3] + "]  " + m[1] + "\n      " + body);
  });

  const grants = [...sql.matchAll(
    /grant\s+([a-z, ]+?)\s+on\s+(?:table\s+|function\s+)?public\.([a-z0-9_]+)\s*(?:\([^)]*\))?\s+to\s+([a-z_, ]+?);/gi,
  )];
  console.log("\ngrants (" + grants.length + "):");
  grants.forEach((m) => {
    console.log("  " + m[2] + ": " + m[1].trim() + "  ->  " + m[3].trim());
  });

  const revokes = [...sql.matchAll(/revoke[^;]*;/gi)];
  if (revokes.length) {
    console.log("\nrevokes:");
    revokes.forEach((m) => console.log("  " + m[0].replace(/\s+/g, " ").trim()));
  }

  // Every RLS-enabled table needs at least one policy, otherwise the grants
  // below are dead letters: with RLS on and no policy, every row is invisible.
  console.log("\ntables with RLS but no policy:");
  const withPolicy = new Set(policies.map((m) => m[2]));
  let missing = 0;
  rls.forEach((m) => {
    if (!withPolicy.has(m[1])) {
      console.log("  " + m[1]);
      missing++;
    }
  });
  if (!missing) console.log("  (none)");
}
