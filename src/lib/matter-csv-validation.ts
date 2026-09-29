export const matterFields = [
  "matter_ref",
  "client_firm",
  "debtor_first_name",
  "debtor_last_name",
  "email",
  "phone",
  "amount_owed",
  "currency",
  "address_line1",
  "address_line2",
  "town",
  "county",
  "eircode",
  "instruction_date",
  "matter_type",
  "notes",
] as const;

export type MatterField = (typeof matterFields)[number];
export type CsvRow = Record<string, string>;

export type ValidationFinding = {
  kind: "error" | "tidy";
  code: string;
  field: MatterField | null;
  message: string;
  originalValue?: string;
  normalizedValue?: string;
};

export type ValidatedCsvRow = {
  rowNumber: number;
  originalData: Record<string, unknown>;
  normalizedData: Record<MatterField, string>;
  findings: ValidationFinding[];
};

export const requiredMatterFields: MatterField[] = [
  "matter_ref",
  "client_firm",
  "debtor_first_name",
  "debtor_last_name",
  "amount_owed",
  "currency",
  "address_line1",
  "town",
  "county",
  "instruction_date",
  "matter_type",
];

const fieldSet = new Set<string>(matterFields);

export function validateColumnMapping(
  headers: string[],
  mapping: Record<string, string>,
): string[] {
  const errors: string[] = [];
  const normalizedHeaders = new Set(headers);
  const entries = Object.entries(mapping).map(([header, target]) => ({
    header: header.trim(),
    target,
  }));
  const targets = entries.filter(({ target }) => target !== "");

  for (const { header } of entries) {
    if (!normalizedHeaders.has(header)) {
      errors.push(`Mapping refers to a column that is not in the CSV: ${header}`);
    }
  }

  for (const { header, target } of targets) {
    if (!fieldSet.has(target)) {
      errors.push(`Unknown matter field selected: ${target}`);
    }
  }

  const targetsByField = new Map<string, string[]>();
  for (const { header, target } of targets) {
    if (!fieldSet.has(target)) continue;
    const sourceHeaders = targetsByField.get(target) ?? [];
    sourceHeaders.push(header);
    targetsByField.set(target, sourceHeaders);
  }
  for (const [field, sourceHeaders] of targetsByField) {
    if (sourceHeaders.length > 1) {
      errors.push(`More than one CSV column is mapped to ${field}.`);
    }
  }

  const mappedFields = new Set(targets.map(({ target }) => target));
  for (const field of requiredMatterFields) {
    if (!mappedFields.has(field)) {
      errors.push(`A CSV column must be mapped to ${field}.`);
    }
  }

  return [...new Set(errors)];
}

function addFinding(
  findings: ValidationFinding[],
  finding: ValidationFinding,
) {
  findings.push(finding);
}

