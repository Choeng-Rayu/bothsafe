"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

const TELEGRAM_BOT_USERNAME = "BothSafeBot";

export function TelegramLoginButton() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js";
    script.async = true;
    script.setAttribute("data-telegram-login", TELEGRAM_BOT_USERNAME);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    document.body.appendChild(script);

    (window as any).onTelegramAuth = async (user: any) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/auth/telegram/widget", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload: user }),
        });

        if (!response.ok) {
          setError(t("errors.auth.telegram_failed"));
          setLoading(false);
          return;
        }

        const next = searchParams.get("next") || "/";
        router.push(next);
        router.refresh();
      } catch (err) {
        setError(t("errors.auth.telegram_failed"));
        setLoading(false);
      }
    };

    return () => {
      delete (window as any).onTelegramAuth;
      document.body.removeChild(script);
    };
  }, [router, searchParams, t]);

  return (
    <div>
      <div ref={containerRef} id="telegram-login-container" />
      {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
      {loading && (
        <p className="text-gray-600 text-sm mt-2">
          {t("auth.telegram_signing_in")}
        </p>
      )}
    </div>
  );
}
