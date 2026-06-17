import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const { notify } = await import("../../../lib/notifier");

function fetchBodies() {
  return vi
    .mocked(global.fetch)
    .mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
}

describe("Telegram notification formatters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "12345";
    global.fetch = vi.fn(async () => {
      return Response.json({ ok: true, result: { message_id: 99 } });
    }) as typeof fetch;
  });

  it("formats bet placement, settlement, and placement failures for quick scanning", async () => {
    await notify({
      type: "bet:placed",
      at: "2026-06-12T15:00:00.000Z",
      provider: "ninewickets-sportsbook",
      providerDisplayName: "NineWickets",
      eventName: "Arsenal vs Chelsea",
      competition: "EPL",
      sport: "soccer",
      eventStartTime: "2026-06-12T16:00:00.000Z",
      marketName: "OVER_UNDER",
      selectionName: "Over",
      stake: 500,
      odds: 1.92,
      currency: "BDT",
      mode: "auto",
      evPct: 4.25,
      kellyFraction: 0.25,
      timeScope: "FT",
      familyLine: "2.5",
      ticketId: "T-123",
      balance: 4500,
      dashboardUrl: "http://localhost:3000/dashboard",
    });

    await notify({
      type: "bet:settled",
      at: "2026-06-12T18:00:00.000Z",
      provider: "ninewickets-sportsbook",
      providerDisplayName: "NineWickets",
      eventName: "Arsenal vs Chelsea",
      competition: "EPL",
      sport: "soccer",
      marketName: "MATCH_RESULT",
      selectionName: "Arsenal",
      stake: 500,
      odds: 2.1,
      closingOdds: 2.0,
      placedAt: "2026-06-12T15:00:00.000Z",
      currency: "BDT",
      outcome: "won",
      pnl: 550,
      settledBySource: "espn",
      matchScore: {
        status: "FT",
        ftHome: 2,
        ftAway: 1,
        htHome: 1,
        htAway: 0,
      },
      balance: 5050,
    });

    await notify({
      type: "bet:error",
      at: "2026-06-12T15:05:00.000Z",
      provider: "velki-sportsbook",
      providerDisplayName: "Velki",
      eventName: "Barcelona vs Girona",
      competition: "La Liga",
      sport: "soccer",
      eventStartTime: "2026-06-12T16:30:00.000Z",
      marketName: "ASIAN_HANDICAP",
      selectionName: "Barcelona",
      timeScope: "FT",
      familyLine: "-1.0",
      error: "Stake below provider minimum",
      reasonCategory: "below_market_min",
      mode: "manual",
      stake: 100,
      odds: 1.85,
      currency: "BDT",
      evPct: 2.4,
      minBet: 200,
      maxBet: 5000,
      balance: 1000,
    });

    const [placed, settled, failed] = fetchBodies().map((body) =>
      String(body.text),
    );

    expect(placed).toContain("Auto bet placed");
    expect(placed).toContain("BDT 500.00 @ 1.92");
    expect(placed).toContain("Max profit BDT 460.00");
    expect(placed).toContain("NineWickets");

    expect(settled).toContain("Bet Won");
    expect(settled).toContain("+BDT 550.00");
    expect(settled).toContain("FT</b> · <b>2-1</b>");
    expect(settled).toContain("Settled by espn");

    expect(failed).toContain("Manual placement failed");
    expect(failed).toContain("below min");
    expect(failed).toContain("Tried BDT 100.00 @ 1.85");
    expect(failed).toContain("Limits: min 200, max 5,000 BDT");
    expect(failed).toContain("Reason: Stake below provider minimum");
  });

  it("formats system, provider, AI, boot, and unified boot notifications", async () => {
    await notify({
      type: "system",
      at: "2026-06-12T15:10:00.000Z",
      severity: "warn",
      message:
        "Odds drift after placement\n\nArsenal vs Chelsea\nRequested: 500 @ 1.90\nBooked: 500 @ 1.85",
    });

    await notify({
      type: "provider:health",
      at: "2026-06-12T15:11:00.000Z",
      state: "down",
      provider: "pinnacle",
      displayName: "Pinnacle",
      severity: "down",
      status: "down",
      reason: "circuit breaker is open",
      action: "Check provider credentials, network path, and engine logs.",
      lastSuccessAt: null,
      consecutiveFailures: 3,
      fingerprint: "pinnacle|down",
    });

    await notify({
      type: "ai:engine_state",
      at: "2026-06-12T15:12:00.000Z",
      state: "started",
      serviceUrl: "http://localhost:3002",
      pid: 123,
      configuredModel: "gemma-4-26b",
      llmEngine: "groq",
      llmHealthy: true,
      providersHealthy: 2,
      providersTotal: 3,
    });

    await notify({
      type: "ai:model_state",
      at: "2026-06-12T15:13:00.000Z",
      state: "off",
      model: "gemma-4-26b",
      configuredModel: "gemma-4-26b",
      llmEngine: "huggingface",
      reason: "manual pause",
    });

    await notify({
      type: "system:boot",
      at: "2026-06-12T15:14:00.000Z",
      process: "engine",
      nodeVersion: "v24.0.0",
      env: "development",
      pid: 321,
      enginePort: 3001,
      syncScheduler: true,
      autoSettle: true,
      autoSettleIntervalSec: 300,
      autoPlace: [
        { provider: "ninewickets", displayName: "NineWickets", enabled: true },
        { provider: "velki", displayName: "Velki", enabled: false },
      ],
      dataSources: ["Pinnacle", "Saba"],
      detectorDebounceMs: 500,
      mlRetrainJob: "ml-job",
      mlRetrainRegion: "asia-south1",
    });

    await notify({
      type: "system:boot",
      at: "2026-06-12T15:14:30.000Z",
      process: "frontend",
      nodeVersion: "v24.0.0",
      env: "development",
      pid: 654,
      engineUrl: "http://localhost:3001",
      engineReachable: false,
    });

    await notify({
      type: "system:unified_boot",
      at: "2026-06-12T15:15:00.000Z",
      engine: {
        type: "system:boot",
        at: "2026-06-12T15:14:00.000Z",
        process: "engine",
        nodeVersion: "v24.0.0",
        env: "development",
        syncScheduler: true,
        autoSettle: true,
        autoSettleIntervalSec: 300,
        autoPlace: [
          {
            provider: "ninewickets",
            displayName: "NineWickets",
            enabled: true,
          },
        ],
      },
      aiSearch: {
        type: "ai:engine_state",
        at: "2026-06-12T15:14:00.000Z",
        state: "started",
        serviceUrl: "http://localhost:3002",
        configuredModel: "gemma-4-26b",
        llmEngine: "groq",
        llmHealthy: true,
        providersHealthy: 2,
        providersTotal: 2,
      },
      frontend: {
        type: "system:boot",
        at: "2026-06-12T15:14:00.000Z",
        process: "frontend",
        nodeVersion: "v24.0.0",
        env: "development",
        engineReachable: true,
      },
    });

    const [
      system,
      provider,
      aiEngine,
      aiModel,
      engineBoot,
      frontendBoot,
      unifiedBoot,
    ] =
      fetchBodies().map((body) => String(body.text));

    expect(system).toContain("System Warning");
    expect(system).toContain("Odds drift after placement");
    expect(system).toContain("Requested: 500 @ 1.90");

    expect(provider).toContain("Pinnacle needs attention");
    expect(provider).toContain("3 consecutive failures");
    expect(provider).toContain("Action: Check provider credentials");

    expect(aiEngine).toContain("AI Engine Started");
    expect(aiEngine).toContain("gemma-4-26b on Groq (fallback)");
    expect(aiEngine).toContain("Search providers: 2/3 healthy");

    expect(aiModel).toContain("AI model off");
    expect(aiModel).toContain("Active <code>gemma-4-26b</code>");
    expect(aiModel).toContain("HuggingFace (primary)");

    expect(engineBoot).toContain("Engine started");
    expect(engineBoot).toContain("Auto-settle running · every 5m");
    expect(engineBoot).toContain("Auto-place Velki off");
    expect(engineBoot).toContain("Sources: Pinnacle, Saba");

    expect(frontendBoot).toContain("Frontend started");
    expect(frontendBoot).toContain("engine unreachable");
    expect(frontendBoot).toContain("http://localhost:3001");

    expect(unifiedBoot).toContain("All services started");
    expect(unifiedBoot).toContain("Engine: sync on, auto-place 1/1 on");
    expect(unifiedBoot).toContain("AI search: Groq (fallback) OK");
    expect(unifiedBoot).toContain("Frontend: engine connected");
  });

  it("formats ML training lifecycle notifications", async () => {
    await notify({
      type: "ml:training_started",
      at: "2026-06-12T15:20:00.000Z",
      modelId: "model-1",
      version: 7,
      qualifiedBets: 1200,
      rawLabeledExamples: 900,
      canonicalExamples: 850,
      uncoveredQualifiedBets: 120,
      trainerExpectedSamples: 730,
      featureVersion: 2,
      featureCount: 25,
      trigger: "auto",
      gitSha: "abc1234",
      previousModelVersion: 6,
      previousModelSamples: 700,
    });

    await notify({
      type: "ml:training_completed",
      at: "2026-06-12T16:00:00.000Z",
      modelId: "model-1",
      version: 7,
      outcome: "deployed",
      permissionLevel: "stake_reduce",
      durationMs: 2_400_000,
      trainingSamples: 730,
      aucRoc: 0.5612,
      dsr: 0.423,
      pbo: 0.38,
    });

    const [started, completed] = fetchBodies().map((body) => String(body.text));

    expect(started).toContain("ML training started · v7");
    expect(started).toContain("Training set: <b>730</b> samples");
    expect(started).toContain("Corpus: 850 canonical, 900 raw");
    expect(started).toContain("+30 samples since v6");

    expect(completed).toContain("Model Deployed · v7");
    expect(completed).toContain("Trained on 730 samples");
    expect(completed).toContain("Quality: AUC 0.5612 · DSR 0.423 · PBO 0.380");
    expect(completed).toContain("Permission: <b>Stake Reduce</b>");
  });
});
