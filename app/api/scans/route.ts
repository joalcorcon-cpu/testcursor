import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient, hasServerSupabaseConfig } from "@/lib/supabase";
import type { OMRResultJson } from "@/types/omr";

export const runtime = "nodejs";

const scanBodySchema = z.object({
  templateId: z.string().min(1),
  sourceName: z.string().min(1).default("upload"),
  uploader: z.string().trim().optional(),
  resultJson: z.unknown()
});

export async function GET(request: Request) {
  if (!hasServerSupabaseConfig) {
    return NextResponse.json({ scans: [] });
  }
  const { searchParams } = new URL(request.url);
  const sourceName = searchParams.get("sourceName");
  const templateId = searchParams.get("templateId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Number(searchParams.get("limit") ?? "50");
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50;

  const supabase = getSupabaseServerClient();
  let query = supabase
    .from("scan_results")
    .select("id, scan_session_id, template_id, source_name, result_json, created_at")
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (sourceName) {
    query = query.ilike("source_name", `%${sourceName}%`);
  }
  if (templateId) {
    query = query.eq("template_id", templateId);
  }
  if (from) {
    query = query.gte("created_at", from);
  }
  if (to) {
    query = query.lte("created_at", to);
  }

  const { data, error } = await query;

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
  const { data: session, error: sessionError } = await supabase
    .from("scan_sessions")
    .insert({
      template_id: body.templateId,
      source_name: body.sourceName,
      uploader: body.uploader ?? null
    })
    .select("id")
    .single();

  if (sessionError || !session) {
    return NextResponse.json(
      { error: sessionError?.message ?? "Unable to create scan session." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("scan_results")
    .insert({
      scan_session_id: session.id,
      template_id: body.templateId,
      source_name: body.sourceName,
      result_json: body.resultJson as OMRResultJson
    })
    .select("id, scan_session_id, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, record: data });
}
