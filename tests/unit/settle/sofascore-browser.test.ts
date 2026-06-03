import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  fetchViaScrapeDoProxy: vi.fn(),
  reportDirect403: vi.fn(),
  isDirectOnCooldown: vi.fn(),
  getProxyStats: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("@/lib/settle/sources/scrapedo-proxy", () => ({
  fetchViaScrapeDoProxy: mocks.fetchViaScrapeDoProxy,
  reportDirect403: mocks.reportDirect403,
  isDirectOnCooldown: mocks.isDirectOnCooldown,
  getProxyStats: mocks.getProxyStats,
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const proxyStats = {
  service: "scrape.do",
  monthlyLimit: 1_000,
  usedCredits: 0,
  remainingCredits: 1_000,
  directOnCooldown: false,
  directCooldownRemainingMs: 0,
} as const;

function resetSingleton(): void {
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  delete g["__nahidArbX_settle:sofascore-curl__"];
}

function mockDirectJson(body: unknown): void {
  mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, JSON.stringify(body), "");
    return { unref: vi.fn() };
  });
}

describe("SofaScore transport fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resetSingleton();
    mocks.isDirectOnCooldown.mockReturnValue(false);
    mocks.getProxyStats.mockReturnValue(proxyStats);
  });

  it("falls back to Scrape.do when direct SofaScore returns a 403 challenge", async () => {
    mockDirectJson({ __error: true, status: 403 });
    mocks.fetchViaScrapeDoProxy.mockResolvedValue({ events: [{ id: 123 }] });

    const { fetchViaBrowser, getBrowserSessionStats } = await import(
      "@/lib/settle/sources/sofascore-browser"
    );

    const result = await fetchViaBrowser<{ events: { id: number }[] }>(
      "/api/v1/sport/football/scheduled-events/2026-06-03",
    );

    expect(result?.events[0]?.id).toBe(123);
    expect(mocks.reportDirect403).toHaveBeenCalledTimes(1);
    expect(mocks.fetchViaScrapeDoProxy).toHaveBeenCalledWith(
      "https://api.sofascore.com/api/v1/sport/football/scheduled-events/2026-06-03",
    );
    expect(getBrowserSessionStats()).toMatchObject({
      alive: true,
      requestCount: 1,
      directRequestCount: 1,
      proxyRequestCount: 1,
      consecutiveFailures: 0,
    });
  });

  it("uses Scrape.do directly while the direct transport is on cooldown", async () => {
    mocks.isDirectOnCooldown.mockReturnValue(true);
    mocks.fetchViaScrapeDoProxy.mockResolvedValue({ events: [] });

    const { fetchViaBrowser } = await import(
      "@/lib/settle/sources/sofascore-browser"
    );

    await fetchViaBrowser("/api/v1/sport/football/scheduled-events/2026-06-03");

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetchViaScrapeDoProxy).toHaveBeenCalledTimes(1);
  });
});
