import { NextRequest, NextResponse } from "next/server";

const API_BASE =
  process.env.INTERNAL_API_BASE ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:3001";

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body?.id_token || typeof body.id_token !== "string") {
    return NextResponse.json(
      { message: "errors.auth.invalid_signup_data" },
      { status: 400 },
    );
  }
  const upstream = await fetch(`${API_BASE}/v1/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: body.id_token }),
  });
  const data = await upstream.json().catch(() => ({}));
  const response = NextResponse.json(data, { status: upstream.status });
  forwardSetCookie(upstream, response);
  return response;
}

function forwardSetCookie(upstream: Response, response: NextResponse) {
  const cookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : (upstream.headers.get("set-cookie") ? [upstream.headers.get("set-cookie") as string] : []);
  for (const cookie of cookies) {
    response.headers.append("set-cookie", cookie);
  }
}
