import { listTemplates } from "@/lib/templates";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json({ templates: await listTemplates() });
  } catch {
    return Response.json({ error: "Letter templates could not be loaded." }, { status: 503 });
  }
}
