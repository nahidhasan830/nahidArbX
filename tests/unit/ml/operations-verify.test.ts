/**
 * Phase 11: ML Operations Verification Tests
 *
 * Ensures TS, Python, and UI feature contracts stay aligned,
 * constants are in sync, and the feature catalog is complete.
 * These run in CI without a database connection.
 */

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

// ── Helpers ──────────────────────────────────────────────────────

function parsePythonFeatureNames(): {
  names: string[];
  count: number;
  version: number;
  hash: string;
} {
  const source = readFileSync(
    resolve(process.cwd(), "services/optimizer/app/feature_names.py"),
    "utf8",
  );
  const listMatch = source.match(
    /FEATURE_NAMES:\s*list\[str\]\s*=\s*\[([\s\S]*?)\]\s*\n\nFEATURE_COUNT/,
  );
  expect(listMatch).not.toBeNull();
  const names = Array.from(listMatch![1].matchAll(/"([^"]+)"/g), (m) => m[1]);

  const countMatch = source.match(/FEATURE_COUNT\s*=\s*(\d+)/);
  const versionMatch = source.match(/FEATURE_VERSION\s*=\s*(\d+)/);
  const count = countMatch ? parseInt(countMatch[1], 10) : 0;
  const version = versionMatch ? parseInt(versionMatch[1], 10) : 0;
  const hash = createHash("sha256").update(names.join(",")).digest("hex");

  return { names, count, version, hash };
}

// ── Tests ────────────────────────────────────────────────────────

describe("Phase 11: Operations verification", () => {
  describe("Feature contract alignment", () => {
    it("TS FEATURE_NAMES has exactly 25 unique entries", () => {
      expect(FEATURE_NAMES).toHaveLength(25);
      expect(new Set(FEATURE_NAMES).size).toBe(25);
    });

    it("FEATURE_COUNT matches ML_FEATURE_COUNT", () => {
      expect(FEATURE_COUNT).toBe(ML_FEATURE_COUNT);
      expect(FEATURE_COUNT).toBe(25);
    });

    it("FEATURE_VERSION matches ML_FEATURE_VERSION", () => {
      expect(FEATURE_VERSION).toBe(ML_FEATURE_VERSION);
      expect(FEATURE_VERSION).toBe(2);
    });

    it("Python FEATURE_NAMES exactly matches TS", () => {
      const py = parsePythonFeatureNames();
      expect(py.names).toEqual(FEATURE_NAMES);
      expect(py.count).toBe(FEATURE_COUNT);
      expect(py.version).toBe(FEATURE_VERSION);
    });

    it("Python FEATURE_NAMES_HASH matches TS", () => {
      const py = parsePythonFeatureNames();
      expect(py.hash).toBe(FEATURE_NAMES_HASH);
    });

    it("UI FEATURE_CATALOG order and names match TS", () => {
      const catalogNames = FEATURE_CATALOG.map((f) => f.name);
      expect(catalogNames).toEqual(FEATURE_NAMES);
      expect(FEATURE_CATALOG).toHaveLength(FEATURE_COUNT);
    });

    it("FEATURE_NAMES_HASH is a valid SHA-256 hex digest", () => {
      expect(FEATURE_NAMES_HASH).toMatch(/^[a-f0-9]{64}$/);
      const recomputed = createHash("sha256")
        .update(FEATURE_NAMES.join(","))
        .digest("hex");
      expect(FEATURE_NAMES_HASH).toBe(recomputed);
    });
  });

  describe("Feature catalog completeness", () => {
    it("every catalog entry has required fields", () => {
      for (const entry of FEATURE_CATALOG) {
        expect(entry.name).toBeTruthy();
        expect(entry.label).toBeTruthy();
        expect(entry.desc).toBeTruthy();
        expect(entry.cat).toBeTruthy();
        expect(entry.fmt).toBeTruthy();
      }
    });

    it("catalog covers all valid categories", () => {
      const categories = new Set(FEATURE_CATALOG.map((f) => f.cat));
      expect(categories.has("Value")).toBe(true);
      expect(categories.has("Odds")).toBe(true);
      expect(categories.has("Movement")).toBe(true);
      expect(categories.has("Market")).toBe(true);
      expect(categories.has("Staking")).toBe(true);
    });

    it("catalog format types are all valid", () => {
      const validFmts = new Set([
        "pct",
        "odds",
        "ms",
        "int",
        "float",
        "binary",
        "dir",
      ]);
      for (const entry of FEATURE_CATALOG) {
        expect(validFmts.has(entry.fmt)).toBe(true);
      }
    });
  });

  describe("Cross-pipeline consistency", () => {
    it("first feature is ev_pct and last is num_markets_same_event", () => {
      expect(FEATURE_NAMES[0]).toBe("ev_pct");
      expect(FEATURE_NAMES[24]).toBe("num_markets_same_event");
    });

    it("ONNX exporter embeds feature version and hash metadata", () => {
      const exporterSource = readFileSync(
        resolve(process.cwd(), "services/optimizer/app/exporter.py"),
        "utf8",
      );
      expect(exporterSource).toContain('key="feature_version"');
      expect(exporterSource).toContain('key="feature_names_hash"');
    });

    it("feature_names.py includes hash computation", () => {
      const pySource = readFileSync(
        resolve(process.cwd(), "services/optimizer/app/feature_names.py"),
        "utf8",
      );
      expect(pySource).toContain("FEATURE_NAMES_HASH");
      expect(pySource).toContain("hashlib.sha256");
    });
  });
});
