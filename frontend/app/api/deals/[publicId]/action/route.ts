import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

export async function POST(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const session = req.cookies.get("bs_session")?.value;
  if (!session) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const { action } = body;

  const actionMap: Record<string, { method: string; path: string }> = {
    approve: { method: "POST", path: `/v1/deals/${publicId}/approve` },
    pay_from_wallet: { method: "POST", path: `/v1/deals/${publicId}/payment/wallet` },
    confirm_received: { method: "POST", path: `/v1/deals/${publicId}/confirm` },
  };

  const endpoint = actionMap[action];
  if (!endpoint) return NextResponse.json({ message: "Unknown action" }, { status: 400 });

  const res = await fetch(`${API_BASE}${endpoint.path}`, {
    method: endpoint.method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `bs_session=${session}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
