/**
 * Structured Logger with Levels
 *
 * - Runtime level filtering via LOG_LEVEL env var
 * - JSON output in production, human-readable in development
 * - Sync-cycle correlation IDs
 * - Scoped context via logger.withContext()
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isProduction = process.env.NODE_ENV === "production";

function resolveLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVELS) return env as LogLevel;
  return isProduction ? "info" : "debug";
}

const currentLevel = resolveLevel();

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

// --- Correlation ID (sync-cycle scoped) ---

let correlationId: string | undefined;

export function setCorrelationId(id: string | undefined): void {
  correlationId = id;
}

export function getCorrelationId(): string | undefined {
  return correlationId;
}

// --- Output formatting ---

const CONSOLE_FN: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function emitDev(
  level: LogLevel,
  context: string,
  message: string,
  data?: unknown,
): void {
  const fn = CONSOLE_FN[level];
  const prefix = correlationId
    ? `[${context}] (${correlationId})`
    : `[${context}]`;
  if (data !== undefined) {
    fn(`${prefix} ${message}`, data);
  } else {
    fn(`${prefix} ${message}`);
  }
}

function emitJson(
  level: LogLevel,
  context: string,
  message: string,
  data?: unknown,
): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ctx: context,
    msg: message,
  };
  if (data !== undefined) entry.data = data;
  if (correlationId) entry.cid = correlationId;
  CONSOLE_FN[level](JSON.stringify(entry));
}

const emit = isProduction ? emitJson : emitDev;

// --- Scoped logger type ---

export interface ScopedLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// --- Public API ---

function log(
  level: LogLevel,
  context: string,
  message: string,
  data?: unknown,
): void {
  if (shouldLog(level)) emit(level, context, message, data);
}

export const logger = {
  debug(context: string, message: string, data?: unknown): void {
    log("debug", context, message, data);
  },
  info(context: string, message: string, data?: unknown): void {
    log("info", context, message, data);
  },
  warn(context: string, message: string, data?: unknown): void {
    log("warn", context, message, data);
  },
  error(context: string, message: string, data?: unknown): void {
    log("error", context, message, data);
  },
  withContext(context: string): ScopedLogger {
    return {
      debug: (msg, data?) => log("debug", context, msg, data),
      info: (msg, data?) => log("info", context, msg, data),
      warn: (msg, data?) => log("warn", context, msg, data),
      error: (msg, data?) => log("error", context, msg, data),
    };
  },
};
