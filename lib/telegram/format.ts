
export function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => {
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    return "&amp;";
  });
}

export function code(s: string): string {
  return `<code>${esc(s)}</code>`;
}

export function b(s: string): string {
  return `<b>${esc(s)}</b>`;
}

export function i(s: string): string {
  return `<i>${esc(s)}</i>`;
}

export function money(n: number, currency = "BDT"): string {
  if (!Number.isFinite(n)) return `${currency} —`;
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${currency} ${abs}`;
}

export function signedMoney(n: number, currency = "BDT"): string {
  if (!Number.isFinite(n)) return `${currency} —`;
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${currency} ${abs}`;
}

export function pct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}%`;
}

export function signedPct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

export function num(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return "never";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return durationLabel(-ms) + " from now";
  return `${durationLabel(ms)} ago`;
}

export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hours < 24) return remM === 0 ? `${hours}h` : `${hours}h${remM}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d` : `${days}d${remH}h`;
}

export function bool(v: boolean, on = "ON", off = "OFF"): string {
  return v ? on : off;
}

export function statusEmoji(status: string): string {
  const s = status.toLowerCase();
  if (s === "ok" || s === "running" || s === "active" || s === "completed")
    return "🟢";
  if (s === "queued" || s === "pending") return "🟡";
  if (s === "paused" || s === "degraded") return "🟠";
  if (s === "error" || s === "failed" || s === "cancelled") return "🔴";
  return "⚪";
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return cut.slice(0, lastSpace) + "…";
  return cut + "…";
}

export function header(icon: string, title: string): string {
  return `${icon} ${b(title)}`;
}

export function kvList(rows: Array<[string, string]>): string {
  return rows.map(([k, v]) => `• ${esc(k)}: ${v}`).join("\n");
}
