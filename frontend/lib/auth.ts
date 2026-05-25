import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const session = cookieStore.get("bothsafe_session")?.value;
  if (!session) return null;
  try {
    const res = await fetch(`${API_BASE}/v1/auth/me`, {
      headers: { Cookie: `bothsafe_session=${session}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function requireAuth(next?: string) {
  const user = await getCurrentUser();
  if (!user) redirect(`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  return user;
}

export async function requireAdmin() {
  const cookieStore = await cookies();
  const session = cookieStore.get("bothsafe_admin_session")?.value;
  if (!session) redirect("/admin/login");
  try {
    const res = await fetch(`${API_BASE}/v1/admin/me`, {
      headers: { Cookie: `bothsafe_admin_session=${session}` },
      cache: "no-store",
    });
    if (!res.ok) redirect("/admin/login");
    return res.json();
  } catch {
    redirect("/admin/login");
  }
}
