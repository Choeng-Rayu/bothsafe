"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface Props {
  publicId: string;
  imageUrl: string;
  referenceNote: string;
  amount: string;
  currency: string;
}

export function KhqrPaymentPanel({ publicId, imageUrl, referenceNote, amount, currency }: Props) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Poll for payment verification (every 5s, up to 70s)
  useEffect(() => {
    let count = 0;
    const interval = setInterval(async () => {
      count++;
      if (count > 14) { clearInterval(interval); return; }
      try {
        const res = await fetch(`/api/deals/${publicId}`);
        if (res.ok) {
          const deal = await res.json();
          if (deal.status !== "ready_for_payment") {
            setStatus(deal.status);
            clearInterval(interval);
          }
        }
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [publicId]);

  async function copyRef() {
    await navigator.clipboard.writeText(referenceNote);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (status) {
    return (
      <div className="card mb-4 bg-green-50 border-green-200">
        <p className="text-green-800 font-medium">Payment verified ✓</p>
      </div>
    );
  }

  return (
    <div className="card mb-4">
      <h3 className="font-semibold mb-3">{t("payment.pay_with_khqr")}</h3>
      <div className="flex justify-center mb-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="KHQR" className="w-64 h-64 object-contain" />
      </div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-500">{t("payment.reference_note_label")}:</span>
        <button onClick={copyRef} className="text-sm underline min-h-[44px] min-w-[44px] flex items-center">
          {copied ? t("common.copied") : referenceNote}
        </button>
      </div>
      <p className="text-lg font-semibold">{t("payment.amount_due_label")}: {amount} {currency}</p>
      <a
        href={`bakong://pay?amount=${amount}&currency=${currency}&ref=${referenceNote}`}
        className="btn-primary w-full text-center mt-3"
      >
        {t("payment.open_bakong")}
      </a>
    </div>
  );
}
