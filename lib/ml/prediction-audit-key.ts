import { createHash } from "node:crypto";

function keyNumber(value: number | null | undefined, digits: number): string {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "null";
}

export function buildPredictionKey(input: {
  betId: string;
  modelVersion: number | null;
  softProvider: string;
  softOdds: number;
  sharpOdds: number;
  mlScore: number;
  modelEdgePct: number | null;
  mlFeatureVersion: number;
  mlFeatureNamesHash: string;
}): string {
  const raw = [
    input.betId,
    input.modelVersion == null ? "model:null" : `model:${input.modelVersion}`,
    input.softProvider,
    keyNumber(input.softOdds, 4),
    keyNumber(input.sharpOdds, 4),
    keyNumber(input.mlScore, 6),
    keyNumber(input.modelEdgePct, 4),
    input.mlFeatureVersion,
    input.mlFeatureNamesHash,
  ].join("|");

  return createHash("sha256").update(raw).digest("hex");
}
