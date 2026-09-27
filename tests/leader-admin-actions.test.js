// Regression tests for the contract between the Super Admin leaders page and
// the leader-admin Edge Function.
//
// The "Kitendo hakijulikani" (UNKNOWN_ACTION) failure was a drift between the
// two sides of one HTTP call: the page sent action strings the function's
// switch did not handle (and vice versa). Nothing stopped a new action being
// added to only one side, so these tests pin the two lists together: every
// action the page can send must have a case in the switch, and every case in
// the switch must be reachable from the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const page = read('admin/leaders/index.html');
const edge = read('supabase/functions/leader-admin/index.ts');

// Actions the page sends to the function (callFunction payloads + row buttons).
function pageActions() {
  const found = new Set();
  // callFunction({ action: "..." }) and the form's create/update payload.
  for (const m of page.matchAll(/action:\s*["']([a-z_]+)["']/gi)) found.add(m[1]);
  // The form picks its action from editingProfileId; capture both branches.
  const branch = page.match(/action:\s*editingProfileId\s*\?\s*["']([a-z_]+)["']\s*:\s*["']([a-z_]+)["']/i);
  if (branch) { found.add(branch[1]); found.add(branch[2]); }
  return found;
}

// Actions the function's switch handles.
function edgeActions() {
  const found = new Set();
  for (const m of edge.matchAll(/case\s+["']([a-z_]+)["']\s*:/gi)) found.add(m[1]);
  return found;
}

test('every action the leaders page sends is handled by the function switch', () => {
  const missing = [...pageActions()].filter((a) => !edgeActions().has(a));
  assert.deepEqual(missing, [], `leader-admin has no case for action(s): ${missing.join(', ')}`);
});

test('every action the function handles is reachable from the page', () => {
  const orphan = [...edgeActions()].filter((a) => !pageActions().has(a));
  assert.deepEqual(orphan, [], `leaders page never sends action(s): ${orphan.join(', ')}`);
});

test('the edit-leader modal submits the update action with a profile_id', () => {
  // The modal's save button is a submit button inside #leaderForm; the
  // submit handler must send action "update" together with the row being
  // edited, or the function cannot find the profile to update.
  assert.match(page, /id="leaderForm"/);
  assert.match(page, /getElementById\("leaderForm"\)/);
  assert.match(page, /editingProfileId\s*\?\s*["']update["']\s*:\s*["']create["']/);
  assert.match(page, /profile_id:\s*editingProfileId/);
  assert.match(edge, /case "update":\s*return await updateLeader/);
  assert.match(edge, /String\(body\.profile_id/);
});

test('the edit button opens the modal in edit mode and sets the editing id', () => {
  assert.match(page, /data-action="edit"/);
  assert.match(page, /async function openEditModal\(profileId\)/);
  assert.match(page, /editingProfileId = profileId/);
  assert.match(page, /dataset\.mode = "edit"/);
});

test('verify-student builds its registration filter through the shared helper', () => {
  // The inline filter did not normalise whitespace, so a pasted
  // "RU / BAFIT / 2024 / 007" was found by lookup-student and then rejected
  // by verify-student. Both must now go through the same regFilter().
  const verify = read('supabase/functions/verify-student/index.ts');
  const shared = read('supabase/functions/_shared/otp.ts');
  assert.match(verify, /regFilter,/);
  assert.match(verify, /\.or\(regFilter\(reg\)\)/);
  assert.match(shared, /export function regFilter\(reg: string\)/);
  assert.doesNotMatch(verify, /registration_number\.ilike\.\$\{reg\.replace/);
});

test('verify-student normalises last names for case, whitespace and Unicode', () => {
  const verify = read('supabase/functions/verify-student/index.ts');
  assert.match(verify, /raw\.normalize\("NFKC"\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(verify, /const stored = normalizeLastName\(data\.last_name\)/);
  assert.match(verify, /stored !== lastName/);
});

// ---------- migration 015: executive RBAC + announcement validation ----------

test('migration 015 grants executive leaders read access to the student directory', () => {
  const sql = read('supabase/migrations/015_executive_rbac_and_announcement_validation.sql');
  // The students select policy must admit is_executive_leader(), not just
  // super_admin / manage_students.
  assert.match(sql, /create policy "authorized read students" on students for select/);
  assert.match(sql, /is_super_admin\(\) or has_permission\('manage_students'\) or is_executive_leader\(\)/);
});

test('migration 015 grants executive leaders announcement publish and edit', () => {
  const sql = read('supabase/migrations/015_executive_rbac_and_announcement_validation.sql');
  assert.match(sql, /create policy "executive publish announcements" on announcements for insert/);
  assert.match(sql, /create policy "executive edit announcements" on announcements for update/);
  // Delete stays with super_admin / manage_announcements — executives may
  // publish and edit, not remove system-wide posts.
  assert.doesNotMatch(sql, /create policy "executive delete announcements"/);
});

test('is_executive_leader() is table-driven and names the five executive posts', () => {
  // The function reads leadership_positions.sees_all_ministries, which
  // migration 013 seeds true for exactly these five posts.
  const sql = read('supabase/migrations/013_leadership_hierarchy.sql');
  for (const key of ['president', 'vice_president', 'prime_minister', 'secretary_general', 'speaker']) {
    assert.match(sql, new RegExp(`\\('${key}'[^)]*true`, 'i'), `${key} should see all ministries`);
  }
});

test('publish_announcement() validates fields server-side and stamps the author', () => {
  const sql = read('supabase/migrations/015_executive_rbac_and_announcement_validation.sql');
  // Required-field and length checks.
  assert.match(sql, /TITLE_REQUIRED/);
  assert.match(sql, /DESCRIPTION_REQUIRED/);
  assert.match(sql, /TITLE_TOO_LONG/);
  assert.match(sql, /DESCRIPTION_TOO_LONG/);
  // Date and URL sanity.
  assert.match(sql, /EXPIRY_BEFORE_PUBLISH/);
  assert.match(sql, /INVALID_IMAGE_URL/);
  // The author comes from auth.uid(), never from the payload.
  assert.match(sql, /auth\.uid\(\)/);
  assert.doesNotMatch(sql, /p_author/);
  // Only signed-in users may call it.
  assert.match(sql, /grant execute on function public\.publish_announcement[^;]*to authenticated/);
});

test('update_announcement() validates fields server-side', () => {
  const sql = read('supabase/migrations/015_executive_rbac_and_announcement_validation.sql');
  assert.match(sql, /create or replace function public\.update_announcement/);
  assert.match(sql, /TITLE_REQUIRED/);
  assert.match(sql, /DESCRIPTION_REQUIRED/);
  assert.match(sql, /EXPIRY_BEFORE_PUBLISH/);
  assert.match(sql, /INVALID_IMAGE_URL/);
  assert.match(sql, /grant execute on function public\.update_announcement[^;]*to authenticated/);
});

// ---------- SECURITY DEFINER authorization guards ----------
//
// Both RPCs are SECURITY DEFINER, so they run as the function owner and bypass
// RLS. That means the table policies are NOT the authorization boundary inside
// them — an explicit check is. Without it, any authenticated user (even a
// plain student) could publish or edit announcements by calling the function
// directly, because `grant execute ... to authenticated` lets them in and
// SECURITY DEFINER carries them past RLS.

test('publish_announcement() has an explicit SECURITY DEFINER authorization guard', () => {
  const sql = read('supabase/migrations/015_executive_rbac_and_announcement_validation.sql');
  // The guard must name all three authorized roles.
  assert.match(sql, /if not \(is_super_admin\(\) or has_permission\('manage_announcements'\) or is_executive_leader\(\)\) then/);
  assert.match(sql, /raise exception 'NOT_AUTHORIZED' using errcode = '42501'/);
  // The guard must appear inside publish_announcement, before the INSERT.
  const pubStart = sql.indexOf('create or replace function public.publish_announcement');
  const pubEnd = sql.indexOf('revoke all on function public.publish_announcement');
  const pubBody = sql.slice(pubStart, pubEnd);
  assert.ok(pubBody.includes('NOT_AUTHORIZED'), 'publish_announcement must contain the NOT_AUTHORIZED guard');
  assert.ok(pubBody.indexOf('NOT_AUTHORIZED') < pubBody.indexOf('insert into announcements'),
    'the authorization guard must run before the INSERT');
});

test('update_announcement() has an explicit SECURITY DEFINER authorization guard', () => {
  const sql = read('supabase/migrations/015_executive_rbac_and_announcement_validation.sql');
  const updStart = sql.indexOf('create or replace function public.update_announcement');
  const updEnd = sql.indexOf('revoke all on function public.update_announcement');
  const updBody = sql.slice(updStart, updEnd);
  assert.ok(updBody.includes('NOT_AUTHORIZED'), 'update_announcement must contain the NOT_AUTHORIZED guard');
  assert.ok(updBody.includes("has_permission('manage_announcements')"),
    'update_announcement must authorize manage_announcements');
  assert.ok(updBody.includes('is_executive_leader()'),
    'update_announcement must authorize executive leaders');
  assert.ok(updBody.indexOf('NOT_AUTHORIZED') < updBody.indexOf('update announcements'),
    'the authorization guard must run before the UPDATE');
});

test('the SECURITY DEFINER guard is the boundary, not RLS, inside both RPCs', () => {
  const sql = read('supabase/migrations/015_executive_rbac_and_announcement_validation.sql');
  // Both functions must be SECURITY DEFINER (which is why the guard is needed).
  assert.match(sql, /create or replace function public\.publish_announcement[\s\S]*?security definer/);
  assert.match(sql, /create or replace function public\.update_announcement[\s\S]*?security definer/);
  // The grant is to authenticated — so without the in-body guard, any signed-in
  // user could call these. The guard is what restricts them.
  assert.match(sql, /grant execute on function public\.publish_announcement[^;]*to authenticated/);
  assert.match(sql, /grant execute on function public\.update_announcement[^;]*to authenticated/);
});

test('the admin announcements page writes through the validated RPCs', () => {
  const page = read('admin/announcements/index.html');
  const client = read('supabase/supabase-client.js');
  // The page must call the validated RPCs, not a bare insert/update.
  assert.match(page, /publishAnnouncement/);
  assert.match(page, /updateAnnouncementValidated/);
  assert.doesNotMatch(page, /RucusoAPI\.createAnnouncement|RucusoAPI\.updateAnnouncement\b/);
  // The client must expose them.
  assert.match(client, /async publishAnnouncement\(payload\)/);
  assert.match(client, /async updateAnnouncementValidated\(id, payload\)/);
  assert.match(client, /rpc\("publish_announcement"/);
  assert.match(client, /rpc\("update_announcement"/);
});

test('the leader dashboard exposes students and announcements to executives only', () => {
  const page = read('leader/dashboard/index.html');
  // Executive-only modules exist and are gated.
  assert.match(page, /id="studentsModule"/);
  assert.match(page, /id="announcementsModule"/);
  assert.match(page, /exec-only/);
  assert.match(page, /isExecutiveLeader\(session\.profile\)/);
  // Publishing goes through the validated RPC.
  assert.match(page, /publishAnnouncement/);
  // Students are read through the table RLS now admits.
  assert.match(page, /from\("students"\)/);
});
