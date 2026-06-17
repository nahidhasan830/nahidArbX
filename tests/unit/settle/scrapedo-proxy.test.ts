import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";

const request = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({
  default: { request },
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function resetSingleton(): void {
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  delete g["__nahidArbX_settle:scrapedo-proxy__"];
}

describe("Scrape.do SofaScore proxy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
    resetSingleton();
    process.env.SCRAPE_DO_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses Scrape.do super mode for Cloudflare-protected SofaScore targets", async () => {
    request.mockResolvedValue({ data: { events: [] } });

    const { fetchViaScrapeDoProxy } = await import(
      "@/lib/settle/sources/scrapedo-proxy"
    );

    await expect(
      fetchViaScrapeDoProxy(
        "https://api.sofascore.com/api/v1/sport/football/scheduled-events/2026-06-12",
      ),
    ).resolves.toEqual({ events: [] });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "get",
        url: "https://api.scrape.do",
        params: {
          token: "test-token",
          url: "https://api.sofascore.com/api/v1/sport/football/scheduled-events/2026-06-12",
          super: "true",
        },
      }),
    );
  });
});
