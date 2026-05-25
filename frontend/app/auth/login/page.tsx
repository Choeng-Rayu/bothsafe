"use client";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import GoogleSignInButton from "@/app/_components/GoogleSignInButton";
import { TelegramLoginButton } from "@/app/_components/TelegramLoginButton";

export default function LoginPage() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || t("errors.auth.invalid_credentials"));
        return;
      }
      router.push(next);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-6">{t("auth.login_title")}</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label>
            <span className="text-sm font-medium">{t("auth.email_label")}</span>
            <input name="email" type="email" required className="input-field mt-1" />
          </label>
          <label>
            <span className="text-sm font-medium">{t("auth.password_label")}</span>
            <input name="password" type="password" required className="input-field mt-1" />
          </label>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? t("common.loading") : t("auth.login_cta")}
          </button>
        </form>

        <div className="my-6 flex items-center gap-3 text-xs uppercase text-gray-500">
          <span className="h-px flex-1 bg-gray-300" />
          {t("auth.or_continue_with")}
          <span className="h-px flex-1 bg-gray-300" />
        </div>

        <div className="flex flex-col gap-2">
          <GoogleSignInButton next={next} onError={setError} />
          <TelegramLoginButton />
        </div>

        <p className="mt-4 text-sm text-center">
          <a href="/auth/signup" className="underline">{t("auth.signup_cta")}</a>
        </p>
      </div>
    </main>
  );
}
