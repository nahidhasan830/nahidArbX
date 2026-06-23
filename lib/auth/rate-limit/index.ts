
import { singleton } from "@/lib/util/singleton";


interface RateLimitEntry {
  count: number;
  firstRequest: number;
  blockedUntil: number | null;
}

interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  blockDurationMs: number;
}


const rateLimitStore = singleton(
  "rate-limit:store",
  () => new Map<string, RateLimitEntry>(),
);


export const RATE_LIMIT_CONFIGS = {
  login: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 15 * 60 * 1000,
  },
  passwordReset: {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
  },
  invite: {
    maxAttempts: 10,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000,
  },
  generic: {
    maxAttempts: 100,
    windowMs: 60 * 1000,
    blockDurationMs: 60 * 1000,
  },
} as const;


export function createRateLimitKey(type: string, identifier: string): string {
  return `${type}:${identifier}`;
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; remainingAttempts: number; retryAfterSeconds?: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry) {
    rateLimitStore.set(key, {
      count: 1,
      firstRequest: now,
      blockedUntil: null,
    });
    return {
      allowed: true,
      remainingAttempts: config.maxAttempts - 1,
    };
  }

  if (entry.blockedUntil && now < entry.blockedUntil) {
    const retryAfterSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
    return {
      allowed: false,
      remainingAttempts: 0,
      retryAfterSeconds,
    };
  }

  if (now - entry.firstRequest > config.windowMs) {
    rateLimitStore.set(key, {
      count: 1,
      firstRequest: now,
      blockedUntil: null,
    });
    return {
      allowed: true,
      remainingAttempts: config.maxAttempts - 1,
    };
  }

  entry.count++;

  if (entry.count > config.maxAttempts) {
    entry.blockedUntil = now + config.blockDurationMs;
    rateLimitStore.set(key, entry);

    const retryAfterSeconds = Math.ceil(config.blockDurationMs / 1000);
    return {
      allowed: false,
      remainingAttempts: 0,
      retryAfterSeconds,
    };
  }

  rateLimitStore.set(key, entry);
  return {
    allowed: true,
    remainingAttempts: config.maxAttempts - entry.count,
  };
}

export function resetRateLimit(key: string): void {
  rateLimitStore.delete(key);
}

export function getRemainingAttempts(
  key: string,
  config: RateLimitConfig,
): number {
  const entry = rateLimitStore.get(key);

  if (!entry) {
    return config.maxAttempts;
  }

  const now = Date.now();

  if (now - entry.firstRequest > config.windowMs) {
    return config.maxAttempts;
  }

  if (entry.blockedUntil && now < entry.blockedUntil) {
    return 0;
  }

  return Math.max(0, config.maxAttempts - entry.count);
}

export function cleanupRateLimitStore(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of rateLimitStore.entries()) {
    const isOld = now - entry.firstRequest > 60 * 60 * 1000;
    const isUnblocked = !entry.blockedUntil || now > entry.blockedUntil;

    if (isOld && isUnblocked) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }

  return cleaned;
}

const _cleanupTimer = singleton("rate-limit:cleanup-timer", () => {
  if (typeof setInterval !== "undefined") {
    return setInterval(cleanupRateLimitStore, 10 * 60 * 1000);
  }
  return null;
});
void _cleanupTimer;


import { NextResponse } from "next/server";

export function rateLimitResponse(
  type: keyof typeof RATE_LIMIT_CONFIGS,
  identifier: string,
): NextResponse | null {
  const config = RATE_LIMIT_CONFIGS[type];
  const key = createRateLimitKey(type, identifier);
  const result = checkRateLimit(key, config);

  if (!result.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many attempts. Please try again in ${result.retryAfterSeconds} seconds.`,
        retryAfter: result.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(result.retryAfterSeconds),
        },
      },
    );
  }

  return null;
}
