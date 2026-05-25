import { requireAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

interface WalletBalance {
  currency: string;
  available: string;
  pending: string;
}

export default async function WalletPage() {
  await requireAuth("/wallet");
  const t = await getTranslations();
  const wallet = await apiFetch<{ balances: WalletBalance[] }>("/v1/wallet/me");

  return (
    <main className="flex flex-1 flex-col px-4 py-8 max-w-lg mx-auto w-full">
      <h1 className="text-2xl font-bold mb-6">{t("wallet.balance_title")}</h1>
      <div className="flex flex-col gap-4 mb-6">
        {wallet.balances.map((b) => (
          <div key={b.currency} className="card">
            <p className="text-sm text-zinc-500">{b.currency}</p>
            <p className="text-2xl font-semibold">{b.available}</p>
            <p className="text-sm text-zinc-500">{t("wallet.pending_label")}: {b.pending}</p>
          </div>
        ))}
        {wallet.balances.length === 0 && (
          <p className="text-zinc-500">{t("wallet.empty_ledger")}</p>
        )}
      </div>
      <Link href="/wallet/withdraw" className="btn-primary text-center">
        {t("wallet.withdraw_cta")}
      </Link>
    </main>
  );
}
