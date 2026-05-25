"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter, useParams } from "next/navigation";

const REASONS = ["item_not_received", "wrong_item", "damaged_item", "fake_item", "payment_problem", "other"];

export default function DisputePage() {
  const t = useTranslations();
  const router = useRouter();
  const params = useParams();
  const publicId = params.publicId as string;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    const message = fd.get("message") as string;
    if (message.length < 10 || message.length > 2000) {
      setError(t("errors.dispute.invalid_message_length"));
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/deals/${publicId}/dispute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: fd.get("reason"), message }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message || t("common.error_generic"));
        return;
      }
      router.push(`/d/${publicId}`);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col px-4 py-8 max-w-lg mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">{t("dispute.open_cta")}</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label>
          <span className="text-sm font-medium">Reason</span>
          <select name="reason" required className="input-field mt-1">
            {REASONS.map((r) => (
              <option key={r} value={r}>{t(`dispute.reason.${r}` as never)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-sm font-medium">{t("dispute.message_label")}</span>
          <textarea name="message" required minLength={10} maxLength={2000} rows={4} className="input-field mt-1" />
        </label>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button type="submit" disabled={loading} className="btn-danger">
          {loading ? t("common.loading") : t("dispute.open_cta")}
        </button>
      </form>
    </main>
  );
}
