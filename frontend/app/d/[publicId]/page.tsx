import { apiFetch } from "@/lib/api";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { StatusBadge } from "@/components/deal/StatusBadge";
import { MissingFieldsChecklist } from "@/components/deal/MissingFieldsChecklist";
import { PrimaryActionBar } from "@/components/deal/PrimaryActionBar";
import { KhqrPaymentPanel } from "@/components/deal/KhqrPaymentPanel";
import { ShippingForm } from "@/components/deal/ShippingForm";
import { InvitePreview } from "@/components/deal/InvitePreview";

interface DealRoom {
  public_id: string;
  status: string;
  product_title: string;
  product_description?: string;
  deal_amount: string;
  currency: string;
  buyer_name?: string;
  seller_name?: string;
  missing_fields: string[];
  allowed_actions: string[];
  timeline: { event: string; at: string }[];
  khqr_image_url?: string;
  reference_note?: string;
}

export default async function DealRoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ invite?: string; access?: string }>;
}) {
  const { publicId } = await params;
  const { invite, access } = await searchParams;
  const t = await getTranslations();

  // Invite preview flow
  if (invite) {
    return <InvitePreview publicId={publicId} inviteToken={invite} />;
  }

  // Set access token cookie if provided
  const cookieStore = await cookies();
  const headers: Record<string, string> = {};
  const session = cookieStore.get("bothsafe_session")?.value;
  if (session) headers.Cookie = `bothsafe_session=${session}`;
  if (access) headers.Cookie = `bs_access=${access}`;

  let deal: DealRoom;
  try {
    deal = await apiFetch<DealRoom>(`/v1/deals/${publicId}`);
  } catch {
    return (
      <main className="flex flex-1 items-center justify-center px-4">
        <p className="text-zinc-500">{t("errors.deal.not_found")}</p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col px-4 py-6 max-w-lg mx-auto w-full pb-24">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">{deal.product_title}</h1>
        <StatusBadge status={deal.status} />
      </div>

      <div className="card mb-4">
        <p className="text-2xl font-semibold">{deal.deal_amount} {deal.currency}</p>
        {deal.product_description && <p className="text-sm text-zinc-500 mt-1">{deal.product_description}</p>}
      </div>

      {deal.buyer_name && (
        <div className="card mb-4">
          <p className="text-sm text-zinc-500">{t("deal.fields.buyer_name")}</p>
          <p>{deal.buyer_name}</p>
        </div>
      )}
      {deal.seller_name && (
        <div className="card mb-4">
          <p className="text-sm text-zinc-500">{t("deal.fields.seller_name")}</p>
          <p>{deal.seller_name}</p>
        </div>
      )}

      {deal.missing_fields.length > 0 && (
        <MissingFieldsChecklist fields={deal.missing_fields} />
      )}

      {deal.allowed_actions.includes("pay_with_khqr") && deal.khqr_image_url && (
        <KhqrPaymentPanel
          publicId={publicId}
          imageUrl={deal.khqr_image_url}
          referenceNote={deal.reference_note || ""}
          amount={deal.deal_amount}
          currency={deal.currency}
        />
      )}

      {deal.allowed_actions.includes("submit_shipping_proof") && (
        <ShippingForm publicId={publicId} />
      )}

      {deal.timeline.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold mb-2">Timeline</h2>
          <ul className="text-sm space-y-1">
            {deal.timeline.map((e, i) => (
              <li key={i} className="flex justify-between">
                <span>{e.event}</span>
                <span className="text-zinc-400">{new Date(e.at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <PrimaryActionBar actions={deal.allowed_actions} publicId={publicId} />
    </main>
  );
}
