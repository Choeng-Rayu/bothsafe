"use client";
import { useRouter } from "next/navigation";

const locales = [
  { code: "km", label: "ខ្មែរ" },
  { code: "en", label: "EN" },
  { code: "zh", label: "中文" },
];

export function LanguageSwitcher() {
  const router = useRouter();

  function switchLocale(locale: string) {
    document.cookie = `locale=${locale};path=/;max-age=${60 * 60 * 24 * 365}`;
    router.refresh();
  }

  return (
    <div className="flex gap-1">
      {locales.map((l) => (
        <button
          key={l.code}
          onClick={() => switchLocale(l.code)}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center text-sm rounded hover:bg-zinc-100"
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
