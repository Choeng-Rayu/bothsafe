import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3003";

interface AdminDeal {
  id: string;
  public_id: string;
  product_title: string;
  status: string;
  deal_amount: string;
  currency: string;
  payment_proof_url?: string;
  shipping_proof_url?: string;
  dispute?: { reason: string; message: string; evidence_urls: string[] };
}

async function getDeal(dealId: string): Promise<AdminDeal | null> {
  const cookieStore = await cookies();
  const session = cookieStore.get("bs_admin_session")?.value;
  const res = await fetch(`${API_BASE}/v1/admin/deals/${dealId}`, {
    headers: { Cookie: `bs_admin_session=${session}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function AdminDealDetailPage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  const t = await getTranslations();
  const deal = await getDeal(dealId);

  if (!deal) {
    return <main className="p-8"><p>Deal not found.</p></main>;
  }

  return (
    <main className="flex flex-1 flex-col px-4 py-8 max-w-3xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-2">{deal.product_title}</h1>
      <p className="text-zinc-500 mb-6">{deal.deal_amount} {deal.currency} · {deal.status}</p>

      {deal.payment_proof_url && (
        <div className="card mb-4">
          <h2 className="font-semibold mb-2">Payment Proof</h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={deal.payment_proof_url} alt="Payment proof" className="max-w-full rounded" />
        </div>
      )}

      {deal.shipping_proof_url && (
        <div className="card mb-4">
          <h2 className="font-semibold mb-2">Shipping Proof</h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={deal.shipping_proof_url} alt="Shipping proof" className="max-w-full rounded" />
        </div>
      )}

      {deal.dispute && (
        <div className="card mb-4 border-red-200">
          <h2 className="font-semibold mb-2 text-red-700">Dispute</h2>
          <p className="text-sm"><strong>Reason:</strong> {deal.dispute.reason}</p>
          <p className="text-sm mt-1">{deal.dispute.message}</p>
          {deal.dispute.evidence_urls?.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={url} alt={`Evidence ${i + 1}`} className="max-w-full rounded mt-2" />
          ))}
        </div>
      )}

      <div className="flex gap-3">
        {(deal.status === "payment_pending_verification" || deal.status === "disputed") && (
          <>
            <form action={`/api/admin/deals/${dealId}/release`} method="POST">
              <button type="submit" className="btn-primary">{t("admin.deal.release")}</button>
            </form>
            <form action={`/api/admin/deals/${dealId}/refund`} method="POST">
              <button type="submit" className="btn-danger">{t("admin.deal.refund")}</button>
            </form>
          </>
        )}
        {deal.status === "payment_pending_verification" && (
          <>
            <form action={`/api/admin/deals/${dealId}/verify`} method="POST">
              <button type="submit" className="btn-primary">{t("admin.payment.verify")}</button>
            </form>
            <form action={`/api/admin/deals/${dealId}/reject`} method="POST">
              <button type="submit" className="btn-danger">{t("admin.payment.reject")}</button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
