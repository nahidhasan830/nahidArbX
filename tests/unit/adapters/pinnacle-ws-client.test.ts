import { describe, expect, it, vi } from "vitest";

const subscriptions: Array<{ destination: string; unsubscribe: ReturnType<typeof vi.fn> }> =
  [];

vi.mock("@stomp/stompjs", () => ({
  Client: vi.fn(function MockClient(this: {
    active: boolean;
    connectHeaders: Record<string, string>;
    activate: ReturnType<typeof vi.fn>;
    deactivate: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }) {
    this.active = true;
    this.connectHeaders = {};
    this.activate = vi.fn();
    this.deactivate = vi.fn().mockResolvedValue(undefined);
    this.subscribe = vi.fn((destination: string) => {
      const sub = { destination, unsubscribe: vi.fn() };
      subscriptions.push(sub);
      return sub;
    });
  }),
}));

vi.mock("@/lib/util/singleton", () => ({
  singleton: <T>(_key: string, factory: () => T) => factory(),
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const applyProviderSnapshot = vi.fn();
vi.mock("@/lib/atoms/store", () => ({
  applyProviderSnapshot,
}));

vi.mock("@/lib/adapters/pinnacle/ws-parser", () => ({
  parsePinnacleWsMessage: vi.fn(() => ({ entries: [], isSnapshot: false })),
}));

const { PinnacleWsClient } = await import("@/lib/adapters/pinnacle/ws-client");

describe("PinnacleWsClient", () => {
  it("resubscribes when a Pinnacle event is remapped to a new normalized event", () => {
    subscriptions.length = 0;
    applyProviderSnapshot.mockClear();

    const client = new PinnacleWsClient();
    (client as unknown as { isConnected: boolean }).isConnected = true;

    client.subscribe("1620834894", "matched-old");
    client.subscribe("1620834894", "matched-new");

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(applyProviderSnapshot).toHaveBeenCalledWith(
      "matched-old",
      "pinnacle",
      [],
    );
  });
});
