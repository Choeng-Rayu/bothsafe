import { cookies } from "next/headers";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

export async function apiFetch<T>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  const cookieStore = await cookies();
  const session = cookieStore.get("bs_session")?.value;
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Cookie: `bs_session=${session}` } : {}),
      ...opts.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `API ${res.status}`);
  }
  return res.json();
}

export function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}
