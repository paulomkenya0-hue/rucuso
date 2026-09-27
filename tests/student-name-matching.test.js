// RUCUSO — student last-name matching against the full name field.
//
// The verification form asks for a registration number and a LAST NAME, but
// the registry stores the complete name in students.full_name (a stored
// generated column, e.g. "Angelina Barbino SANGA"). The last_name column is
// populated at import time and can be wrong or empty, so the match must run
// against the full name's components. These tests exercise the REAL helpers
// extracted from the Edge Function, not a copy, so a regression in the
// matching logic fails here.
//
// They also pin the anti-enumeration property: a failed verification must not
// reveal whether the registration number exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const verifySrc = read('supabase/functions/verify-student/index.ts');
const otpSrc = read('supabase/functions/_shared/otp.ts');

// Strip the TypeScript type annotations so the function bodies can be eval'd
// as plain JS. Only the annotations used in these particular helpers are
// handled, which is fine: this is a regression test for THIS code, and a
// change that introduces a different annotation fails loudly here.
function tsToJs(block) {
  return block
    .replace(/export\s+(const|function)\s+/g, '$1 ')
    .replace(/:\s*unknown\b/g, '')
    .replace(/:\s*string\b/g, '')
    .replace(/:\s*boolean\b/g, '');
}

// Load the three name helpers out of verify-student/index.ts.
function loadNameHelpers() {
  const start = verifySrc.indexOf('function normalizeLastName');
  const end = verifySrc.indexOf('function errorResponse');
  assert.ok(start !== -1 && end !== -1 && start < end, 'name helpers not found in verify-student');
  const factory = new Function(`${tsToJs(verifySrc.slice(start, end))}; return { normalizeLastName, normalizeName, lastNameMatches };`);
  return factory();
}

// Load the registration normalisers out of _shared/otp.ts.
function loadRegHelpers() {
  const start = otpSrc.indexOf('export const CURRENT_REG_RE');
  // Slice to the START of the regFilter declaration (including its `export`),
  // so the slice ends cleanly on a line boundary instead of leaving a dangling
  // `export ` that survives type-stripping.
  const end = otpSrc.indexOf('export function regFilter');
  assert.ok(start !== -1 && end !== -1 && start < end, 'registration helpers not found in _shared/otp.ts');
  const factory = new Function(`${tsToJs(otpSrc.slice(start, end))}; return { CURRENT_REG_RE, LEGACY_REG_RE, normaliseReg, isRegistrationShaped };`);
  return factory();
}

const { normalizeName, lastNameMatches } = loadNameHelpers();
const { normaliseReg, isRegistrationShaped } = loadRegHelpers();

// ---- matching against the full name field ---------------------------------

test('"SANGA" matches the full name "Angelina Barbino SANGA"', () => {
  assert.equal(lastNameMatches('SANGA', 'Angelina Barbino SANGA', 'SANGA'), true);
});

test('"sanga" matches the same record (case-insensitive)', () => {
  assert.equal(lastNameMatches('sanga', 'Angelina Barbino SANGA', 'SANGA'), true);
});

test('"MWALYANZI" matches the full name "Frank MWALYANZI"', () => {
  assert.equal(lastNameMatches('MWALYANZI', 'Frank MWALYANZI', 'MWALYANZI'), true);
});

test('"KAPINGA" matches a full name containing KAPINGA', () => {
  assert.equal(lastNameMatches('KAPINGA', 'Peter KAPINGA', 'KAPINGA'), true);
  assert.equal(lastNameMatches('KAPINGA', 'KAPINGA', 'KAPINGA'), true);
});

test('leading/trailing spaces in the input last name are tolerated', () => {
  assert.equal(lastNameMatches('   SANGA   ', 'Angelina Barbino SANGA', 'SANGA'), true);
  assert.equal(lastNameMatches('\tSANGA\n', 'Angelina Barbino SANGA', 'SANGA'), true);
});

test('repeated spaces inside the stored full name are collapsed', () => {
  assert.equal(lastNameMatches('SANGA', 'Angelina   Barbino    SANGA', 'SANGA'), true);
  assert.equal(lastNameMatches('Barbino', 'Angelina  Barbino  SANGA', 'SANGA'), true);
});

test('Unicode-normalized names match regardless of composition form', () => {
  // "é" as one codepoint vs "e" + combining acute must compare equal under NFKC.
  const composed = 'José';            // é = U+00E9
  const decomposed = 'José'; // e + U+0301
  assert.equal(normalizeName(composed), normalizeName(decomposed));
  assert.equal(lastNameMatches(composed, decomposed, null), true);
  assert.equal(lastNameMatches(decomposed, composed, null), true);
});

test('the input matches the full name even when the last_name column is null', () => {
  assert.equal(lastNameMatches('SANGA', 'Angelina Barbino SANGA', null), true);
});

