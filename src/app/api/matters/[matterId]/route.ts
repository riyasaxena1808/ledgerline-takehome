import { pool } from "@/lib/db";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ matterId: string }> },
) {
  const { matterId } = await context.params;
  if (!uuidPattern.test(matterId)) {
    return Response.json({ error: "Invalid matter ID." }, { status: 400 });
  }

  try {
    const result = await pool.query(
      `SELECT id, matter_ref, client_firm, debtor_first_name, debtor_last_name,
              email, phone, amount_owed::text, currency, address_line1,
              address_line2, town, county, eircode,
              to_char(instruction_date, 'DD/MM/YYYY') AS instruction_date,
              matter_type, notes
       FROM matters WHERE id = $1`,
      [matterId],
    );
    if (result.rowCount === 0) {
      return Response.json({ error: "Matter not found." }, { status: 404 });
    }
    return Response.json({ matter: result.rows[0] });
  } catch {
    return Response.json({ error: "Matter could not be loaded." }, { status: 503 });
  }
}
