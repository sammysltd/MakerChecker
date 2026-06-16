import { formatJson } from "../lib/format";

/**
 * Collapsible pretty-printed JSON. Native <details> keeps this stateless;
 * `tone` colors error payloads red.
 */
export function JsonBlock({
  label,
  value,
  tone = "neutral",
  defaultOpen = false,
}: {
  label: string;
  value: unknown;
  tone?: "neutral" | "error";
  defaultOpen?: boolean;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary
        className={`cursor-pointer select-none text-[11px] font-medium uppercase tracking-[0.08em] ${
          tone === "error" ? "text-blocked" : "text-stone-500 hover:text-ink"
        }`}
      >
        {label}
      </summary>
      <pre
        className={`mt-1 overflow-x-auto rounded border px-3 py-2 font-mono text-[11.5px] leading-relaxed ${
          tone === "error"
            ? "border-red-200 bg-red-50 text-blocked"
            : "border-line bg-white text-stone-800"
        }`}
      >
        {formatJson(value)}
      </pre>
    </details>
  );
}
