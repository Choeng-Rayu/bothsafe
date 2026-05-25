import { useTranslations } from "next-intl";

export function MissingFieldsChecklist({ fields }: { fields: string[] }) {
  const t = useTranslations("deal.fields");
  return (
    <div className="card mb-4 border-amber-200 bg-amber-50">
      <p className="text-sm font-medium text-amber-800 mb-2">Missing fields:</p>
      <ul className="text-sm space-y-1">
        {fields.map((f) => (
          <li key={f} className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full border border-amber-400 inline-block" />
            <span>{t(f as never)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
