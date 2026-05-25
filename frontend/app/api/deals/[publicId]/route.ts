import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";

export async function GET(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const session = req.cookies.get("bothsafe_session")?.value;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) headers.Cookie = `bothsafe_session=${session}`;
  const res = await fetch(`${API_BASE}/v1/deals/${publicId}`, { headers, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
