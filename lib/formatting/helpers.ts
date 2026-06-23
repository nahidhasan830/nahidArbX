
import { format, isToday, isTomorrow, isValid, parseISO } from "date-fns";

export function fmtDateTime(iso: string): string {
  const d = parseISO(iso);
  if (!isValid(d)) return iso;
  const time = format(d, "HH:mm");
  if (isToday(d)) return `Today ${time}`;
  if (isTomorrow(d)) return `Tomorrow ${time}`;
  return format(d, "d MMM HH:mm");
}

export function fmtSeen(iso: string): string {
  const d = new Date(iso);
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  return `${Math.floor(diffMin / 1440)}d`;
}

export function fmtRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Math.abs(ms) < 60_000) return "just now";
  if (ms > 0) return `in ${durationLabel(ms)}`;
  return `${durationLabel(-ms)} ago`;
}

export function durationLabel(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const hrem = hours % 24;
  return hrem === 0 ? `${days}d` : `${days}d ${hrem}h`;
}

export function fmtMoney(amount: number, currency: string = "BDT"): string {
  const symbol = currency === "BDT" ? "৳" : currency;
  return `${symbol} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtSignedPct(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}
