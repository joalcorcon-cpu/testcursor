import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient, hasServerSupabaseConfig } from "@/lib/supabase";
import type { OMRResultJson } from "@/types/omr";

export const runtime = "nodejs";

const scanBodySchema = z.object({
  templateId: z.string().min(1),
  sourceName: z.string().min(1).default("upload"),
  resultJson: z.unknown()
});

export async function GET() {
  if (!hasServerSupabaseConfig) {
    return NextResponse.json({ scans: [] });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("scan_results")
    .select("id, template_id, source_name, result_json, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ scans: data });
}

export async function POST(request: Request) {
  if (!hasServerSupabaseConfig) {
    return NextResponse.json(
      {
        error:
          "Supabase server configuration missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      },
      { status: 400 }
    );
  }

  const body = scanBodySchema.parse(await request.json());
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("scan_results")
    .insert({
      template_id: body.templateId,
      source_name: body.sourceName,
      result_json: body.resultJson as OMRResultJson
    })
    .select("id, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, record: data });
}
