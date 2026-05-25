"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  publicId: string;
  inviteToken: string;
}

export function InvitePreview({ publicId, inviteToken }: Props) {
  const t = useTranslations();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleJoin() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/deals/${publicId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite_token: inviteToken }),
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
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold mb-4">{t("invite.preview_title")}</h1>
        <p className="text-sm text-amber-600 mb-6">{t("invite.share_warning")}</p>
        {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
        <button onClick={handleJoin} disabled={loading} className="btn-primary w-full">
          {loading ? t("common.loading") : t("invite.join_cta")}
        </button>
      </div>
    </main>
  );
}
