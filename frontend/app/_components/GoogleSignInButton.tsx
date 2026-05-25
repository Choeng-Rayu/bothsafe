"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: GsiInitConfig) => void;
          renderButton: (parent: HTMLElement, options: GsiButtonOptions) => void;
          prompt: () => void;
        };
      };
    };
  }
}

interface GsiInitConfig {
  client_id: string;
  callback: (response: { credential: string }) => void;
  ux_mode?: "popup" | "redirect";
  auto_select?: boolean;
}

interface GsiButtonOptions {
  type: "standard" | "icon";
  theme: "outline" | "filled_blue" | "filled_black";
  size: "small" | "medium" | "large";
  text: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape: "rectangular" | "pill" | "circle" | "square";
  logo_alignment: "left" | "center";
  width?: number;
}

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

interface GoogleSignInButtonProps {
  next: string;
  onError: (key: string) => void;
}

export default function GoogleSignInButton({ next, onError }: GoogleSignInButtonProps) {
  const t = useTranslations();
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId) return;
    if (typeof window === "undefined") return;

    function initialize() {
      const gsi = window.google?.accounts.id;
      if (!gsi || !containerRef.current) return;
      gsi.initialize({
        client_id: clientId!,
        callback: async ({ credential }) => {
          try {
            const res = await fetch("/api/auth/google", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id_token: credential }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              onError(body.message || "errors.auth.google_failed");
              return;
            }
            router.push(next);
            router.refresh();
          } catch {
            onError("errors.auth.google_failed");
          }
        },
        ux_mode: "popup",
        auto_select: false,
      });
      gsi.renderButton(containerRef.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "continue_with",
        shape: "rectangular",
        logo_alignment: "left",
      });
      setReady(true);
    }

    if (window.google?.accounts.id) {
      initialize();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", initialize, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = initialize;
    document.head.appendChild(script);
  }, [clientId, next, onError, router]);

  if (!clientId) {
    return (
      <p className="text-xs text-gray-500 text-center">
        {t("auth.google_unavailable")}
      </p>
    );
  }

  return (
    <div className="flex justify-center">
      <div ref={containerRef} aria-busy={!ready} />
    </div>
  );
}
