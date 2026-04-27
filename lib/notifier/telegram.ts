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
  BetPlacedEvent,
  BetSettledEvent,
  BetErrorEvent,
  MatchScoreInfo,
  NotificationChannel,
  NotificationEvent,
  OptimizerRunCompletedEvent,
  MlRunCompletedEvent,
  OptimizerRunStartedEvent,
  SystemEvent,
} from "./types";
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
  url: string;
}

function formatMlRunCompleted(e: MlRunCompletedEvent): FormattedMessage {
  const lines: string[] = [];

  lines.push(`🧠 <b>ML Matcher Batch Complete</b>`);
  lines.push(`Total pairs processed: <b>${e.processed}</b>`);
  lines.push(`✅ Auto-merged: <b>${e.merged}</b>`);
  lines.push(`❌ Auto-rejected: <b>${e.rejected}</b>`);
  lines.push(`⚠️ Needs human review: <b>${e.escalated}</b>`);
  lines.push(`⏱ Duration: <b>${(e.durationMs / 1000).toFixed(1)}s</b>`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return {
    text: lines.join("\n"),
  };
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
            formatted.buttons.map((b) => ({ text: b.text, url: b.url })),
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
    case "optimizer:run_started":
      return formatOptimizerRunStarted(event);
    case "optimizer:run_completed":
      return formatOptimizerRunCompleted(event);
    case "ml:run_completed":
      return formatMlRunCompleted(event);
  }
}

// --------------------------------------------------------------------
// bet:placed
// --------------------------------------------------------------------

