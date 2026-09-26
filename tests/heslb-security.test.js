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

test("executive leadership positions are supported in storage and server creation", () => {
  const sql = read("supabase/migrations/010_executive_leadership_positions.sql");
  const edge = read("supabase/functions/leader-admin/index.ts");
  const data = read("js/data.js");
  for (const role of ["president", "vice_president", "secretary_general", "prime_minister", "prime_minister_secretary"]) {
    assert.ok(sql.includes(`'${role}'`));
    assert.ok(edge.includes(`"${role}"`));
    assert.ok(data.includes(`"${role}"`));
  }
});
