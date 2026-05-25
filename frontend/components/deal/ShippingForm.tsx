"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ShippingForm({ publicId }: { publicId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    const file = fd.get("photo") as File | null;

    // Client-side file validation
    if (file && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) {
        setError(t("errors.storage.invalid_file"));
        setLoading(false);
        return;
      }
      if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) {
        setError(t("errors.storage.invalid_file"));
        setLoading(false);
        return;
      }
    }

    try {
      const body: Record<string, unknown> = {};
      const tracking = fd.get("tracking_number");
      const company = fd.get("delivery_company");
      if (tracking) body.tracking_number = tracking;
      if (company) body.delivery_company = company;

      const res = await fetch(`/api/deals/${publicId}/shipping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message || t("common.error_generic"));
        return;
      }
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card mb-4">
      <h3 className="font-semibold mb-3">{t("shipping.upload_proof")}</h3>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label>
          <span className="text-sm">{t("shipping.tracking_number_label")}</span>
          <input name="tracking_number" className="input-field mt-1" />
        </label>
        <label>
          <span className="text-sm">{t("shipping.delivery_company_label")}</span>
          <input name="delivery_company" className="input-field mt-1" />
        </label>
        <label>
          <span className="text-sm">{t("shipping.package_photo_label")}</span>
          <input name="photo" type="file" accept="image/jpeg,image/png,application/pdf" className="input-field mt-1" />
        </label>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? t("common.loading") : t("common.submit")}
        </button>
      </form>
    </div>
  );
}
