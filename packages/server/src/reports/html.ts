/**
 * Shared helpers for the self-contained evidence-pack HTML reports.
 * Ink on paper: black text, white background, hairline rules, monospace
 * hashes. No external assets — a report file must stand alone forever.
 */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** First 16 hex chars of a hash, for compact tamper-evident references. */
export function hashPrefix(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 16)}…` : "—";
}

export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return value instanceof Date ? value.toISOString() : String(value);
}

/** One-line JSON summary, truncated so huge payloads stay scannable. */
export function summarizeJson(value: unknown, max = 600): string {
  if (value === null || value === undefined) return "—";
  const json = JSON.stringify(value);
  return json.length > max ? `${json.slice(0, max)}… (${json.length} chars)` : json;
}

export const REPORT_CSS = `
  body { margin: 48px auto; max-width: 880px; padding: 0 24px; color: #111;
         background: #fff; font: 14px/1.55 Georgia, 'Times New Roman', serif; }
  h1 { font-size: 24px; font-weight: normal; margin: 0 0 4px; }
  h2 { font-size: 17px; font-weight: normal; margin: 36px 0 10px;
       border-bottom: 1px solid #111; padding-bottom: 4px; }
  h3 { font-size: 15px; font-weight: normal; margin: 22px 0 6px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 28px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; font-weight: normal; color: #555; font-size: 11px;
       text-transform: uppercase; letter-spacing: 0.06em; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
  .mono { font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
          font-size: 12px; word-break: break-all; }
  .status { font-variant: small-caps; letter-spacing: 0.04em; }
  .ok { color: #14532d; }
  .bad { color: #7f1d1d; }
  .muted { color: #777; }
  .kv td:first-child { color: #555; width: 180px; }
`;

export function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
