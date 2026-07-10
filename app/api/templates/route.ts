import { NextResponse } from "next/server";
import { defaultSheetTemplate } from "@/lib/templates/defaultSheetTemplate";
import { getSupabaseServerClient, hasServerSupabaseConfig } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  if (!hasServerSupabaseConfig) {
    return NextResponse.json({ templates: [defaultSheetTemplate], source: "local-default" });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("templates")
    .select("id, name, version, template_json")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: error.message, fallbackTemplates: [defaultSheetTemplate] },
      { status: 500 }
    );
  }

  return NextResponse.json({ templates: data });
}

export async function POST() {
  if (!hasServerSupabaseConfig) {
    return NextResponse.json(
      {
        error:
          "Supabase server configuration missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from("templates").upsert({
    id: defaultSheetTemplate.id,
    name: defaultSheetTemplate.name,
    version: defaultSheetTemplate.version,
    template_json: defaultSheetTemplate
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, templateId: defaultSheetTemplate.id });
}
