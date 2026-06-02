export interface SabaDecodedRow {
  [key: string]: unknown;
  type?: string;
}

export interface SabaDecodedMessage {
  channelIds: string[];
  fieldMap: Record<number, string>;
  rows: SabaDecodedRow[];
  revision?: string;
}

export interface SabaOddsSnapshot {
  channelId: string;
  matchId: string;
  rows: SabaDecodedRow[];
  fieldMap: Record<number, string>;
  capturedAt: number;
}

function parseSocketEvent(payload: string): unknown[] | null {
  if (!payload.startsWith("42")) return null;
  try {
    const parsed = JSON.parse(payload.slice(2));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseSabaSocketMessage(
  payload: string,
): SabaDecodedMessage | null {
  const event = parseSocketEvent(payload);
  if (!event || event[0] !== "m" || !Array.isArray(event[2])) return null;

  const rawRows = event[2] as unknown[];
  const fieldMap: Record<number, string> = {};
  const channelIds = new Set<string>();
  if (typeof event[1] === "string") channelIds.add(event[1]);

  for (const raw of rawRows) {
    if (!Array.isArray(raw)) continue;
    if (raw[0] === "f" && typeof raw[1] === "number" && Array.isArray(raw[2])) {
      for (const [idx, name] of raw[2].entries()) {
        if (typeof name === "string") fieldMap[raw[1] + idx] = name;
      }
    } else if (raw[0] === "c" && typeof raw[1] === "string") {
      channelIds.add(raw[1]);
    }
  }

  const rows: SabaDecodedRow[] = [];
  for (const raw of rawRows) {
    if (!Array.isArray(raw) || raw[0] === "f" || raw[0] === "c") continue;

    const row: SabaDecodedRow = {};
    for (let i = 0; i < raw.length - 1; i += 2) {
      const key = raw[i];
      const name = typeof key === "number" ? fieldMap[key] : undefined;
      row[name ?? String(key)] = raw[i + 1];
    }
    rows.push(row);
  }

  return {
    channelIds: Array.from(channelIds),
    fieldMap,
    rows,
    revision: typeof event[3] === "string" ? event[3] : undefined,
  };
}
