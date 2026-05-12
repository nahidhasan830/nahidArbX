import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FEATURE_COUNT,
  FEATURE_NAMES,
  FEATURE_NAMES_HASH,
  FEATURE_VERSION,
} from "@/lib/ml/features";
import { FEATURE_CATALOG } from "@/lib/ml/feature-catalog";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";

function parsePythonFeatureNames(): string[] {
  const source = readFileSync(
    resolve(process.cwd(), "services/optimizer/app/feature_names.py"),
    "utf8",
  );
  const listMatch = source.match(
    /FEATURE_NAMES:\s*list\[str\]\s*=\s*\[([\s\S]*?)\]\s*\n\nFEATURE_COUNT/,
  );
  expect(listMatch).not.toBeNull();
  return Array.from(listMatch![1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

describe("ML feature contract", () => {
  it("keeps TS, Python, UI catalog, and shared constants aligned", () => {
    const pythonNames = parsePythonFeatureNames();
    const catalogNames = FEATURE_CATALOG.map((f) => f.name);

    expect(FEATURE_COUNT).toBe(25);
    expect(ML_FEATURE_COUNT).toBe(FEATURE_COUNT);
    expect(FEATURE_VERSION).toBe(2);
    expect(ML_FEATURE_VERSION).toBe(FEATURE_VERSION);
    expect(pythonNames).toEqual(FEATURE_NAMES);
    expect(catalogNames).toEqual(FEATURE_NAMES);
  });

  it("hashes feature names with the persisted contract hash", () => {
    const hash = createHash("sha256")
      .update(FEATURE_NAMES.join(","))
      .digest("hex");
    const pythonSource = readFileSync(
      resolve(process.cwd(), "services/optimizer/app/feature_names.py"),
      "utf8",
    );
    const exporterSource = readFileSync(
      resolve(process.cwd(), "services/optimizer/app/exporter.py"),
      "utf8",
    );

    expect(FEATURE_NAMES_HASH).toBe(hash);
    expect(pythonSource).toContain("FEATURE_NAMES_HASH");
    expect(exporterSource).toContain('key="feature_version"');
    expect(exporterSource).toContain('key="feature_names_hash"');
  });
});
