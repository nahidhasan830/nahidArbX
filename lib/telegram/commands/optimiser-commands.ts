/**
 * ML model commands:
 *   /models — list recent models with metrics
 *   /model  — deployed model detail
 *   /mlstatus — live scorer status from engine
 */

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mlModels } from "@/lib/db/schema";
import { engineGet } from "@/lib/engine-proxy";
import { registerCommand } from "../registry";
import { esc, header, kvList } from "../format";

// ── /models ──────────────────────────────────────────────────────────────

registerCommand({
  name: "models",
  usage: "/models [count]",
  description: "List recent ML models with headline metrics.",
  explanation:
    "Shows the most recent ML models from the training pipeline with their " +
    "status, AUC-ROC, Deflated Sharpe, PBO, and training sample count. " +
    "Default shows 5; pass a number for more.",
  group: "read",
  async handler({ args, reply }) {
    const count = Math.min(parseInt(args[0] ?? "5") || 5, 20);

    const models = await db
      .select()
      .from(mlModels)
      .orderBy(desc(mlModels.createdAt))
      .limit(count);

    if (models.length === 0) {
      await reply(
        "ℹ️ No ML models found. The training pipeline hasn't run yet.",
      );
      return { alreadyReplied: true };
    }

    const lines = [header("🤖", `ML Models (latest ${models.length})`)];

    for (const m of models) {
      const statusIcon =
        m.status === "deployed"
          ? "🟢"
          : m.status === "validated"
            ? "🔵"
            : m.status === "training"
              ? "🟡"
              : m.status === "retired"
                ? "⚪"
                : "❓";

      lines.push("");
      lines.push(`${statusIcon} <b>v${m.version}</b> — ${m.status}`);

      const details: string[] = [];
      details.push(`${m.trainingSamples} samples`);
      if (m.oosAucRoc != null)
        details.push(`AUC ${Number(m.oosAucRoc).toFixed(3)}`);
      if (m.deflatedSharpe != null)
        details.push(`DSR ${Number(m.deflatedSharpe).toFixed(2)}`);
      if (m.pbo != null) details.push(`PBO ${Number(m.pbo).toFixed(3)}`);

      lines.push(`  ${details.join(" · ")}`);
    }

    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /model ───────────────────────────────────────────────────────────────

registerCommand({
  name: "model",
  usage: "/model [version]",
  description: "Show detailed info for the deployed (or specified) ML model.",
  explanation:
    "Shows full metrics for the currently deployed ML model — AUC-ROC, " +
    "Deflated Sharpe, PBO, calibration error, log loss, ROI, and top 5 " +
    "features by importance. Pass a version number to inspect a specific model.",
  group: "read",
  async handler({ args, reply }) {
    let model;

    if (args[0]) {
      const version = parseInt(args[0]);
      if (isNaN(version)) {
        await reply("⚠️ Version must be a number.");
        return { alreadyReplied: true };
      }
      [model] = await db
        .select()
        .from(mlModels)
        .where(eq(mlModels.version, version))
        .limit(1);
    } else {
      [model] = await db
        .select()
        .from(mlModels)
        .where(eq(mlModels.status, "deployed"))
        .orderBy(desc(mlModels.deployedAt))
        .limit(1);
    }

    if (!model) {
      await reply("ℹ️ No deployed model found.");
      return { alreadyReplied: true };
    }

    const kv: [string, string][] = [
      ["Version", `v${model.version}`],
      ["Status", model.status],
      ["Type", model.modelType],
      ["Samples", model.trainingSamples.toLocaleString()],
      ["Features", String(model.featureCount)],
    ];

    if (model.oosAucRoc != null)
      kv.push(["AUC-ROC", Number(model.oosAucRoc).toFixed(4)]);
    if (model.deflatedSharpe != null)
      kv.push(["Deflated Sharpe", Number(model.deflatedSharpe).toFixed(4)]);
    if (model.pbo != null) kv.push(["PBO", Number(model.pbo).toFixed(4)]);
    if (model.calibrationError != null)
      kv.push(["Calibration Error", Number(model.calibrationError).toFixed(6)]);
    if (model.oosLogLoss != null)
      kv.push(["Log Loss", Number(model.oosLogLoss).toFixed(6)]);
    if (model.oosRoiMean != null)
      kv.push(["OOS ROI", `${Number(model.oosRoiMean).toFixed(4)}%`]);

    const lines = [header("🤖", `ML Model v${model.version}`), kvList(kv)];

    // Feature importance top 5
    if (
      model.featureImportance &&
      typeof model.featureImportance === "object"
    ) {
      const fi = model.featureImportance as Record<string, number>;
      const sorted = Object.entries(fi)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      if (sorted.length > 0) {
        lines.push("");
        lines.push("<b>Top Features:</b>");
        for (const [name, importance] of sorted) {
          lines.push(`  ${esc(name)}: ${importance.toFixed(4)}`);
        }
      }
    }

    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /mlstatus ────────────────────────────────────────────────────────────

registerCommand({
  name: "mlstatus",
  usage: "/mlstatus",
  description: "Live ML scorer status from the engine.",
  explanation:
    "Queries the engine HTTP API for the ONNX scorer's real-time state: " +
    "whether a model is loaded, which version, total bets scored, and " +
    "average inference time. Useful for confirming that a newly deployed " +
    "model is active and the scorer is healthy.",
  group: "read",
  async handler({ reply }) {
    try {
      const status = await engineGet<{
        modelLoaded: boolean;
        modelVersion: number | null;
        modelPath: string | null;
        featureCount: number;
        totalScored: number;
        avgInferenceMs: number;
        lastInferenceMs: number;
      }>("/engine/ml/status");

      if (!status) {
        await reply("⚠️ Engine returned empty response for scorer status.");
        return { alreadyReplied: true };
      }

      const kv: [string, string][] = [
        ["Model Loaded", status.modelLoaded ? "🟢 yes" : "⚪ no"],
        [
          "Version",
          status.modelVersion != null ? `v${status.modelVersion}` : "—",
        ],
        ["Features", String(status.featureCount)],
        ["Total Scored", status.totalScored.toLocaleString()],
        ["Avg Inference", `${status.avgInferenceMs.toFixed(2)} ms`],
        ["Last Inference", `${status.lastInferenceMs.toFixed(2)} ms`],
      ];

      await reply([header("🧠", "ML Scorer"), kvList(kv)].join("\n"));
    } catch (err) {
      await reply(`⚠️ Engine unreachable: ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});
