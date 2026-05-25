import { useTranslations } from "next-intl";

const statusColors: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  awaiting_counterparty: "bg-yellow-100 text-yellow-800",
  ready_for_payment: "bg-blue-100 text-blue-800",
  paid_escrowed: "bg-green-100 text-green-800",
  shipped: "bg-purple-100 text-purple-800",
  buyer_confirmed: "bg-green-100 text-green-800",
  disputed: "bg-red-100 text-red-800",
  released: "bg-green-200 text-green-900",
  refunded: "bg-orange-100 text-orange-800",
  cancelled: "bg-zinc-200 text-zinc-600",
  expired: "bg-zinc-200 text-zinc-600",
};

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("deal.status");
  const color = statusColors[status] || "bg-zinc-100 text-zinc-700";
  return (
    <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${color}`}>
      {t(status as never)}
    </span>
  );
}
