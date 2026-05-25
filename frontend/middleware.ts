import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "bothsafe_session";

export function middleware(req: NextRequest) {
  const session = req.cookies.get(SESSION_COOKIE_NAME);
  if (session?.value) {
    return NextResponse.next();
  }
  const nextParam = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  const url = req.nextUrl.clone();
  url.pathname = "/auth/login";
  url.search = `?next=${encodeURIComponent(nextParam)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/deals/new", "/deals/new/:path*"],
};
