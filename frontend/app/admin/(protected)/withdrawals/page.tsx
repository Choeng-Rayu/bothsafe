import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

interface Withdrawal {
  id: string;
  amount: string;
  currency: string;
  destination_type: string;
  status: string;
  created_at: string;
}

async function getWithdrawals(): Promise<Withdrawal[]> {
  const cookieStore = await cookies();
  const session = cookieStore.get("bothsafe_admin_session")?.value;
  const res = await fetch(`${API_BASE}/v1/admin/withdrawals?status=pending_admin_review`, {
    headers: { Cookie: `bothsafe_admin_session=${session}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || data;
}

export default async function AdminWithdrawalsPage() {
  const t = await getTranslations();
  const withdrawals = await getWithdrawals();

  return (
    <main className="flex flex-1 flex-col px-4 py-8 max-w-3xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">Withdrawals Queue</h1>
      {withdrawals.length === 0 ? (
        <p className="text-zinc-500">No pending withdrawals.</p>
      ) : (
        <div className="space-y-3">
          {withdrawals.map((w) => (
            <div key={w.id} className="card flex items-center justify-between">
              <div>
                <p className="font-medium">{w.amount} {w.currency}</p>
                <p className="text-sm text-zinc-500">{w.destination_type} · {new Date(w.created_at).toLocaleDateString()}</p>
              </div>
              <div className="flex gap-2">
                <form action={`/api/admin/withdrawals/${w.id}/approve`} method="POST">
                  <button type="submit" className="btn-primary text-sm">
                    {t("admin.withdrawal.approve")}
                  </button>
                </form>
                <form action={`/api/admin/withdrawals/${w.id}/reject`} method="POST">
                  <button type="submit" className="btn-danger text-sm">
                    {t("admin.withdrawal.reject")}
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