function formatPlaced(e: BetPlacedEvent): FormattedMessage {
  const modeLabel = e.mode === "auto" ? "Auto" : "Manual";
  const modeEmoji = e.mode === "auto" ? "🤖" : "✋";
  const potentialReturn = e.stake * e.odds;
  const selectionLine = buildSelectionLine(
    e.marketName,
    e.selectionName,
    e.timeScope ?? null,
    e.familyLine ?? null,
  );

  const lines: string[] = [];
  lines.push(`✅ <b>Bet Placed</b> · ${modeEmoji} ${esc(modeLabel)}`);
  lines.push(`🏟 <b>${esc(e.eventName)}</b>`);
  if (e.competition) lines.push(`🏆 ${esc(e.competition)}`);
  if (e.eventStartTime)
    lines.push(`⏰ ${esc(capitalize(kickoffLabel(e.eventStartTime)))}`);
  lines.push(`🎯 ${selectionLine}`);
  lines.push(
    `💰 <b>${esc(money(e.stake, e.currency))}</b> @ <b>${esc(e.odds.toFixed(2))}</b>`,
  );
  lines.push(`🎁 Return <b>${esc(money(potentialReturn, e.currency))}</b>`);
  if (typeof e.evPct === "number") {
    lines.push(`${evEmoji(e.evPct)} EV <b>${esc(signedPct(e.evPct))}</b>`);
  }
  if (typeof e.kellyFraction === "number" && e.kellyFraction > 0) {
    lines.push(`📏 Kelly ${esc(kellyFractionLabel(e.kellyFraction))}`);
  }
  lines.push(`🏦 ${esc(e.providerDisplayName)}`);
  if (e.ticketId) lines.push(`🎫 <code>${esc(e.ticketId)}</code>`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return {
    text: lines.join("\n"),
    buttons: buildButtons(e.dashboardUrl, e.gradeUrl),
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
  const heldFor =
    e.placedAt && e.at
      ? durationLabel(new Date(e.at).getTime() - new Date(e.placedAt).getTime())
      : null;
  const selectionLine = buildSelectionLine(
    e.marketName,
    e.selectionName,
    e.timeScope ?? null,
    e.familyLine ?? null,
  );

  const lines: string[] = [];
  lines.push(
    `${outcomeIcon[e.outcome]} <b>${esc(outcomeTitle[e.outcome])}</b>`,
  );
  lines.push(`🏟 <b>${esc(e.eventName)}</b>`);
  if (e.competition) lines.push(`🏆 ${esc(e.competition)}`);
  if (heldFor) lines.push(`⏱ Held ${esc(heldFor)}`);

  if (e.matchScore) {
    const scoreLine = buildScoreLine(e.matchScore);
    if (scoreLine) lines.push(scoreLine);
    const resultHint = buildResultHint(e.marketName, e.matchScore);
    if (resultHint) lines.push(`🏅 <i>${esc(resultHint)}</i>`);
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
  if (e.settledBySource) lines.push(`🔎 ${esc(e.settledBySource)}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  return {
    text: lines.join("\n"),
    buttons: buildButtons(e.dashboardUrl, e.gradeUrl),
  };
}

// --------------------------------------------------------------------
// bet:error
// --------------------------------------------------------------------

function formatError(e: BetErrorEvent): FormattedMessage {
  const lines: string[] = [];
  const modeLabel = e.mode === "auto" ? "Auto" : "Manual";
  const modeEmoji = e.mode === "auto" ? "🤖" : "✋";
  const categoryLabel = e.reasonCategory
    ? REASON_CATEGORY_LABEL[e.reasonCategory]
    : null;

  lines.push(
    `⚠️ <b>Placement Failed</b> · ${modeEmoji} ${esc(modeLabel)}${
      categoryLabel ? ` · <i>${esc(categoryLabel)}</i>` : ""
    }`,
  );
  lines.push(`🏟 <b>${esc(e.eventName)}</b>`);
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
      `💵 Tried <b>${esc(money(e.stake, currency))}</b> @ <b>${esc(
        e.odds.toFixed(2),
      )}</b> → return <b>${esc(money(potentialReturn, currency))}</b>`,
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
    lines.push(`📊 Market min ${minStr} · max ${maxStr}${cur}`);
  }
  if (typeof e.balance === "number") {
    lines.push(
      `💼 Balance <b>${esc(money(e.balance, e.currency ?? "BDT"))}</b>`,
    );
  }

  lines.push(`❌ ${truncate(esc(e.error), 400)}`);
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
// optimizer:run_started
// --------------------------------------------------------------------

function formatOptimizerRunStarted(
  e: OptimizerRunStartedEvent,
): FormattedMessage {
  const lines: string[] = [];
  lines.push(`🚀 <b>${esc(e.name)}</b> · Optimisation run started`);
  lines.push(`🤖 Algorithm: <b>${esc(formatAlgorithm(e.searchAlgorithm))}</b>`);
  lines.push(
    `🧮 Trials: <b>${e.nTrialsTarget.toLocaleString()}</b> · 🎲 Seed <code>${e.rngSeed}</code>`,
  );
  lines.push(`🧪 Validation: <b>${esc(e.cvStrategyLabel)}</b>`);

  if (e.betCount != null && e.betCount > 0) {
    lines.push(
      `📊 Dataset: <b>${e.betCount.toLocaleString()}</b> settled bets`,
    );
  }
  if (e.scopeSummary) {
    lines.push(`🎯 Scope: <i>${esc(e.scopeSummary)}</i>`);
  }

  // ETA block — omitted entirely when we have no basis for a guess, so we
  // never mislead the operator with a fabricated finish time.
  if (e.estimatedDurationSec != null && e.estimatedFinishAt != null) {
    lines.push("───");
    const etaLabel = durationLabel(e.estimatedDurationSec * 1000);
    const basisSuffix = e.estimationBasis
      ? ` <i>(${esc(e.estimationBasis)})</i>`
      : "";
    lines.push(`⏱ ETA: <b>~${esc(etaLabel)}</b>${basisSuffix}`);
    lines.push(
      `🗓 Expected finish: <b>${esc(formatAbsoluteTime(e.estimatedFinishAt))}</b>`,
    );
  }

  lines.push(`🏷 Source: <code>${esc(e.createdBy || "manual")}</code>`);
  lines.push(`🕒 Started: ${esc(formatAbsoluteTime(e.startedAt))}`);

  const buttons: InlineKey[] = [];
  if (e.dashboardUrl)
    buttons.push({ text: "📊 Open run", url: e.dashboardUrl });

  return {
    text: lines.join("\n"),
    buttons: buttons.length > 0 ? buttons : undefined,
  };
}

// --------------------------------------------------------------------
// optimizer:run_completed
// --------------------------------------------------------------------

function formatOptimizerRunCompleted(
  e: OptimizerRunCompletedEvent,
): FormattedMessage {
  const statusBadge = (() => {
    if (e.status === "completed") return "✅ <b>Completed</b>";
    if (e.status === "failed") return "⚠️ <b>Failed</b>";
    return "⏹ <b>Cancelled</b>";
  })();

  const lines: string[] = [];
  lines.push(`🧪 <b>${esc(e.name)}</b> · ${statusBadge}`);
  lines.push(`🤖 Algorithm: <b>${esc(formatAlgorithm(e.searchAlgorithm))}</b>`);

  const durWord = e.status === "completed" ? "Finished" : "Stopped";
  const durLabel = durationLabel(e.durationSec * 1000);
  lines.push(`⏱ ${durWord} in <b>${esc(durLabel)}</b>`);

  const trialsLine =
    e.nPareto != null && e.nPareto > 0
      ? `🧮 Trials: <b>${e.nTrialsDone.toLocaleString()}</b>/${e.nTrialsTarget.toLocaleString()} · <b>${e.nPareto}</b> on Pareto`
      : `🧮 Trials: <b>${e.nTrialsDone.toLocaleString()}</b>/${e.nTrialsTarget.toLocaleString()}`;
  lines.push(trialsLine);

  if (typeof e.bestComposite === "number" && Number.isFinite(e.bestComposite)) {
    lines.push(`🏆 Best composite: <b>${esc(e.bestComposite.toFixed(2))}</b>`);
  }

  // Best-trial block — only meaningful when the run completed with ≥ 1 trial.
  if (e.status === "completed" && e.best) {
    lines.push("───");
    const b = e.best;

    if (b.roiPct != null && Number.isFinite(b.roiPct)) {
      const ciSuffix =
        b.roiCiLow != null &&
        b.roiCiHigh != null &&
        Number.isFinite(b.roiCiLow) &&
        Number.isFinite(b.roiCiHigh)
          ? `  <i>(95% CI ${esc(signedPct(b.roiCiLow))} → ${esc(signedPct(b.roiCiHigh))})</i>`
          : "";
      lines.push(
        `📈 Best trial ROI: <b>${esc(signedPct(b.roiPct))}</b>${ciSuffix}`,
      );
    }

    const riskParts: string[] = [];
    if (b.sharpe != null && Number.isFinite(b.sharpe)) {
      riskParts.push(`Sharpe <b>${esc(b.sharpe.toFixed(2))}</b>`);
    }
    if (b.sortino != null && Number.isFinite(b.sortino)) {
      riskParts.push(`Sortino <b>${esc(b.sortino.toFixed(2))}</b>`);
    }
    if (b.maxDrawdownPct != null && Number.isFinite(b.maxDrawdownPct)) {
      riskParts.push(
        `Max DD <b>${esc(Math.abs(b.maxDrawdownPct).toFixed(1))}%</b>`,
      );
    }
    if (riskParts.length > 0) lines.push(`📊 ${riskParts.join(" · ")}`);

    const robustnessParts: string[] = [];
    if (b.deflatedSharpe != null && Number.isFinite(b.deflatedSharpe)) {
      robustnessParts.push(`DSR <b>${esc(b.deflatedSharpe.toFixed(2))}</b>`);
    }
    if (
      b.probabilisticSharpe != null &&
      Number.isFinite(b.probabilisticSharpe)
    ) {
      robustnessParts.push(
        `PSR <b>${esc(b.probabilisticSharpe.toFixed(2))}</b>`,
      );
    }
    if (b.sampleSize != null && b.sampleSize > 0) {
      robustnessParts.push(`n=<b>${b.sampleSize.toLocaleString()}</b>`);
    }
    if (robustnessParts.length > 0)
      lines.push(`🛡 ${robustnessParts.join(" · ")}`);
  }

  // Failure reason — truncated to keep the card readable.
  if (e.status === "failed" && e.error) {
    lines.push(`🛑 ${esc(truncate(e.error, 280))}`);
  }

  // Source: manual vs scheduled.
  lines.push(`🏷 Source: <code>${esc(e.createdBy || "manual")}</code>`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);

  const buttons: InlineKey[] = [];
  if (e.dashboardUrl)
    buttons.push({ text: "📊 Open run", url: e.dashboardUrl });
  if (e.topTrialUrl && e.status === "completed" && e.best) {
    buttons.push({ text: "🏆 Top trial", url: e.topTrialUrl });
  }

  return {
    text: lines.join("\n"),
    buttons: buttons.length > 0 ? buttons : undefined,
  };
}

const ALGORITHM_LABEL: Record<string, string> = {
  ensemble: "Ensemble",
  tpe: "TPE (Bayesian)",
  nsga2: "NSGA-II",
  random: "Random",
  "ml-xgboost": "ML / XGBoost",
};

function formatAlgorithm(algo: string): string {
  return ALGORITHM_LABEL[algo] ?? algo;
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
  lines.push(`📝 ${esc(e.message)}`);
  lines.push(`🕒 ${esc(formatAbsoluteTime(e.at))}`);
  return { text: lines.join("\n") };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function buildButtons(
  dashboardUrl?: string,
  gradeUrl?: string,
): InlineKey[] | undefined {
  const btns: InlineKey[] = [];
  if (dashboardUrl) btns.push({ text: "📊 Dashboard", url: dashboardUrl });
  if (gradeUrl) btns.push({ text: "🧠 Google AI", url: gradeUrl });
  return btns.length > 0 ? btns : undefined;
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
  return `<i>${esc(`${prefix}${market}`)}</i> → <b>${esc(`${selectionName}${lineSuffix}`)}</b>`;
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

/**
 * One-liner that explains who won and by how much. Only meaningful for
 * 1X2-style markets — skipped for Asian Handicap, O/U, BTTS, etc.,
 * where "Home wins by 2" is misleading (the bet may still lose).
 */
function buildResultHint(
  marketName: string,
  score: MatchScoreInfo,
): string | null {
  if (score.status === "POSTPONED" || score.status === "ABD") return null;
  const m = marketName.toUpperCase();
  const isOneXTwo =
    m === "MATCH_ODDS" ||
    m === "MATCH_RESULT" ||
    m === "MONEYLINE" ||
    m === "DNB" ||
    m === "DRAW_NO_BET";
  if (!isOneXTwo) return null;
  const { ftHome, ftAway } = score;
  if (ftHome > ftAway) {
    return `Home wins by ${ftHome - ftAway}`;
  }
  if (ftAway > ftHome) {
    return `Away wins by ${ftAway - ftHome}`;
  }
  return `Draw`;
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

function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return time;
  const date = d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
  return `${date} ${time}`;
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
