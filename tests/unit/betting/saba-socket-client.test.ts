import { afterEach, describe, expect, it, vi } from "vitest";
import { SabaSocketClient } from "@/lib/betting/saba/socket-client";

describe("SabaSocketClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps snapshot timeouts catchable while socket subscription is in flight", async () => {
    vi.useFakeTimers();

    const client = new SabaSocketClient();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let resolveSend: (() => void) | null = null;
    vi.spyOn(
      client as unknown as { ensureConnected: () => Promise<void> },
      "ensureConnected",
    ).mockResolvedValue();
    vi.spyOn(
      client as unknown as {
        sendSocketEvent: () => Promise<void>;
      },
      "sendSocketEvent",
    ).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    vi.spyOn(
      client as unknown as { unsubscribe: () => Promise<void> },
      "unsubscribe",
    ).mockResolvedValue();

    try {
      const request = client.requestFullMatchOdds("128484081");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(12_000);
      await Promise.resolve();

      expect(unhandled).toEqual([]);

      resolveSend?.();
      await expect(request).rejects.toThrow(
        "SABA odds snapshot timed out for match 128484081",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
      client.deactivate();
    }
  });

  it("does not resolve a pending snapshot from an empty detail-channel message", async () => {
    vi.useFakeTimers();

    const client = new SabaSocketClient();
    vi.spyOn(
      client as unknown as { ensureConnected: () => Promise<void> },
      "ensureConnected",
    ).mockResolvedValue();
    vi.spyOn(
      client as unknown as {
        sendSocketEvent: () => Promise<void>;
      },
      "sendSocketEvent",
    ).mockResolvedValue();
    vi.spyOn(
      client as unknown as { unsubscribe: () => Promise<void> },
      "unsubscribe",
    ).mockResolvedValue();

    try {
      const request = client.requestFullMatchOdds("128113073");
      await Promise.resolve();

      (
        client as unknown as {
          handleMessage: (payload: string) => void;
        }
      ).handleMessage(
        '42["m","c5002_2",[["f",0,["type"]],["type","empty"]]]',
      );

      const race = await Promise.race([
        request.then(() => "resolved"),
        Promise.resolve("pending"),
      ]);
      expect(race).toBe("pending");

      await vi.advanceTimersByTimeAsync(12_000);
      await expect(request).rejects.toThrow(
        "SABA odds snapshot timed out for match 128113073",
      );
    } finally {
      client.deactivate();
    }
  });

  it("resolves a pending snapshot from the base match channel", async () => {
    vi.useFakeTimers();

    const client = new SabaSocketClient();
    vi.spyOn(
      client as unknown as { ensureConnected: () => Promise<void> },
      "ensureConnected",
    ).mockResolvedValue();
    vi.spyOn(
      client as unknown as {
        sendSocketEvent: () => Promise<void>;
      },
      "sendSocketEvent",
    ).mockResolvedValue();
    const unsubscribe = vi
      .spyOn(client as unknown as { unsubscribe: () => Promise<void> }, "unsubscribe")
      .mockResolvedValue();

    try {
      const request = client.requestFullMatchOdds("128113073");
      await Promise.resolve();

      (
        client as unknown as {
          handleMessage: (payload: string) => void;
        }
      ).handleMessage(
        '42["m","c5001_1",[["f",0,["type","matchid","bettype","com1","comx","com2","oddsstatus","enable"]],["type","o","matchid",128113073,"bettype",5,"com1",1.9,"comx",3.1,"com2",4.2,"oddsstatus","running","enable",1]]]',
      );

      await expect(request).resolves.toMatchObject({
        channelId: "c5001_1",
        matchId: "128113073",
        rows: [
          {
            type: "o",
            matchid: 128113073,
            bettype: 5,
          },
        ],
      });
      expect(unsubscribe).toHaveBeenCalledWith(["c5001_1", "c5002_2"]);
    } finally {
      client.deactivate();
    }
  });
});