test('the input matches the full name even when the last_name column is wrong', () => {
  // last_name says "Barbino" but the student knows their surname as it appears
  // in the full name; the full name is authoritative.
  assert.equal(lastNameMatches('SANGA', 'Angelina Barbino SANGA', 'Barbino'), true);
});

// ---- false-match avoidance -------------------------------------------------

test('a non-matching last name does not verify', () => {
  assert.equal(lastNameMatches('SMITH', 'Angelina Barbino SANGA', 'SANGA'), false);
});

test('a short input does not substring-match a longer name component', () => {
  // "AN" is a substring of "Angelina" but not a component of it.
  assert.equal(lastNameMatches('AN', 'Angelina Barbino SANGA', 'SANGA'), false);
  assert.equal(lastNameMatches('SAN', 'Angelina Barbino SANGA', 'SANGA'), false);
});

test('an empty or whitespace-only input never matches', () => {
  assert.equal(lastNameMatches('', 'Angelina Barbino SANGA', 'SANGA'), false);
  assert.equal(lastNameMatches('   ', 'Angelina Barbino SANGA', 'SANGA'), false);
});

test('a full-name match requires the whole component, not a prefix', () => {
  assert.equal(lastNameMatches('SANG', 'Angelina Barbino SANGA', 'SANGA'), false);
  assert.equal(lastNameMatches('Angel', 'Angelina Barbino SANGA', 'SANGA'), false);
});

// ---- registration number normalization --------------------------------------

test('registration "RU / BAED / 2024 / 002" normalises to the canonical form', () => {
  assert.equal(normaliseReg('RU / BAED / 2024 / 002'), 'RU/BAED/2024/002');
});

test('lowercase registration input normalises to the same canonical form', () => {
  // verify-student trims the raw input first, then normalises; normaliseReg
  // itself only upper-cases and strips spaces AROUND the slashes, so the trim
  // is part of the contract. This mirrors the real call: normaliseReg(raw.trim()).
  assert.equal(normaliseReg('ru/baed/2024/002'.trim()), 'RU/BAED/2024/002');
  assert.equal(normaliseReg(' RU/BAED/2024/002 '.trim()), 'RU/BAED/2024/002');
  assert.equal(normaliseReg('ru / baed / 2024 / 002'.trim()), 'RU/BAED/2024/002');
});

test('all casings and spacings of the same number produce one canonical value', () => {
  // The real flow is normaliseReg(raw.trim()); every casing/spacing variant of
  // the same number must land on one canonical value.
  const canonical = normaliseReg('RU/BAED/2024/002'.trim());
  for (const variant of [
    'RU/BAED/2024/002',
    'ru/baed/2024/002',
    'RU / BAED / 2024 / 002',
    '  ru/baed/2024/002  ',
    'Ru/Baed/2024/002',
  ]) {
    assert.equal(normaliseReg(variant.trim()), canonical, `variant ${JSON.stringify(variant)} diverged`);
  }
});

test('a well-formed registration is recognised as shaped', () => {
  assert.equal(isRegistrationShaped('RU/BAED/2024/002'), true);
  assert.equal(isRegistrationShaped('ru/baed/2024/002'), true);
  assert.equal(isRegistrationShaped('RU / BAED / 2024 / 002'), true);
});

test('an invalid registration input is rejected as unshaped', () => {
  assert.equal(isRegistrationShaped(''), false);
  assert.equal(isRegistrationShaped('hello'), false);
  assert.equal(isRegistrationShaped('RU/BAED/2024'), false);
  assert.equal(isRegistrationShaped('RUCU/2024/01'), true); // legacy shape is still shaped
});

// ---- anti-enumeration ------------------------------------------------------

test('a failed verification does not reveal whether the registration exists', () => {
  // The verification section must return ONE failure code. The old code
  // returned NOT_FOUND (404) when the registration matched no row and
  // INVALID_CREDENTIALS (401) when the name did not match — a distinction an
  // attacker could use to tell a real registration from a fake one.
  assert.doesNotMatch(verifySrc, /errorResponse\(req, "NOT_FOUND"/);
  assert.match(verifySrc, /errorResponse\(req, "INVALID_CREDENTIALS"/);
});

test('the registration lookup uses the shared regFilter, not a hand-built string', () => {
  // A hand-built PostgREST filter was how a pasted "RU / BAED / 2024 / 002"
  // was found by lookup-student and then rejected by verify-student.
  assert.match(verifySrc, /\.or\(regFilter\(reg\)\)/);
  assert.doesNotMatch(verifySrc, /registration_number\.ilike\.\$\{reg\.replace/);
});

test('the rate-limit bucket uses the same normalised registration as the query', () => {
  // If the rate limit keyed on the raw input while the query keyed on the
  // normalised one, a student could get two budgets by varying the casing.
  assert.match(verifySrc, /const reg = normaliseReg\(rawReg\);/);
  assert.match(verifySrc, /scope: "student_verify_reg", value: reg/);
});
