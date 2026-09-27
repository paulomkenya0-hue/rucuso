const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('top leadership positions include the full executive set and speaker', () => {
  const sql = read('supabase/migrations/013_leadership_hierarchy.sql');
  const names = ['president', 'vice_president', 'prime_minister', 'secretary_general', 'speaker'];
  for (const key of names) {
    assert.match(sql, new RegExp(`\\('${key}'`, 'i'));
  }
  assert.match(sql, /sees_all_ministries.*true/i);
});

test('authorization treats speaker as top leadership', () => {
  const sql = read('supabase/migrations/013_leadership_hierarchy.sql');
  const edge = read('supabase/functions/leader-admin/index.ts');
  assert.match(sql, /'speaker'/i);
  assert.match(sql, /speaker.*executive/i);
  assert.match(edge, /email_confirm:\s*true/i);
  assert.doesNotMatch(edge, /kiungo cha kuthibitisha barua pepe|confirmation email/i);
});

test('leader creation success message no longer promises email confirmation', () => {
  const page = read('admin/leaders/index.html');
  assert.doesNotMatch(page, /kiungo cha kuthibitisha barua pepe|confirmation email/i);
});

test('super admin can edit an existing leader from the admin page', () => {
  const edge = read('supabase/functions/leader-admin/index.ts');
  const page = read('admin/leaders/index.html');
  assert.match(edge, /case "update"/);
  assert.match(edge, /async function updateLeader/);
  assert.match(page, /data-action="edit"/);
});