function normalizeDate(value: string): string | null {
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoDate) {
    const [, yearText, monthText, dayText] = isoDate;
    const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
    if (
      date.getUTCFullYear() === Number(yearText) &&
      date.getUTCMonth() === Number(monthText) - 1 &&
      date.getUTCDate() === Number(dayText)
    ) {
      return value;
    }
  }

  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${yearText}-${monthText}-${dayText}`;
}

function normalizeAmount(value: string): string | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const cents = whole * 100n + fraction;
  if (cents <= 0n || cents > 999_999_999_999n) return null;

  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

export function validateMappedRows(
  rows: CsvRow[],
  headers: string[],
  mapping: Record<string, string>,
  existingMatterRefs: Set<string> = new Set(),
): ValidatedCsvRow[] {
  const validationResults = rows.map((row, index) => {
    const originalData = Object.fromEntries(
      headers.map((header) => [header, row[header] ?? ""]),
    );
    const values = Object.fromEntries(
      matterFields.map((field) => [field, ""]),
    ) as Record<MatterField, string>;
    const findings: ValidationFinding[] = [];

    for (const [header, rawTarget] of Object.entries(mapping)) {
      const target = rawTarget as MatterField;
      if (!fieldSet.has(target)) continue;

      const originalValue = row[header.trim()] ?? "";
      const value = originalValue.trim();
      values[target] = value;
      if (value !== originalValue) {
        addFinding(findings, {
          kind: "tidy",
          code: "trimmed_whitespace",
          field: target,
          message: "Removed leading or trailing whitespace.",
          originalValue,
          normalizedValue: value,
        });
      }
    }

    for (const field of requiredMatterFields) {
      if (!values[field]) {
        addFinding(findings, {
          kind: "error",
          code: "required_value_missing",
          field,
          message: `${field.replaceAll("_", " ")} is required.`,
        });
      }
    }

    if (values.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
        addFinding(findings, {
          kind: "error",
          code: "invalid_email",
          field: "email",
          message: "Email address is invalid.",
        });
      } else if (values.email !== values.email.toLowerCase()) {
        const originalValue = values.email;
        values.email = values.email.toLowerCase();
        addFinding(findings, {
          kind: "tidy",
          code: "normalized_email_case",
          field: "email",
          message: "Converted the email address to lowercase.",
          originalValue,
          normalizedValue: values.email,
        });
      }
    }

    if (values.amount_owed) {
      const amount = normalizeAmount(values.amount_owed);
      if (amount === null) {
        addFinding(findings, {
          kind: "error",
          code: "invalid_amount",
          field: "amount_owed",
          message: "Amount must be greater than zero with up to two decimal places.",
        });
      } else if (amount !== values.amount_owed) {
        const originalValue = values.amount_owed;
        values.amount_owed = amount;
        addFinding(findings, {
          kind: "tidy",
          code: "normalized_amount",
          field: "amount_owed",
          message: "Formatted the amount to two decimal places.",
          originalValue,
          normalizedValue: amount,
        });
      }
    }

    if (values.currency) {
      if (!/^[A-Za-z]{3}$/.test(values.currency)) {
        addFinding(findings, {
          kind: "error",
          code: "invalid_currency",
          field: "currency",
          message: "Currency must be a three-letter code.",
        });
      } else if (values.currency !== values.currency.toUpperCase()) {
        const originalValue = values.currency;
        values.currency = values.currency.toUpperCase();
        addFinding(findings, {
          kind: "tidy",
          code: "normalized_currency_case",
          field: "currency",
          message: "Converted the currency code to uppercase.",
          originalValue,
          normalizedValue: values.currency,
        });
      }
    }

    if (values.instruction_date) {
      const date = normalizeDate(values.instruction_date);
      if (date === null) {
        addFinding(findings, {
          kind: "error",
          code: "invalid_instruction_date",
          field: "instruction_date",
          message: "Date must be a real calendar date in DD/MM/YYYY format.",
        });
      } else if (date !== values.instruction_date) {
        const originalValue = values.instruction_date;
        values.instruction_date = date;
        addFinding(findings, {
          kind: "tidy",
          code: "normalized_instruction_date",
          field: "instruction_date",
          message: "Converted the date to ISO format for storage.",
          originalValue,
          normalizedValue: date,
        });
      }
    }

    return {
      rowNumber: index + 2,
      originalData,
      normalizedData: values,
      findings,
    } satisfies ValidatedCsvRow;
  });

  const referenceRows = new Map<string, ValidatedCsvRow[]>();
  for (const result of validationResults) {
    const reference = result.normalizedData.matter_ref.toLocaleLowerCase("en-IE");
    if (!reference) continue;
    const matches = referenceRows.get(reference) ?? [];
    matches.push(result);
    referenceRows.set(reference, matches);
  }

  for (const result of validationResults) {
    const reference = result.normalizedData.matter_ref.toLocaleLowerCase("en-IE");
    if (!reference) continue;

    if ((referenceRows.get(reference)?.length ?? 0) > 1) {
      addFinding(result.findings, {
        kind: "error",
        code: "duplicate_matter_ref_in_file",
        field: "matter_ref",
        message: "This matter reference appears more than once in this file.",
      });
    } else if (existingMatterRefs.has(reference)) {
      addFinding(result.findings, {
        kind: "error",
        code: "matter_ref_already_exists",
        field: "matter_ref",
        message: "A matter with this reference already exists.",
      });
    }
  }

  return validationResults;
}
