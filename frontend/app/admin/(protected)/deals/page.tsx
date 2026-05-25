import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

interface Deal {
  id: string;
  public_id: string;
  product_title: string;
  status: string;
  deal_amount: string;
  currency: string;
  created_at: string;
}

async function getDeals(): Promise<Deal[]> {
  const cookieStore = await cookies();
  const session = cookieStore.get("bothsafe_admin_session")?.value;
  const res = await fetch(`${API_BASE}/v1/admin/deals`, {
    headers: { Cookie: `bothsafe_admin_session=${session}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || data;
}

export default async function AdminDealsPage() {
  const t = await getTranslations();
  const deals = await getDeals();

  return (
    <main className="flex flex-1 flex-col px-4 py-8 max-w-3xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">Deals</h1>
      {deals.length === 0 ? (
        <p className="text-zinc-500">No deals found.</p>
      ) : (
        <div className="space-y-3">
          {deals.map((d) => (
            <Link key={d.id} href={`/admin/deals/${d.id}`} className="card block">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{d.product_title}</p>
                  <p className="text-sm text-zinc-500">{d.deal_amount} {d.currency}</p>
                </div>
                <span className="text-xs px-2 py-1 rounded bg-zinc-100">
                  {t(`deal.status.${d.status}` as never)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
