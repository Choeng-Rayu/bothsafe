"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function WithdrawPage() {
  const t = useTranslations();
  const router = useRouter();
  const [dest, setDest] = useState<"khqr" | "bank">("khqr");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      amount: fd.get("amount"),
      currency: fd.get("currency") || "USD",
      destination_type: dest,
    };
    if (dest === "bank") {
      body.bank_name = fd.get("bank_name");
      body.bank_account_name = fd.get("bank_account_name");
      body.bank_account_number = fd.get("bank_account_number");
    }
    try {
      const res = await fetch("/api/withdrawals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message || t("common.error_generic"));
        return;
      }
      router.push("/wallet");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col px-4 py-8 max-w-lg mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">{t("withdrawal.request_title")}</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex gap-2">
          <button type="button" onClick={() => setDest("khqr")}
            className={`flex-1 min-h-[44px] rounded-lg border ${dest === "khqr" ? "border-foreground font-semibold" : "border-zinc-300"}`}>
            {t("withdrawal.destination.khqr")}
          </button>
          <button type="button" onClick={() => setDest("bank")}
            className={`flex-1 min-h-[44px] rounded-lg border ${dest === "bank" ? "border-foreground font-semibold" : "border-zinc-300"}`}>
            {t("withdrawal.destination.bank")}
          </button>
        </div>
        <label>
          <span className="text-sm font-medium">{t("deal.fields.deal_amount")}</span>
          <input name="amount" type="number" step="0.01" min="0.01" required className="input-field mt-1" />
        </label>
        <label>
          <span className="text-sm font-medium">{t("deal.fields.currency")}</span>
          <select name="currency" className="input-field mt-1">
            <option value="USD">USD</option>
            <option value="KHR">KHR</option>
          </select>
        </label>
        {dest === "bank" && (
          <>
            <label>
              <span className="text-sm font-medium">{t("withdrawal.bank_name_label")}</span>
              <input name="bank_name" required className="input-field mt-1" />
            </label>
            <label>
              <span className="text-sm font-medium">{t("withdrawal.bank_account_name_label")}</span>
              <input name="bank_account_name" required className="input-field mt-1" />
            </label>
            <label>
              <span className="text-sm font-medium">{t("withdrawal.bank_account_number_label")}</span>
              <input name="bank_account_number" required className="input-field mt-1" />
            </label>
          </>
        )}
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? t("common.loading") : t("withdrawal.submit_cta")}
        </button>
      </form>
    </main>
  );
}
