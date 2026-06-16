import { presentOutput, type Tone } from "../lib/present";
import { Chart, Prose } from "./charts";
import { JsonBlock } from "./JsonBlock";

/**
 * Renders an agent step's produced output as a readable artifact — a titled
 * report with headline stats, a chart, and labelled sections — so a human can
 * see what the agent actually produced (and what an approver is signing off
 * on). Falls back to the raw JSON view for outputs no adapter recognises; the
 * raw payload is always available, collapsed, beneath the rendered view.
 */

const TONE_TEXT: Record<Tone, string> = {
  good: "text-verified",
  bad: "text-blocked",
  warn: "text-waiting",
  neutral: "text-ink",
};
const TONE_BORDER: Record<Tone, string> = {
  good: "border-verified",
  bad: "border-blocked",
  warn: "border-waiting",
  neutral: "border-line",
};

export function OutputView({ output, label = "Output" }: { output: unknown; label?: string }) {
  const p = presentOutput(output);
  if (!p) return <JsonBlock label={label} value={output} />;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-white">
      <div className="border-b border-line px-4 py-2.5">
        <h4 className="text-sm font-semibold tracking-tight text-ink">{p.title}</h4>
      </div>

      {p.stats.length > 0 && (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line px-4 py-3">
          {p.stats.map((s, i) => (
            <div key={i}>
              <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-stone-400">
                {s.label}
              </dt>
              <dd className={`font-mono text-[15px] font-semibold ${TONE_TEXT[s.tone ?? "neutral"]}`}>
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {p.chart && (
        <div className="px-4 pb-1">
          <Chart chart={p.chart} />
        </div>
      )}

      {p.body && p.body.length > 0 && (
        <div className="space-y-3 border-t border-line px-4 py-3 text-[13px] leading-relaxed text-ink">
          {p.body.map((para, i) => (
            <p key={i}>
              <Prose text={para} />
            </p>
          ))}
        </div>
      )}

      {p.footnotes && p.footnotes.length > 0 && (
        <ol className="space-y-1 border-t border-line px-4 py-3 text-xs text-stone-500">
          {p.footnotes.map((f, i) => (
            <li key={i} id={`fn-${i + 1}`}>
              <span className="mr-1 font-medium">[{i + 1}]</span>
              {f}
            </li>
          ))}
        </ol>
      )}

      {p.sections.map((sec, si) => (
        <section key={si} className="border-t border-line px-4 py-3">
          <h5 className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-stone-400">
            {sec.heading}
          </h5>
          <ul className="space-y-1.5">
            {sec.items.map((it, ii) => (
              <li key={ii} className={`border-l-2 pl-3 ${TONE_BORDER[it.tone ?? "neutral"]}`}>
                <p className="text-[13px] font-medium leading-snug text-ink">{it.title}</p>
                {it.detail && (
                  <p className="text-xs leading-relaxed text-stone-600">{it.detail}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="border-t border-line px-4 py-2">
        <JsonBlock label="Raw output" value={output} />
      </div>
    </div>
  );
}
