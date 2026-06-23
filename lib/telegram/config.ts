
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join("sessions", "telegram", "commands.json");

interface Config {
  disabled: Record<string, true>;
  updatedAt: string | null;
}

const DEFAULTS: Config = { disabled: {}, updatedAt: null };

let cached: Config | null = null;

function read(): Config {
  if (cached) return cached;
  try {
    if (!fs.existsSync(FILE)) {
      cached = { ...DEFAULTS };
      return cached;
    }
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    cached = {
      disabled:
        parsed.disabled && typeof parsed.disabled === "object"
          ? { ...parsed.disabled }
          : {},
      updatedAt: parsed.updatedAt ?? null,
    };
    return cached;
  } catch {
    cached = { ...DEFAULTS };
    return cached;
  }
}

function write(cfg: Config): void {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  cached = cfg;
}

export function isCommandEnabled(name: string): boolean {
  const c = read();
  return !c.disabled[name.toLowerCase()];
}

export function setCommandEnabled(name: string, enabled: boolean): void {
  const c = read();
  const key = name.toLowerCase();
  if (enabled) {
    delete c.disabled[key];
  } else {
    c.disabled[key] = true;
  }
  c.updatedAt = new Date().toISOString();
  write(c);
}

export function setManyCommands(updates: Record<string, boolean>): void {
  const c = read();
  for (const [name, enabled] of Object.entries(updates)) {
    const key = name.toLowerCase();
    if (enabled) delete c.disabled[key];
    else c.disabled[key] = true;
  }
  c.updatedAt = new Date().toISOString();
  write(c);
}

export function getCommandConfig(): {
  disabled: string[];
  updatedAt: string | null;
} {
  const c = read();
  return { disabled: Object.keys(c.disabled), updatedAt: c.updatedAt };
}
