const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("HESLB database authorization explicitly allows Super Admin and scopes ministry roles", () => {
  const sql = read("supabase/migrations/009_heslb_access_and_year_stats.sql");
  assert.match(sql, /p\.role\s*=\s*'super_admin'/);
  assert.match(sql, /p\.role\s+in\s*\('leader',\s*'admin'\)/);
  assert.match(sql, /manage_heslb_beneficiaries/);
  assert.match(sql, /p\.ministry_id/);
  assert.match(sql, /mikoponauwezeshaji/);
  assert.match(sql, /loansandempowerment/);
});

test("HESLB records have no anonymous read grant and all row operations are RLS-gated", () => {
  const sql = read("supabase/migrations/008_heslb_beneficiaries.sql");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.heslb_beneficiaries from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update on public\.heslb_beneficiaries to authenticated/i);
  assert.match(sql, /for select to authenticated using \(public\.is_heslb_manager\(\)\)/i);
  assert.match(sql, /for insert to authenticated with check \(public\.is_heslb_manager\(\)\)/i);
  assert.match(sql, /for update to authenticated[\s\S]*using \(public\.is_heslb_manager\(\)\)/i);
  assert.doesNotMatch(sql, /for delete to authenticated/i);
});

test("public HESLB verifier returns only a boolean and selects no beneficiary details", () => {
  const edge = read("supabase/functions/verify-heslb/index.ts");
  assert.match(edge, /\.select\("index_number"\)/);
  assert.match(edge, /return json\(req, \{ verified: !!data \}\)/);
  assert.doesNotMatch(edge, /select\("\*"\)|full_name|faculty|year_of_study/);
});

// The ten posts used to be listed by hand in three places: migration 010's
// CHECK, the POSITIONS array in leader-admin, and SINGULAR_POSITIONS in
// js/data.js. Migration 013 makes leadership_positions the single source of
// truth and profiles.position a foreign key into it, so the hand-written copies
// are gone and the test now checks that they stay gone.
test("leadership positions have a single source of truth", () => {
  const sql10 = read("supabase/migrations/010_executive_leadership_positions.sql");
  const sql13 = read("supabase/migrations/013_leadership_hierarchy.sql");
  const edge = read("supabase/functions/leader-admin/index.ts");
  const data = read("js/data.js");

  // Migration 010's CHECK is superseded by the foreign key in 013.
  assert.match(sql13, /foreign key \(position\) references public\.leadership_positions\(key\)/);
  assert.match(sql13, /drop constraint if exists profiles_position_check/);
  assert.ok(sql10.includes("profiles_position_check"));

  // Every post migration 010 allowed is seeded, so applying 013 cannot orphan a
  // position that already exists in the database.
  for (const role of [
    "president", "vice_president", "secretary_general", "prime_minister",
    "prime_minister_secretary", "deputy_secretary_general", "minister",
    "deputy_minister", "representative", "officer",
  ]) {
    assert.ok(sql10.includes(`'${role}'`), `${role} missing from migration 010`);
    assert.ok(sql13.includes(`'${role}'`), `${role} not seeded in migration 013`);
  }

  // The hand-written copies must not come back: a second list of posts is
  // exactly the drift that made vice_president missing from is_executive_leader().
  // Only code is checked, so the comments that explain the removal still match.
  const edgeCode = edge.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(edgeCode, /\bPOSITIONS\s*=\s*\[/);
  assert.doesNotMatch(edgeCode, /STANDALONE_POSITIONS/);
  assert.doesNotMatch(data, /SINGULAR_POSITIONS/);
  assert.doesNotMatch(data, /MINISTRY_ROLES/);

  // And the function must validate against the table instead.
  assert.match(edge, /from\("leadership_positions"\)/);
  assert.match(edge, /from\("leadership_tiers"\)/);
  assert.match(edge, /case "list"/);
});
