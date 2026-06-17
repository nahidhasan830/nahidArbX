/**
 * Telegram notification channel. Uses HTML parse_mode — HTML only
 * requires escaping `<`, `>`, `&`, which keeps odds/stakes/currency
 * formatting safe by default.
 *
 * Design system (applied to every event type):
 *   - STRICT one-fact-per-line layout. Every line = one emoji + one
 *     piece of info. No " · " cramming. No blank-line dividers. No
 *     blockquotes. No expandable drawers.
 *   - Order is always:  title → event/league/time → market/selection
 *     → stake/odds → score/pnl (settled only) → provider/ticket/ts.
 *   - Two legitimate exceptions to "one fact":
 *       1. Market → Selection are semantically one fact ("what I bet").
 *       2. Stake @ Odds are semantically one fact ("the price I paid").
 *     Everything else stays on its own line.
 *   - Always explicit signed money/percentages so outcomes
 *     pattern-match at a glance (+ / − / ➖).
 *
 * Creds come from .env:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *
 * Reference: https://core.telegram.org/bots/api#formatting-options
 */
import type {
  AiEngineStateEvent,
  AiModelStateEvent,
  BetPlacedEvent,
  BetSettledEvent,
  BetErrorEvent,
  MatchScoreInfo,
  NotificationChannel,
  NotificationEvent,
  ProviderHealthEvent,
  MlRunCompletedEvent,
  MlTrainingStartedEvent,
  MlTrainingCompletedEvent,
  SystemEvent,
  SystemBootEvent,
  UnifiedBootEvent,
} from "./types";
import { format, isSameDay, parseISO } from "date-fns";
import { logger } from "@/lib/shared/logger";
import { formatMarketType as formatMarketTypeBase } from "@/lib/formatting/labels";

const API_BASE = "https://api.telegram.org";
let warned = false;

function getCreds(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    if (!warned) {
      logger.warn(
        "TelegramNotifier",
        "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; notifications disabled",
      );
      warned = true;
    }
    return null;
  }
  return { token, chatId };
}

interface InlineKey {
  text: string;
  url?: string;
  callback_data?: string;
}

