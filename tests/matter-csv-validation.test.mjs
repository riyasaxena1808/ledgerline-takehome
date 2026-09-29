import assert from "node:assert/strict";
import test from "node:test";

import validation from "../node_modules/.cache/ledgerline-tests/matter-csv-validation.js";

const { matterFields, validateColumnMapping, validateMappedRows } = validation;

const mapping = Object.fromEntries(matterFields.map((field) => [field, field]));

function validRow(overrides = {}) {
  return {
    matter_ref: "REF-001",
    client_firm: "Example Firm",
    debtor_first_name: "Aoife",
    debtor_last_name: "Quinn",
    email: "aoife@example.com",
    phone: "",
    amount_owed: "125.5",
    currency: "EUR",
    address_line1: "1 Main Street",
    address_line2: "",
    town: "Dublin",
    county: "Dublin",
    eircode: "",
    instruction_date: "11/06/2026",
    matter_type: "Service charge",
    notes: "",
    ...overrides,
  };
}

test("requires each matter field and prevents ambiguous duplicate mappings", () => {
  assert.deepEqual(validateColumnMapping([...matterFields], mapping), []);

  const errors = validateColumnMapping(
    ["reference", "other"],
    { reference: "matter_ref", other: "matter_ref" },
  );
  assert.ok(errors.some((error) => error.includes("mapped to matter_ref")));
  assert.ok(errors.some((error) => error.includes("client_firm")));
});

test("normalizes safe formatting and retains the source row", () => {
  const row = validRow({
    matter_ref: "  REF-001 ",
    amount_owed: "125.5",
    currency: "eur",
    email: " AOIFE@EXAMPLE.COM ",
  });
  const [result] = validateMappedRows([row], [...matterFields], mapping);

  assert.equal(result.rowNumber, 2);
  assert.equal(result.originalData.matter_ref, "  REF-001 ");
  assert.equal(result.normalizedData.matter_ref, "REF-001");
  assert.equal(result.normalizedData.amount_owed, "125.50");
  assert.equal(result.normalizedData.currency, "EUR");
  assert.equal(result.normalizedData.email, "aoife@example.com");
  assert.equal(result.normalizedData.instruction_date, "2026-06-11");
  assert.ok(result.findings.some((finding) => finding.kind === "tidy"));
  assert.equal(result.findings.some((finding) => finding.kind === "error"), false);
});

test("flags malformed values instead of silently changing them", () => {
  const [result] = validateMappedRows(
    [validRow({ email: "not-an-email", amount_owed: "12,50", instruction_date: "31/02/2026" })],
    [...matterFields],
    mapping,
  );

  const codes = result.findings.map((finding) => finding.code);
  assert.ok(codes.includes("invalid_email"));
  assert.ok(codes.includes("invalid_amount"));
  assert.ok(codes.includes("invalid_instruction_date"));
  assert.equal(result.normalizedData.amount_owed, "12,50");
});

test("accepts canonical ISO dates after a reviewer corrects a row", () => {
  const [result] = validateMappedRows(
    [validRow({ instruction_date: "2026-06-11" })],
    [...matterFields],
    mapping,
  );

  assert.equal(result.normalizedData.instruction_date, "2026-06-11");
  assert.equal(result.findings.some((finding) => finding.kind === "error"), false);
});

test("flags every repeated reference and references already in the database", () => {
  const duplicateRows = validateMappedRows(
    [validRow(), validRow({ matter_ref: "ref-001" })],
    [...matterFields],
    mapping,
  );
  assert.ok(duplicateRows.every((row) =>
    row.findings.some((finding) => finding.code === "duplicate_matter_ref_in_file"),
  ));

  const existingRows = validateMappedRows(
    [validRow()],
    [...matterFields],
    mapping,
    new Set(["ref-001"]),
  );
  assert.ok(existingRows[0].findings.some(
    (finding) => finding.code === "matter_ref_already_exists",
  ));
});
