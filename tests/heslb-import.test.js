const test = require("node:test");
const assert = require("node:assert/strict");

global.window = global;
require("../js/heslb-import.js");

const header = "full_name,index_number,phone,faculty,year_of_study,status";
const validRow = "John Peter,RUCU/2024/001,+255712345678,ICT,3,active";

test("parses quoted commas and normalizes Tanzania phone formats", () => {
  const parsed = HESLBImport.parseCsv(`${header}\n\"John, Peter\",rucu/2024/001,0712345678,ict,3,active`);
  assert.equal(parsed.rows[0].values.full_name, "John, Peter");
  const result = HESLBImport.validateCsv(`${header}\n\"John, Peter\",rucu/2024/001,0712345678,ict,3,active`);
  assert.equal(result.valid[0].record.phone, "+255712345678");
  assert.equal(result.valid[0].record.index_number, "RUCU/2024/001");
});

test("rejects invalid phone, faculty, year and status with actionable errors", () => {
  const result = HESLBImport.validateCsv(`${header}\nA Person,RUCU/1,123,Other,9,unknown`);
  assert.equal(result.invalid.length, 1);
  assert.match(result.invalid[0].message, /simu si sahihi/);
  assert.match(result.invalid[0].message, /Kitivo si sahihi/);
  assert.match(result.invalid[0].message, /Mwaka wa masomo/);
  assert.match(result.invalid[0].message, /Hali iwe/);
});

test("marks rows with a malformed column count invalid", () => {
  const result = HESLBImport.validateCsv(`${header}\n${validRow},unexpected`);
  assert.equal(result.detected, 1);
  assert.equal(result.invalid.length, 1);
  assert.match(result.invalid[0].message, /Muundo wa safu/);
});

test("rejects quotes embedded in an unquoted CSV value", () => {
  const result = HESLBImport.validateCsv(`${header}\nJohn \"Peter,RUCU/2024/001,+255712345678,ICT,3,active`);
  assert.equal(result.detected, 1);
  assert.equal(result.invalid.length, 1);
  assert.match(result.invalid[0].message, /Muundo wa safu/);
});

test("flags duplicate index numbers in the input file", () => {
  const result = HESLBImport.validateCsv(`${header}\n${validRow}\nJane Doe,rucu/2024/001,+255712345679,FBMS,2,active`);
  assert.equal(result.valid.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].kind, "file");
});

test("does not overwrite existing rows unless explicitly enabled", () => {
  const existing = [{ index_number: "RUCU/2024/001", phone: "+255712345678" }];
  const blocked = HESLBImport.validateCsv(`${header}\n${validRow}`, existing, false);
  assert.equal(blocked.valid.length, 0);
  assert.equal(blocked.duplicates[0].kind, "existing");
  const allowed = HESLBImport.validateCsv(`${header}\n${validRow}`, existing, true);
  assert.equal(allowed.valid.length, 1);
  assert.equal(allowed.valid[0].operation, "update");
});

test("warns when a phone is already associated with a different existing index", () => {
  const existing = [{ index_number: "RUCU/2023/009", phone: "+255712345678" }];
  const result = HESLBImport.validateCsv(`${header}\n${validRow}`, existing, false);
  assert.equal(result.valid.length, 1);
  assert.equal(result.phoneWarnings.length, 1);
  assert.match(result.phoneWarnings[0].message, /tayari inahusishwa/);
});

test("reports missing required headers without treating data as valid", () => {
  const result = HESLBImport.validateCsv("full_name,index_number\nA Person,RUCU/1");
  assert.equal(result.headerErrors, true);
  assert.equal(result.valid.length, 0);
  assert.ok(result.invalid.some((row) => row.message.includes("Safu zinazokosekana")));
});
