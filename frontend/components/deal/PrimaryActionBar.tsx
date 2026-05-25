"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  actions: string[];
  publicId: string;
}

export function PrimaryActionBar({ actions, publicId }: Props) {
  const t = useTranslations();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function doAction(action: string) {
    setLoading(true);
    try {
      await fetch(`/api/deals/${publicId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const primary = actions.find((a) =>
    ["pay_from_wallet", "pay_with_khqr", "confirm_received", "approve"].includes(a)
  );

  if (!primary && !actions.includes("open_dispute")) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-background border-t p-4 flex gap-3 justify-center max-w-lg mx-auto">
      {primary === "pay_from_wallet" && (
        <button onClick={() => doAction("pay_from_wallet")} disabled={loading} className="btn-primary flex-1">
          {t("payment.pay_with_wallet")}
        </button>
      )}
      {primary === "confirm_received" && (
        <button onClick={() => doAction("confirm_received")} disabled={loading} className="btn-primary flex-1">
          {t("confirmation.confirm_received_cta")}
        </button>
      )}
      {primary === "approve" && (
        <button onClick={() => doAction("approve")} disabled={loading} className="btn-primary flex-1">
          {t("deal.actions.approve")}
        </button>
      )}
      {actions.includes("open_dispute") && (
        <a href={`/d/${publicId}/dispute`} className="btn-danger flex-1 text-center">
          {t("dispute.open_cta")}
        </a>
      )}
    </div>
  );
}
