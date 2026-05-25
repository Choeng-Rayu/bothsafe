"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface DealResult {
  public_id: string;
  creator_link: string;
  invite_link: string;
}

export default function NewDealPage() {
  const t = useTranslations();
  const [role, setRole] = useState<"buyer" | "seller">("seller");
  const [result, setResult] = useState<DealResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          product_title: fd.get("product_title"),
          deal_amount: Number(fd.get("deal_amount")),
          currency: fd.get("currency") || "USD",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message || t("common.error_generic"));
        return;
      }
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <main className="flex flex-1 flex-col px-4 py-8 max-w-lg mx-auto w-full">
        <h1 className="text-2xl font-bold mb-4">{t("messages.deal.created")}</h1>
        <div className="card flex flex-col gap-3">
          <div>
            <p className="text-sm text-zinc-500">Your private link:</p>
            <code className="text-sm break-all">{result.creator_link}</code>
          </div>
          <div>
            <p className="text-sm text-zinc-500">{t("bot.link.share_this")}</p>
            <code className="text-sm break-all">{result.invite_link}</code>
          </div>
          <p className="text-sm text-amber-600 mt-2">{t("bot.link.private_warning")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col px-4 py-8 max-w-lg mx-auto w-full">
      <h1 className="text-2xl font-bold mb-2">{t("deal.create.title")}</h1>
      <p className="text-zinc-500 mb-6">{t("deal.create.subtitle")}</p>
      <div className="flex gap-2 mb-6">
        <button type="button" onClick={() => setRole("buyer")}
          className={`flex-1 min-h-[44px] rounded-lg border ${role === "buyer" ? "border-foreground font-semibold" : "border-zinc-300"}`}>
          {t("deal.role.buyer")}
        </button>
        <button type="button" onClick={() => setRole("seller")}
          className={`flex-1 min-h-[44px] rounded-lg border ${role === "seller" ? "border-foreground font-semibold" : "border-zinc-300"}`}>
          {t("deal.role.seller")}
        </button>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label>
          <span className="text-sm font-medium">{t("deal.fields.product_title")}</span>
          <input name="product_title" required className="input-field mt-1" />
        </label>
        <label>
          <span className="text-sm font-medium">{t("deal.fields.deal_amount")}</span>
          <input name="deal_amount" type="number" step="0.01" min="0.01" required className="input-field mt-1" />
        </label>
        <label>
          <span className="text-sm font-medium">{t("deal.fields.currency")}</span>
          <select name="currency" className="input-field mt-1">
            <option value="USD">USD</option>
            <option value="KHR">KHR</option>
          </select>
        </label>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? t("common.loading") : t("deal.create.submit")}
        </button>
      </form>
    </main>
  );
}
