import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

export async function POST(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const session = req.cookies.get("bs_session")?.value;
  if (!session) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const res = await fetch(`${API_BASE}/v1/deals/${publicId}/dispute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `bs_session=${session}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
