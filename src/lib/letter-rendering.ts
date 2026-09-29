export type LetterMatterData = {
  matter_ref?: string | null;
  client_firm?: string | null;
  debtor_first_name?: string | null;
  debtor_last_name?: string | null;
  amount_owed?: string | number | null;
  currency?: string | null;
  [key: string]: string | number | null | undefined;
};

export function renderLetterText(
  text: string,
  matter: LetterMatterData,
  today = new Date(),
): string {
  const dateText = new Intl.DateTimeFormat("en-IE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(today);
  const values: Record<string, string> = Object.fromEntries(
    Object.entries(matter).map(([key, value]) => [key, value == null ? "" : String(value)]),
  );
  values.amount_owed = [matter.amount_owed, matter.currency]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(" ");
  values.today_date = dateText;

  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? values[key] : placeholder,
  );
}
