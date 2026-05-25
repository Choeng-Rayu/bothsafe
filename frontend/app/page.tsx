import { useTranslations } from "next-intl";
import Link from "next/link";

export default function Home() {
  const t = useTranslations();
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <h1 className="text-3xl font-bold mb-4">BothSafe</h1>
      <p className="text-lg text-zinc-600 dark:text-zinc-400 mb-8 text-center max-w-md">
        {t("bot.help.escrow_explain")}
      </p>
      <div className="flex flex-col sm:flex-row gap-4">
        <Link href="/deals/new" className="btn-primary">
          {t("deal.create.title")}
        </Link>
        <Link href="/auth/login" className="btn-secondary">
          {t("auth.login_cta")}
        </Link>
      </div>
    </main>
  );
}