function formatMlRunCompleted(e: MlRunCompletedEvent): FormattedMessage | null {
  if (e.escalated <= 0) {
    return null;
  }

  const lines: string[] = [];

  lines.push(`⚠️ <b>Matcher queue needs review</b>`);
  lines.push(`👤 <b>${e.escalated}</b> rows need operator decision`);
  lines.push(
    `⚙️ Run: ${e.processed} scored, ${e.merged} merged, ${e.rejected} rejected`,
  );
  if (typeof e.generated === "number" && typeof e.skipped === "number") {
    lines.push(`📦 Candidates: ${e.generated} generated, ${e.skipped} skipped`);
  }
  lines.push(`⏱ Finished in ${esc(durationLabel(e.durationMs))}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return {
    text: lines.join("\n"),
    buttons: [
      {
        text: `Review ${Math.min(e.escalated, 5)}`,
        callback_data: `m:l:${Math.min(e.escalated, 5)}`,
      },
      { text: "Run all review", callback_data: "m:A" },
    ],
  };
}

function formatMlTrainingStarted(e: MlTrainingStartedEvent): FormattedMessage {
  const lines: string[] = [];

  const triggerLabel = e.trigger === "manual" ? "Manual" : "Auto";
  lines.push(`🏋️ <b>ML training started · v${e.version}</b>`);
  lines.push(`🎛 ${triggerLabel} trigger`);
  lines.push(`🧠 Model <code>${esc(e.modelId)}</code>`);
  lines.push(
    `📚 Training set: <b>${e.trainerExpectedSamples.toLocaleString()}</b> samples`,
  );
  lines.push(
    `🧾 Corpus: ${e.canonicalExamples.toLocaleString()} canonical, ${e.rawLabeledExamples.toLocaleString()} raw`,
  );
  lines.push(
    `🎯 Qualified: ${e.qualifiedBets.toLocaleString()} bets, ${e.uncoveredQualifiedBets.toLocaleString()} uncovered`,
  );
  lines.push(`🧬 Features: v${e.featureVersion}, ${e.featureCount} columns`);

  // Growth comparison vs previous model
  if (e.previousModelSamples != null && e.previousModelSamples > 0) {
    const growth = e.trainerExpectedSamples - e.previousModelSamples;
    const growthPct = Math.round((growth / e.previousModelSamples) * 100);
    if (growth > 0) {
      lines.push(
        `📈 +${growth.toLocaleString()} samples since v${e.previousModelVersion ?? "?"} (+${growthPct}%)`,
      );
    }
  }

  if (e.gitSha) lines.push(`🔗 <code>${esc(e.gitSha)}</code>`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

function formatMlTrainingCompleted(
  e: MlTrainingCompletedEvent,
): FormattedMessage {
  const lines: string[] = [];

  const outcomeIcon =
    e.outcome === "deployed" ? "✅" : e.outcome === "rejected" ? "🚫" : "💥";
  const outcomeLabel =
    e.outcome === "deployed"
      ? "Model Deployed"
      : e.outcome === "rejected"
        ? "Model Rejected"
        : "Training Failed";

  lines.push(`${outcomeIcon} <b>${esc(outcomeLabel)} · v${e.version}</b>`);
  lines.push(`🧠 Model <code>${esc(e.modelId)}</code>`);
  lines.push(`📚 Trained on ${e.trainingSamples.toLocaleString()} samples`);
  if (e.durationMs > 0) {
    lines.push(`⏱ Finished in ${esc(durationLabel(e.durationMs))}`);
  }

  // Metrics block
  if (e.aucRoc != null || e.dsr != null || e.pbo != null) {
    const quality: string[] = [];
    if (e.aucRoc != null) {
      quality.push(`AUC ${e.aucRoc.toFixed(4)}`);
    }
    if (e.dsr != null) {
      quality.push(`DSR ${e.dsr.toFixed(3)}`);
    }
    if (e.pbo != null) {
      quality.push(`PBO ${e.pbo.toFixed(3)}`);
    }
    if (quality.length > 0) {
      lines.push(`📊 Quality: ${esc(quality.join(" · "))}`);
    }
  }

  // Rejection reasons
  if (e.rejectionReasons && e.rejectionReasons.length > 0) {
    lines.push(`🚫 Rejection reasons:`);
    for (const reason of e.rejectionReasons.slice(0, 5)) {
      lines.push(`- ${esc(reason)}`);
    }
    if (e.rejectionReasons.length > 5) {
      lines.push(`… and ${e.rejectionReasons.length - 5} more`);
    }
  }

  if (e.outcome === "deployed" && e.permissionLevel) {
    const PERM_LABELS: Record<string, { emoji: string; label: string }> = {
      stake_increase: { emoji: "🟢", label: "Full ML Sizing" },
      stake_reduce: { emoji: "🟡", label: "Stake Reduce" },
      gate_only: { emoji: "🟠", label: "Gate Only (positive model EV)" },
      shadow: { emoji: "🔵", label: "Shadow (log only)" },
    };
    const perm = PERM_LABELS[e.permissionLevel] ?? {
      emoji: "🔵",
      label: e.permissionLevel,
    };
    lines.push(`${perm.emoji} Permission: <b>${esc(perm.label)}</b>`);
  }

  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

export const telegramChannel: NotificationChannel = {
  id: "telegram",
  async send(event: NotificationEvent): Promise<void> {
    const creds = getCreds();
    if (!creds) return;

    const formatted = formatMessage(event);
    if (!formatted) return;

    const url = `${API_BASE}/bot${creds.token}/sendMessage`;
    try {
      const payload: Record<string, unknown> = {
        chat_id: creds.chatId,
        text: formatted.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      };
      if (formatted.buttons && formatted.buttons.length > 0) {
        payload.reply_markup = {
          inline_keyboard: [
            formatted.buttons.map((b) =>
              b.callback_data
                ? { text: b.text, callback_data: b.callback_data }
                : { text: b.text, url: b.url },
            ),
          ],
        };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.error(
          "TelegramNotifier",
          `send failed (${res.status}): ${body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      logger.error(
        "TelegramNotifier",
        `network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

// --------------------------------------------------------------------
// Formatters
// --------------------------------------------------------------------

interface FormattedMessage {
  text: string;
  buttons?: InlineKey[];
}

function formatMessage(event: NotificationEvent): FormattedMessage | null {
  switch (event.type) {
    case "bet:placed":
      return formatPlaced(event);
    case "bet:settled":
      return formatSettled(event);
    case "bet:error":
      return formatError(event);
    case "system":
      return formatSystem(event);
    case "provider:health":
      return formatProviderHealth(event);
    case "system:boot":
      return formatBoot(event);
    case "system:unified_boot":
      return formatUnifiedBoot(event);
    case "ai:engine_state":
      return formatAiEngineState(event);
    case "ai:model_state":
      return formatAiModelState(event);
    case "ml:run_completed":
      return formatMlRunCompleted(event);
    case "ml:training_started":
      return formatMlTrainingStarted(event);
    case "ml:training_completed":
      return formatMlTrainingCompleted(event);
  }
}

// --------------------------------------------------------------------
// bet:placed
// --------------------------------------------------------------------

function formatPlaced(e: BetPlacedEvent): FormattedMessage {
  const modeLabel = e.mode === "auto" ? "Auto" : "Manual";
  const modeEmoji = e.mode === "auto" ? "🤖" : "✋";
  const potentialProfit = e.stake * e.odds - e.stake;
  const selectionLine = buildSelectionLine(
    e.marketName,
    e.selectionName,
    e.timeScope ?? null,
    e.familyLine ?? null,
  );

  const lines: string[] = [];
  lines.push(
    `✅ <b>${esc(modeLabel)} bet placed</b> · ${esc(money(e.stake, e.currency))} @ ${esc(e.odds.toFixed(2))}`,
  );
  lines.push(`${sportEmoji(e.sport)} <b>${esc(e.eventName)}</b>`);
  if (e.competition) lines.push(`🏆 ${esc(e.competition)}`);
  if (e.eventStartTime)
    lines.push(`⏰ ${esc(capitalize(kickoffLabel(e.eventStartTime)))}`);
  lines.push(`🎯 ${selectionLine}`);
  lines.push(`🎁 Max profit ${esc(money(potentialProfit, e.currency))}`);
  if (typeof e.evPct === "number") {
    lines.push(`${evEmoji(e.evPct)} EV <b>${esc(signedPct(e.evPct))}</b>`);
  }
  if (typeof e.kellyFraction === "number" && e.kellyFraction > 0) {
    lines.push(`📏 Kelly ${esc(kellyFractionLabel(e.kellyFraction))}`);
  }
  lines.push(`🏦 ${esc(e.providerDisplayName)} · ${modeEmoji} ${esc(modeLabel)}`);
  if (typeof e.balance === "number") {
    lines.push(`💼 Balance <b>${esc(money(e.balance, e.currency))}</b>`);
  }
  if (e.ticketId) lines.push(`🎫 <code>${esc(e.ticketId)}</code>`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return {
    text: lines.join("\n"),
    buttons: buildButtons(e.dashboardUrl),
  };
}

// --------------------------------------------------------------------
// bet:settled
// --------------------------------------------------------------------

function formatSettled(e: BetSettledEvent): FormattedMessage {
  const outcomeIcon: Record<BetSettledEvent["outcome"], string> = {
    won: "🟢",
    half_won: "🟡",
    void: "⚪",
    half_lost: "🟠",
    lost: "🔴",
  };
  const outcomeTitle: Record<BetSettledEvent["outcome"], string> = {
    won: "Bet Won",
    lost: "Bet Lost",
    void: "Bet Void",
    half_won: "Half Won",
    half_lost: "Half Lost",
  };
  const roiPct = e.stake > 0 ? (e.pnl / e.stake) * 100 : 0;
  const clvPct =
    e.closingOdds && e.closingOdds > 0 && e.odds > 0
      ? (e.odds / e.closingOdds - 1) * 100
      : null;
  const selectionLine = buildSelectionLine(
    e.marketName,
    e.selectionName,
    e.timeScope ?? null,
    e.familyLine ?? null,
  );

  const lines: string[] = [];
  lines.push(
    `${outcomeIcon[e.outcome]} <b>${esc(outcomeTitle[e.outcome])}</b> · ${esc(signedMoney(e.pnl, e.currency))}`,
  );
  lines.push(`${sportEmoji(e.sport)} <b>${esc(e.eventName)}</b>`);
  if (e.competition) lines.push(`🏆 ${esc(e.competition)}`);

  if (e.matchScore) {
    const scoreLine = buildScoreLine(e.matchScore);
    if (scoreLine) lines.push(scoreLine);
  }

  lines.push(`🎯 ${selectionLine}`);
  lines.push(
    `💰 ${esc(money(e.stake, e.currency))} @ ${esc(e.odds.toFixed(2))}`,
  );
  if (e.closingOdds != null) {
    lines.push(`📍 Close ${esc(e.closingOdds.toFixed(2))}`);
  }
  const pnlIcon = e.pnl > 0 ? "📈" : e.pnl < 0 ? "📉" : "➖";
  lines.push(
    `${pnlIcon} P&amp;L <b>${esc(signedMoney(e.pnl, e.currency))}</b>`,
  );
  lines.push(`💹 ROI ${esc(signedPct(roiPct))}`);
  if (clvPct !== null) {
    const clvIcon = clvPct > 0 ? "🎯" : clvPct < 0 ? "⚠️" : "➖";
    lines.push(`${clvIcon} CLV ${esc(signedPct(clvPct))}`);
  }

  lines.push(`🏦 ${esc(e.providerDisplayName)}`);
  if (typeof e.balance === "number") {
    lines.push(`💼 Balance <b>${esc(money(e.balance, e.currency))}</b>`);
  }
  if (e.settledBySource) lines.push(`🔎 Settled by ${esc(e.settledBySource)}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return {
    text: lines.join("\n"),
    buttons: buildButtons(e.dashboardUrl),
  };
}

// --------------------------------------------------------------------
// bet:error
// --------------------------------------------------------------------

function formatError(e: BetErrorEvent): FormattedMessage {
  const lines: string[] = [];
  const modeLabel = e.mode === "auto" ? "Auto" : "Manual";
  const categoryLabel = e.reasonCategory
    ? REASON_CATEGORY_LABEL[e.reasonCategory]
    : null;

  lines.push(
    `⚠️ <b>${esc(modeLabel)} placement failed</b>${
      categoryLabel ? ` · <i>${esc(categoryLabel)}</i>` : ""
    }`,
  );
  lines.push(`${sportEmoji(e.sport)} <b>${esc(e.eventName)}</b>`);
  if (e.competition) lines.push(`🏆 ${esc(e.competition)}`);
  if (e.eventStartTime)
    lines.push(`⏰ ${esc(capitalize(kickoffLabel(e.eventStartTime)))}`);
  lines.push(
    `🎯 ${buildSelectionLine(
      e.marketName,
      e.selectionName,
      e.timeScope ?? null,
      e.familyLine ?? null,
    )}`,
  );

  // Attempted stake @ odds + potential return. Rendered whenever sizing
  // got resolved, so the operator sees exactly what we asked the book
  // to accept — stale caches and cap edits both surface here.
  if (
    typeof e.stake === "number" &&
    typeof e.odds === "number" &&
    Number.isFinite(e.stake) &&
    Number.isFinite(e.odds)
  ) {
    const currency = e.currency ?? "BDT";
    const potentialReturn = e.stake * e.odds;
    lines.push(
      `💵 Tried ${esc(money(e.stake, currency))} @ ${esc(
        e.odds.toFixed(2),
      )} · return ${esc(money(potentialReturn, currency))}`,
    );
  }
  if (typeof e.evPct === "number") {
    lines.push(`${evEmoji(e.evPct)} EV <b>${esc(signedPct(e.evPct))}</b>`);
  }
  if (typeof e.kellyFraction === "number" && e.kellyFraction > 0) {
    lines.push(`📏 Kelly ${esc(kellyFractionLabel(e.kellyFraction))}`);
  }

  // Book-window context so a "below minimum" error reads with the
  // actual numbers, not just the book's raw string.
  if (typeof e.minBet === "number" || typeof e.maxBet === "number") {
    const minStr =
      typeof e.minBet === "number" ? e.minBet.toLocaleString() : "—";
    const maxStr =
      typeof e.maxBet === "number" ? e.maxBet.toLocaleString() : "—";
    const cur = e.currency ? ` ${esc(e.currency)}` : "";
    lines.push(`📊 Limits: min ${minStr}, max ${maxStr}${cur}`);
  }
  if (typeof e.balance === "number") {
    lines.push(
      `💼 Balance <b>${esc(money(e.balance, e.currency ?? "BDT"))}</b>`,
    );
  }

  lines.push(`❌ Reason: ${truncate(esc(e.error), 400)}`);
  lines.push(`🏦 ${esc(e.providerDisplayName ?? e.provider)}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return {
    text: lines.join("\n"),
    buttons: buildButtons(e.dashboardUrl),
  };
}

const REASON_CATEGORY_LABEL: Record<
  NonNullable<BetErrorEvent["reasonCategory"]>,
  string
> = {
  below_market_min: "below min",
  above_market_max: "above max",
  above_balance: "balance",
  suspended: "suspended",
  duplicate: "duplicate",
  transport: "transport",
  adapter_error: "adapter",
  book_rejection: "book",
  unknown: "unknown",
};

// --------------------------------------------------------------------
// ai engine/model lifecycle
// --------------------------------------------------------------------

function formatAiEngineState(e: AiEngineStateEvent): FormattedMessage {
  const icon =
    e.state === "started" ? "🟢" : e.state === "failed" ? "🚨" : "🔴";
  const title =
    e.state === "started"
      ? "AI Engine Started"
      : e.state === "failed"
        ? "AI Engine Failed"
        : "AI Engine Stopped";
  const lines: string[] = [];

  lines.push(`${icon} <b>${title}</b>`);
  lines.push(
    `🧠 ${esc(e.configuredModel)} on ${esc(formatAiEngineLabel(e.llmEngine))}`,
  );
  lines.push(`🔗 <code>${esc(e.serviceUrl)}</code>`);

  if (typeof e.llmHealthy === "boolean") {
    lines.push(
      `${e.llmHealthy ? "✅" : "❌"} LLM ${e.llmHealthy ? "healthy" : "unhealthy"}`,
    );
  }
  if (
    typeof e.providersHealthy === "number" &&
    typeof e.providersTotal === "number"
  ) {
    lines.push(
      `🌐 Search providers: ${e.providersHealthy}/${e.providersTotal} healthy`,
    );
  }
  if (e.pid) lines.push(`🔧 PID <code>${e.pid}</code>`);
  if (e.uptimeMs != null) {
    lines.push(`⏱ Uptime <b>${esc(durationLabel(e.uptimeMs))}</b>`);
  }
  if (e.exitCode != null || e.signal) {
    const exitParts = [
      e.exitCode != null ? `code ${e.exitCode}` : null,
      e.signal ? `signal ${e.signal}` : null,
    ].filter(Boolean);
    lines.push(
      `🧾 Exit <code>${esc(exitParts.join(" · ") || "unknown")}</code>`,
    );
  }
  if (e.reason) lines.push(`🧾 ${esc(truncate(e.reason, 280))}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

function formatAiModelState(e: AiModelStateEvent): FormattedMessage {
  const isOn = e.state === "on";
  const lines: string[] = [];

  lines.push(`${isOn ? "⚡" : "💤"} <b>AI model ${isOn ? "on" : "off"}</b>`);
  lines.push(`🧠 Active <code>${esc(e.model)}</code>`);
  lines.push(`🎯 Configured <code>${esc(e.configuredModel)}</code>`);
  lines.push(`☁️ ${esc(formatAiEngineLabel(e.llmEngine))}`);
  if (e.reason) lines.push(`🧾 ${esc(truncate(e.reason, 280))}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

// --------------------------------------------------------------------
// system
// --------------------------------------------------------------------

function formatSystem(e: SystemEvent): FormattedMessage {
  const severityIcon =
    e.severity === "error" ? "🚨" : e.severity === "warn" ? "⚠️" : "ℹ️";
  const severityLabel =
    e.severity === "error"
      ? "System Error"
      : e.severity === "warn"
        ? "System Warning"
        : "System Info";

  const lines: string[] = [];
  lines.push(`${severityIcon} <b>${esc(severityLabel)}</b>`);
  lines.push(...formatSystemMessageLines(e.message));
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);
  return { text: lines.join("\n") };
}

function formatProviderHealth(e: ProviderHealthEvent): FormattedMessage {
  const down = e.state === "down";
  const lines: string[] = [];

  lines.push(
    `${down ? "🚨" : "✅"} <b>${esc(e.displayName)} ${down ? "needs attention" : "recovered"}</b>`,
  );
  if (e.status) lines.push(`📡 Status ${esc(e.status)}`);
  if (e.consecutiveFailures > 0) {
    lines.push(`🔁 ${e.consecutiveFailures} consecutive failures`);
  }
  if (e.lastSuccessAt) {
    lines.push(`✅ Last success ${esc(formatAbsoluteTime(e.lastSuccessAt))}`);
  }
  lines.push(`${down ? "❌" : "🧾"} ${esc(truncate(e.reason, 360))}`);
  lines.push(`🛠 Action: ${esc(e.action)}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

// --------------------------------------------------------------------
// system:boot
// --------------------------------------------------------------------

function formatBoot(e: SystemBootEvent): FormattedMessage {
  return e.process === "engine" ? formatEngineBoot(e) : formatFrontendBoot(e);
}

function formatEngineBoot(e: SystemBootEvent): FormattedMessage {
  const lines: string[] = [];

  const envEmoji = e.env === "production" ? "🟢" : "🟡";
  lines.push(`⚙️ <b>Engine started</b>`);
  lines.push(`${envEmoji} ${esc(e.env)} · Node ${esc(e.nodeVersion)}`);
  if (e.pid)
    lines.push(
      `🔧 PID <code>${e.pid}</code> · HTTP :${e.enginePort ?? 3001}`,
    );

  lines.push(
    `${e.syncScheduler ? "✅" : "❌"} Sync ${e.syncScheduler ? "running" : "stopped"}`,
  );
  if (e.autoSettleIntervalSec) {
    lines.push(
      `${e.autoSettle ? "✅" : "❌"} Auto-settle ${e.autoSettle ? "running" : "stopped"} · every ${esc(durationLabel(e.autoSettleIntervalSec * 1000))}`,
    );
  }

  if (e.autoPlace && e.autoPlace.length > 0) {
    for (const ap of e.autoPlace) {
      const icon = ap.enabled ? "✅" : "⏸";
      lines.push(
        `${icon} Auto-place ${esc(ap.displayName)} ${ap.enabled ? "on" : "off"}`,
      );
    }
  }

  if (e.dataSources && e.dataSources.length > 0) {
    lines.push(`📡 Sources: ${esc(e.dataSources.join(", "))}`);
  }

  if (e.detectorDebounceMs) {
    lines.push(`⚡ Detector debounce ${e.detectorDebounceMs}ms`);
  }

  if (e.mlRetrainJob || e.mlRetrainRegion) {
    if (e.mlRetrainJob) {
      lines.push(`☁️ ML job <code>${esc(e.mlRetrainJob)}</code>`);
    }
    if (e.mlRetrainRegion) {
      lines.push(`🌏 Region <code>${esc(e.mlRetrainRegion)}</code>`);
    }
  }

  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

function formatFrontendBoot(e: SystemBootEvent): FormattedMessage {
  const lines: string[] = [];

  const envEmoji = e.env === "production" ? "🟢" : "🟡";
  const reachIcon = e.engineReachable ? "✅" : "❌";
  const reachLabel = e.engineReachable ? "engine connected" : "engine unreachable";

  lines.push(`🌐 <b>Frontend started</b>`);
  lines.push(`${envEmoji} ${esc(e.env)} · Node ${esc(e.nodeVersion)}`);
  lines.push(`${reachIcon} ${reachLabel}`);
  if (e.pid) lines.push(`🔧 PID <code>${e.pid}</code>`);
  if (e.engineUrl) lines.push(`🔗 <code>${esc(e.engineUrl)}</code>`);

  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

// --------------------------------------------------------------------
// system:unified_boot  (dev:all combined notification)
// --------------------------------------------------------------------

function formatUnifiedBoot(e: UnifiedBootEvent): FormattedMessage {
  const lines: string[] = [];

  const missing = [
    e.engine ? null : "engine",
    e.aiSearch ? null : "AI search",
    e.frontend ? null : "frontend",
  ].filter((part): part is string => !!part);
  lines.push(
    missing.length > 0
      ? `⚠️ <b>Services started with missing boot payloads</b>`
      : `🚀 <b>All services started</b>`,
  );

  if (e.engine) {
    const eng = e.engine;
    const engineBits: string[] = [];
    if (typeof eng.syncScheduler === "boolean") {
      engineBits.push(`sync ${eng.syncScheduler ? "on" : "off"}`);
    }
    if (eng.autoPlace && eng.autoPlace.length > 0) {
      const enabled = eng.autoPlace.filter((ap) => ap.enabled).length;
      engineBits.push(`auto-place ${enabled}/${eng.autoPlace.length} on`);
    }
    if (eng.autoSettleIntervalSec) {
      engineBits.push(
        `settle ${eng.autoSettle ? "on" : "off"} every ${durationLabel(
          eng.autoSettleIntervalSec * 1000,
        )}`,
      );
    }
    lines.push(`⚙️ Engine: ${esc(engineBits.join(", ") || "ready")}`);
  }

  if (e.aiSearch) {
    const ai = e.aiSearch;
    const problems: string[] = [];
    if (ai.llmHealthy === false) problems.push("LLM unhealthy");
    if (
      typeof ai.providersHealthy === "number" &&
      typeof ai.providersTotal === "number" &&
      ai.providersHealthy < ai.providersTotal
    ) {
      problems.push(
        `${ai.providersHealthy}/${ai.providersTotal} search providers`,
      );
    }
    if (problems.length > 0) {
      lines.push(`🤖 AI search: ${esc(problems.join(", "))}`);
    } else {
      const provLabel =
        typeof ai.providersTotal === "number"
          ? `, ${ai.providersTotal} providers`
          : "";
      lines.push(
        `🤖 AI search: ${esc(formatAiEngineLabel(ai.llmEngine))} OK, ${esc(ai.configuredModel)}${provLabel}`,
      );
    }
  }

  if (e.frontend) {
    const fe = e.frontend;
    lines.push(
      `🌐 Frontend: ${fe.engineReachable ? "engine connected" : "engine unreachable"}`,
    );
  }

  if (missing.length > 0) {
    lines.push(`🧩 Missing: ${esc(missing.join(", "))}`);
  }
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return { text: lines.join("\n") };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function buildButtons(dashboardUrl?: string): InlineKey[] | undefined {
  const btns: InlineKey[] = [];
  if (dashboardUrl) btns.push({ text: "📊 Dashboard", url: dashboardUrl });
  return btns.length > 0 ? btns : undefined;
}

function formatSystemMessageLines(message: string): string[] {
  const parts = message.split("\n");
  if (parts.length === 1) {
    return [`🧾 ${esc(message)}`];
  }

  return parts.map((part, index) => {
    if (part.trim() === "") return "";
    return index === 0 ? `🧾 ${esc(part)}` : esc(part);
  });
}

function formatAiEngineLabel(engine: string): string {
  if (engine === "huggingface") return "HuggingFace (primary)";
  if (engine === "groq") return "Groq (fallback)";
  return engine;
}

/**
 * Market-type prettifier. Extends the shared formatter with
 * notifier-only aliases (e.g. "MATCH_ODDS"), and falls back to a
 * generic Title-Case pass for anything we haven't mapped explicitly so
 * no raw SCREAMING_SNAKE_CASE leaks into Telegram.
 */
const NOTIFIER_MARKET_ALIASES: Record<string, string> = {
  MATCH_ODDS: "Match Odds",
  MATCH_RESULT: "Match Odds",
  MONEYLINE: "Moneyline",
  SPREAD: "Point Spread",
  TOTAL_POINTS: "Total Points",
  TEAM_TOTAL_POINTS: "Team Total",
  OVER_UNDER: "Over/Under",
  DOUBLE_CHANCE: "Double Chance",
  CORRECT_SCORE: "Correct Score",
  HALF_TIME_FULL_TIME: "HT/FT",
  DRAW_NO_BET: "Draw No Bet",
  CORNERS_EUROPEAN_HANDICAP: "Corners Handicap",
  BOTH_TEAMS_TO_SCORE: "Both Teams To Score",
};

function formatMarketType(marketType: string): string {
  if (NOTIFIER_MARKET_ALIASES[marketType]) {
    return NOTIFIER_MARKET_ALIASES[marketType];
  }
  const fromShared = formatMarketTypeBase(marketType);
  // The shared formatter returns the raw input when unknown; catch
  // that case and title-case it so we never ship SCREAMING_SNAKE_CASE.
  if (fromShared === marketType && /^[A-Z0-9_]+$/.test(marketType)) {
    return marketType
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
  return fromShared;
}

/**
 * Build a human-readable market→selection line.
 *
 *   OVER_UNDER + timeScope=1H + line=2.5 + "Over"  →  "1st Half · Over/Under 2.5 → Over"
 *   ASIAN_HANDICAP        + "Home -1.25"           →  "Handicap → Home -1.25"
 *
 * If the selection label already embeds the line ("Home -1.25"),
 * we don't re-append it. Otherwise we suffix the line so totals-style
 * selections ("Over", "Under") gain their line.
 */
function buildSelectionLine(
  marketName: string,
  selectionName: string,
  timeScope: string | null,
  familyLine: string | null,
): string {
  const market = formatMarketType(marketName);
  const scope = formatTimeScope(timeScope);
  const selectionAlreadyHasLine =
    familyLine !== null && selectionName.includes(familyLine);
  const lineSuffix =
    familyLine && !selectionAlreadyHasLine ? ` ${familyLine}` : "";
  const prefix = scope ? `${scope} · ` : "";
  return `<b>${esc(`${selectionName}${lineSuffix}`)}</b> <i>(${esc(`${prefix}${market}`)})</i>`;
}

function formatTimeScope(scope: string | null): string | null {
  if (!scope) return null;
  const s = scope.toUpperCase();
  if (s === "FT") return null; // implicit
  const map: Record<string, string> = {
    HT: "Half-time",
    "1H": "1st Half",
    "2H": "2nd Half",
    T1: "1st Half",
    T2: "2nd Half",
    P1: "1st Period",
    P2: "2nd Period",
    P3: "3rd Period",
    Q1: "1st Quarter",
    Q2: "2nd Quarter",
    Q3: "3rd Quarter",
    Q4: "4th Quarter",
    OT: "Overtime",
    ET: "Extra Time",
  };
  return map[s] ?? s;
}

/**
 * Compact score line:
 *   FT              → "📊 FT · 3-1 (HT 1-0)"
 *   AET             → "📊 AET · 3-3 (ET 3-3)"
 *   PEN             → "📊 PEN · 2-2 (Pens 5-4)"
 *   POSTPONED/ABD   → "📅 Postponed" / "🛑 Abandoned"
 *
 * Deliberately drops the team-name hint — the event title right above
 * already shows "<Home> vs <Away>", so repeating it here just adds
 * visual noise (we saw this in the 2026-04-20 screenshot review).
 */
function buildScoreLine(score: MatchScoreInfo): string | null {
  const {
    status,
    ftHome,
    ftAway,
    htHome,
    htAway,
    etHome,
    etAway,
    penHome,
    penAway,
  } = score;
  if (status === "POSTPONED") {
    return `📅 <b>Postponed</b>`;
  }
  if (status === "ABD") {
    return `🛑 <b>Abandoned</b>`;
  }

  const badge = status === "AET" ? "AET" : status === "PEN" ? "PEN" : "FT";
  const mainScore = `${ftHome}-${ftAway}`;
  const extras: string[] = [];
  if (status === "AET" && etHome != null && etAway != null) {
    extras.push(`ET ${etHome}-${etAway}`);
  } else if (status === "PEN" && penHome != null && penAway != null) {
    extras.push(`Pens ${penHome}-${penAway}`);
  }
  if (
    htHome != null &&
    htAway != null &&
    (htHome !== ftHome || htAway !== ftAway)
  ) {
    extras.push(`HT ${htHome}-${htAway}`);
  }
  const extrasPart =
    extras.length > 0 ? `  <i>(${esc(extras.join(" · "))})</i>` : "";
  return `📊 <b>${esc(badge)}</b> · <b>${esc(mainScore)}</b>${extrasPart}`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kickoffLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Math.abs(ms) < 60_000) return "kicks off now";
  if (ms > 0) return `kicks off in ${durationLabel(ms)}`;
  return `started ${durationLabel(-ms)} ago`;
}

function durationLabel(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const hrem = hours % 24;
  return hrem === 0 ? `${days}d` : `${days}d ${hrem}h`;
}

function kellyFractionLabel(f: number): string {
  if (Math.abs(f - 0.25) < 0.001) return "¼";
  if (Math.abs(f - 0.5) < 0.001) return "½";
  if (Math.abs(f - 0.75) < 0.001) return "¾";
  if (Math.abs(f - 1.0) < 0.001) return "full";
  return f.toFixed(2);
}

function evEmoji(evPct: number): string {
  if (evPct >= 5) return "🔥";
  if (evPct > 0) return "📈";
  if (evPct === 0) return "➖";
  return "📉";
}

function sportEmoji(sport?: string | null): string {
  if (!sport) return "🏟";
  const map: Record<string, string> = {
    soccer: "⚽",
    basketball: "🏀",
    tennis: "🎾",
    cricket: "🏏",
    hockey: "🏒",
    baseball: "⚾",
    american_football: "🏈",
    rugby: "🏉",
    volleyball: "🏐",
    handball: "🤾",
    table_tennis: "🏓",
    esports: "🎮",
  };
  return map[sport] ?? "🏟";
}

function formatAbsoluteTime(iso: string): string {
  const d = parseISO(iso);
  const time = format(d, "HH:mm");
  if (isSameDay(d, new Date())) return time;
  return `${format(d, "MMM d")} ${time}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// HTML parse_mode reserved chars: only < > & need escaping.
function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => {
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    return "&amp;";
  });
}

function money(n: number, currency: string): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}${currency} ${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signedMoney(n: number, currency: string): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${currency} ${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signedPct(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}
