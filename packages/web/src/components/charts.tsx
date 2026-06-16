/* ---------------------------------------------------------------------------
   Hand-rolled SVG charts (no deps) + footnote-aware prose.

   Shared by the cinematic demo (DemoApp) and the real run viewer (OutputView),
   so the agent's produced artifact renders identically whether you're watching
   the guided demo or inspecting a live run. One set of renderers, no drift.
--------------------------------------------------------------------------- */

export const ACCENT = "#4A7FB5";

export type ChartSpec =
  | { kind: "bars"; items: { label: string; value: number; flag?: boolean }[]; threshold?: number; thresholdLabel?: string; caption: string }
  | { kind: "waterfall"; items: { label: string; value: number }[]; unit: string; caption: string }
  | { kind: "line"; points: number[]; limit: number; unit: string; caption: string };

/* ---------- footnote-aware prose ---------- */

export function Prose({ text }: { text: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[(\d+)\]$/);
        if (m) {
          return (
            <sup key={i}>
              <a href={`#fn-${m[1]}`} className="px-0.5 font-medium no-underline hover:underline" style={{ color: ACCENT }}>
                [{m[1]}]
              </a>
            </sup>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/* ---------- charts (hand-rolled SVG, no deps) ---------- */

export function BarsChart({ chart }: { chart: Extract<ChartSpec, { kind: "bars" }> }) {
  const W = 520, H = 150, padB = 22, padT = 12;
  const max = Math.max(...chart.items.map((i) => i.value), chart.threshold ?? 0) * 1.1;
  const innerH = H - padB - padT;
  const bw = W / chart.items.length;
  const y = (v: number) => padT + innerH * (1 - v / max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={chart.caption}>
      {chart.items.map((it, i) => {
        const bh = innerH * (it.value / max);
        return (
          <g key={i}>
            <rect
              x={i * bw + bw * 0.18}
              y={padT + innerH - bh}
              width={bw * 0.64}
              height={bh}
              rx={2}
              fill={it.flag ? "#b91c1c" : "#d6d3d1"}
            />
            <text x={i * bw + bw / 2} y={H - 7} textAnchor="middle" fontSize="9" fill="#78716c">
              {it.label}
            </text>
          </g>
        );
      })}
      {chart.threshold != null && (
        <g>
          <line x1={0} x2={W} y1={y(chart.threshold)} y2={y(chart.threshold)} stroke="#b45309" strokeWidth={1} strokeDasharray="4 3" />
          <text x={W - 2} y={y(chart.threshold) - 4} textAnchor="end" fontSize="9" fill="#b45309">
            {chart.thresholdLabel}
          </text>
        </g>
      )}
    </svg>
  );
}

export function WaterfallChart({ chart }: { chart: Extract<ChartSpec, { kind: "waterfall" }> }) {
  const W = 520, H = 160, padB = 24, padT = 12;
  const gross = chart.items[0]?.value ?? 0;
  const net = chart.items.reduce((s, it) => s + it.value, 0);
  const max = gross * 1.1;
  const innerH = H - padB - padT;
  const bars: { label: string; top: number; bottom: number; fill: string }[] = [];
  let running = 0;
  chart.items.forEach((it, i) => {
    if (i === 0) {
      bars.push({ label: it.label, top: it.value, bottom: 0, fill: "#0a0a0a" });
      running = it.value;
    } else {
      const top = running;
      running += it.value; // it.value negative
      bars.push({ label: it.label, top, bottom: running, fill: "#b91c1c" });
    }
  });
  bars.push({ label: "Net", top: net, bottom: 0, fill: ACCENT });
  const bw = W / bars.length;
  const y = (v: number) => padT + innerH * (1 - v / max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={chart.caption}>
      {bars.map((b, i) => {
        const yt = y(Math.max(b.top, b.bottom));
        const yb = y(Math.min(b.top, b.bottom));
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={yt} width={bw * 0.64} height={Math.max(2, yb - yt)} rx={2} fill={b.fill} />
            <text x={i * bw + bw / 2} y={H - 13} textAnchor="middle" fontSize="9" fill="#78716c">
              {b.label}
            </text>
            <text x={i * bw + bw / 2} y={H - 3} textAnchor="middle" fontSize="8.5" fill="#a8a29e">
              {(i === 0 || i === bars.length - 1 ? "" : "−") + Math.abs(i === bars.length - 1 ? net : chart.items[i]?.value ?? 0)}
              {chart.unit}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function LineChart({ chart }: { chart: Extract<ChartSpec, { kind: "line" }> }) {
  const W = 520, H = 150, padB = 18, padT = 12, padL = 8, padR = 8;
  const max = Math.max(...chart.points, chart.limit) * 1.15;
  const innerH = H - padB - padT;
  const innerW = W - padL - padR;
  const x = (i: number) => padL + (innerW * i) / (chart.points.length - 1);
  const y = (v: number) => padT + innerH * (1 - v / max);
  const line = chart.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  // shaded excursion area (clamped to the limit baseline) where temp > limit
  const above = chart.points.map((p, i) => ({ i, p })).filter((d) => d.p >= chart.limit);
  let area = "";
  if (above.length) {
    const first = above[0]!.i;
    const last = above[above.length - 1]!.i;
    area =
      `M${x(first)},${y(chart.limit)} ` +
      above.map((d) => `L${x(d.i).toFixed(1)},${y(d.p).toFixed(1)}`).join(" ") +
      ` L${x(last)},${y(chart.limit)} Z`;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={chart.caption}>
      {area && <path d={area} fill="#b91c1c" opacity={0.14} />}
      <line x1={padL} x2={W - padR} y1={y(chart.limit)} y2={y(chart.limit)} stroke="#b45309" strokeWidth={1} strokeDasharray="4 3" />
      <text x={W - padR} y={y(chart.limit) - 4} textAnchor="end" fontSize="9" fill="#b45309">
        {chart.limit} {chart.unit} limit
      </text>
      <path d={line} fill="none" stroke="#0a0a0a" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      {chart.points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p)} r={p >= chart.limit ? 2.6 : 1.8} fill={p >= chart.limit ? "#b91c1c" : "#0a0a0a"} />
      ))}
    </svg>
  );
}

export function Chart({ chart }: { chart: ChartSpec }) {
  return (
    <figure className="mt-4 rounded-lg border border-line bg-stone-50 p-3">
      {chart.kind === "bars" && <BarsChart chart={chart} />}
      {chart.kind === "waterfall" && <WaterfallChart chart={chart} />}
      {chart.kind === "line" && <LineChart chart={chart} />}
      <figcaption className="mt-2 text-center font-sans text-[11px] text-stone-500">{chart.caption}</figcaption>
    </figure>
  );
}
