import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const session = cookieStore.get("bs_admin_session")?.value;
  if (!session) redirect("/admin/login");

  // Verify admin session server-side
  try {
    const res = await fetch(`${API_BASE}/v1/admin/me`, {
      headers: { Cookie: `bs_admin_session=${session}` },
      cache: "no-store",
    });
    if (!res.ok) redirect("/admin/login");
  } catch {
    redirect("/admin/login");
  }

  return <>{children}</>;
}
