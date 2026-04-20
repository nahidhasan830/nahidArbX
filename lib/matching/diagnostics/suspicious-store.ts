/**
 * Suspicious Match Store
 *
 * Stores matches that AI has flagged as potentially incorrect.
 * Supports all matching levels: competition, event, and market.
 */

// ============================================
// Types
// ============================================

export type SuspiciousLevel = "competition" | "event" | "market";

export interface SuspiciousProviderItem {
  provider: string;
  id: string; // Original ID from provider
  name: string; // Display name (team names, competition name, market name)
  details?: Record<string, unknown>; // Additional level-specific data
}

export interface SuspiciousMatch {
  id: string;
  level: SuspiciousLevel;
  matchedId: string; // The matched group ID in the relevant store
  providerItems: SuspiciousProviderItem[];
  originalScore: number; // What our system scored it
  aiConfidence: number; // AI's confidence that it's correct (low = suspicious)
  aiReasoning: string;
  suspiciousElements: string[]; // What specifically is suspicious
  detectedAt: string;
  detectedBy: string; // "ai-verify" | "user-report"
  status: "pending" | "confirmed_correct" | "unmatched";
  resolvedAt?: string;
  resolvedBy?: string;
  // Level-specific metadata
  metadata?: {
    // For events
    homeTeamA?: string;
    awayTeamA?: string;
    homeTeamB?: string;
    awayTeamB?: string;
    competitionA?: string;
    competitionB?: string;
    startTimeA?: string;
    startTimeB?: string;
    // For competitions
    competitionNameA?: string;
    competitionNameB?: string;
    // For markets
    marketTypeA?: string;
    marketTypeB?: string;
    lineA?: number;
    lineB?: number;
  };
}

export interface NegativeExample {
  id: string;
  level: SuspiciousLevel;
  type: "wrong_match" | "wrong_rejection" | "false_positive";
  itemA: {
    provider: string;
    name: string;
    normalized: string; // Lowercase, trimmed
  };
  itemB: {
    provider: string;
    name: string;
    normalized: string;
  };
  originalScore: number;
  aiConfidence: number;
  addedAt: string;
  reason: string;
  source: string; // "ai-verify" | "user-unmatch"
  // Level-specific data for more accurate matching
  metadata?: {
    // For events - store team info separately
    homeTeamA?: string;
    awayTeamA?: string;
    homeTeamB?: string;
    awayTeamB?: string;
  };
}

export interface SuspiciousStoreStats {
  total: number;
  byLevel: Record<SuspiciousLevel, number>;
  pending: number;
  confirmedCorrect: number;
  unmatched: number;
  negativeExamples: number;
  negativeByLevel: Record<SuspiciousLevel, number>;
}

// ============================================
// Store Implementation
// ============================================

class SuspiciousMatchStore {
  private suspicious: Map<string, SuspiciousMatch> = new Map();
  private negativeExamples: NegativeExample[] = [];
  private maxSuspicious = 500;
  private maxNegativeExamples = 1000;

  // ----------------------------------------
  // Suspicious Matches
  // ----------------------------------------

  /**
   * Add a suspicious match
   */
  addSuspicious(
    match: Omit<SuspiciousMatch, "id" | "detectedAt" | "status">,
  ): SuspiciousMatch {
    const id = `sus-${match.level}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const suspicious: SuspiciousMatch = {
      ...match,
      id,
      detectedAt: new Date().toISOString(),
      status: "pending",
    };

    this.suspicious.set(id, suspicious);
    this.pruneOldSuspicious();

    return suspicious;
  }

  /**
   * Get a suspicious match by ID
   */
  getSuspicious(id: string): SuspiciousMatch | undefined {
    return this.suspicious.get(id);
  }

  /**
   * Get suspicious match by matched ID and level
   */
  getSuspiciousByMatchedId(
    matchedId: string,
    level?: SuspiciousLevel,
  ): SuspiciousMatch | undefined {
    for (const sus of this.suspicious.values()) {
      if (sus.matchedId === matchedId && (!level || sus.level === level)) {
        return sus;
      }
    }
    return undefined;
  }

  /**
   * List suspicious matches with optional filters
   */
  listSuspicious(
    options: {
      level?: SuspiciousLevel;
      status?: SuspiciousMatch["status"];
      limit?: number;
      offset?: number;
    } = {},
  ): SuspiciousMatch[] {
    let results = Array.from(this.suspicious.values());

    // Filter by level
    if (options.level) {
      results = results.filter((s) => s.level === options.level);
    }

    // Filter by status
    if (options.status) {
      results = results.filter((s) => s.status === options.status);
    }

    // Sort by detection time (newest first)
    results.sort(
      (a, b) =>
        new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || 50;
    return results.slice(offset, offset + limit);
  }

  /**
   * Mark a suspicious match as confirmed correct
   */
  confirmCorrect(
    id: string,
    resolvedBy: string = "user",
  ): { success: boolean; message: string } {
    const suspicious = this.suspicious.get(id);
    if (!suspicious) {
      return { success: false, message: "Suspicious match not found" };
    }

    if (suspicious.status !== "pending") {
      return {
        success: false,
        message: `Already resolved: ${suspicious.status}`,
      };
    }

    suspicious.status = "confirmed_correct";
    suspicious.resolvedAt = new Date().toISOString();
    suspicious.resolvedBy = resolvedBy;

    return { success: true, message: "Match confirmed as correct" };
  }

  /**
   * Mark a suspicious match as unmatched (wrong match confirmed)
   */
  markUnmatched(
    id: string,
    resolvedBy: string = "user",
  ): { success: boolean; message: string; negativeExampleId?: string } {
    const suspicious = this.suspicious.get(id);
    if (!suspicious) {
      return { success: false, message: "Suspicious match not found" };
    }

    if (suspicious.status !== "pending") {
      return {
        success: false,
        message: `Already resolved: ${suspicious.status}`,
      };
    }

    suspicious.status = "unmatched";
    suspicious.resolvedAt = new Date().toISOString();
    suspicious.resolvedBy = resolvedBy;

    // Add to negative examples if we have at least 2 provider items
    let negativeExampleId: string | undefined;
    if (suspicious.providerItems.length >= 2) {
      const itemA = suspicious.providerItems[0];
      const itemB = suspicious.providerItems[1];

      const negativeExample = this.addNegativeExample({
        level: suspicious.level,
        type: "wrong_match",
        itemA: {
          provider: itemA.provider,
          name: itemA.name,
          normalized: itemA.name.toLowerCase().trim(),
        },
        itemB: {
          provider: itemB.provider,
          name: itemB.name,
          normalized: itemB.name.toLowerCase().trim(),
        },
        originalScore: suspicious.originalScore,
        aiConfidence: suspicious.aiConfidence,
        reason: suspicious.aiReasoning,
        source: resolvedBy === "ai" ? "ai-verify" : "user-unmatch",
        metadata: suspicious.metadata
          ? {
              homeTeamA: suspicious.metadata.homeTeamA,
              awayTeamA: suspicious.metadata.awayTeamA,
              homeTeamB: suspicious.metadata.homeTeamB,
              awayTeamB: suspicious.metadata.awayTeamB,
            }
          : undefined,
      });

      negativeExampleId = negativeExample.id;
    }

    return {
      success: true,
      message: "Match marked as wrong, negative example added",
      negativeExampleId,
    };
  }

  /**
   * Remove a suspicious match
   */
  removeSuspicious(id: string): boolean {
    return this.suspicious.delete(id);
  }

  /**
   * Prune old suspicious matches (keep most recent)
   */
  private pruneOldSuspicious(): void {
    if (this.suspicious.size <= this.maxSuspicious) return;

    const sorted = Array.from(this.suspicious.entries()).sort(
      ([, a], [, b]) =>
        new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );

    // Keep only the most recent
    const toKeep = sorted.slice(0, this.maxSuspicious);
    this.suspicious = new Map(toKeep);
  }

  // ----------------------------------------
  // Negative Examples
  // ----------------------------------------

  /**
   * Add a negative example (learned from wrong match)
   */
  addNegativeExample(
    example: Omit<NegativeExample, "id" | "addedAt">,
  ): NegativeExample {
    const id = `neg-${example.level}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const negativeExample: NegativeExample = {
      ...example,
      id,
      addedAt: new Date().toISOString(),
    };

    this.negativeExamples.push(negativeExample);
    this.pruneOldNegativeExamples();

    return negativeExample;
  }

  /**
   * Get all negative examples, optionally filtered by level
   */
  getNegativeExamples(level?: SuspiciousLevel): NegativeExample[] {
    if (level) {
      return this.negativeExamples.filter((e) => e.level === level);
    }
    return [...this.negativeExamples];
  }

  /**
   * Check if a pair matches any negative example
   * Returns the matching negative example if found
   */
  checkNegativeExample(
    level: SuspiciousLevel,
    nameA: string,
    nameB: string,
    metadata?: {
      homeTeamA?: string;
      awayTeamA?: string;
      homeTeamB?: string;
      awayTeamB?: string;
    },
  ): NegativeExample | null {
    const normalize = (t: string) => t.toLowerCase().trim();
    const inputA = normalize(nameA);
    const inputB = normalize(nameB);

    for (const example of this.negativeExamples) {
      if (example.level !== level) continue;

      const exA = example.itemA.normalized;
      const exB = example.itemB.normalized;

      // Check name matching (both orientations)
      const matchNormal = exA === inputA && exB === inputB;
      const matchSwapped = exA === inputB && exB === inputA;

      if (matchNormal || matchSwapped) {
        // For events, also check team metadata if available
        if (level === "event" && metadata && example.metadata) {
          const teamsMatch = this.checkTeamMetadataMatch(
            metadata,
            example.metadata,
            matchSwapped,
          );
          if (teamsMatch) {
            return example;
          }
        } else {
          return example;
        }
      }
    }

    return null;
  }

  /**
   * Check if team metadata matches
   */
  private checkTeamMetadataMatch(
    input: {
      homeTeamA?: string;
      awayTeamA?: string;
      homeTeamB?: string;
      awayTeamB?: string;
    },
    stored: {
      homeTeamA?: string;
      awayTeamA?: string;
      homeTeamB?: string;
      awayTeamB?: string;
    },
    swapped: boolean,
  ): boolean {
    const normalize = (t?: string) => (t || "").toLowerCase().trim();

    if (swapped) {
      // Input A = Stored B, Input B = Stored A
      return (
        normalize(input.homeTeamA) === normalize(stored.homeTeamB) &&
        normalize(input.awayTeamA) === normalize(stored.awayTeamB) &&
        normalize(input.homeTeamB) === normalize(stored.homeTeamA) &&
        normalize(input.awayTeamB) === normalize(stored.awayTeamA)
      );
    } else {
      return (
        normalize(input.homeTeamA) === normalize(stored.homeTeamA) &&
        normalize(input.awayTeamA) === normalize(stored.awayTeamA) &&
        normalize(input.homeTeamB) === normalize(stored.homeTeamB) &&
        normalize(input.awayTeamB) === normalize(stored.awayTeamB)
      );
    }
  }

  /**
   * Check events specifically (convenience method)
   */
  checkNegativeEventExample(
    homeA: string,
    awayA: string,
    homeB: string,
    awayB: string,
  ): NegativeExample | null {
    // Create composite name for event
    const nameA = `${homeA} vs ${awayA}`;
    const nameB = `${homeB} vs ${awayB}`;

    return this.checkNegativeExample("event", nameA, nameB, {
      homeTeamA: homeA,
      awayTeamA: awayA,
      homeTeamB: homeB,
      awayTeamB: awayB,
    });
  }

  /**
   * Remove a negative example
   */
  removeNegativeExample(id: string): boolean {
    const index = this.negativeExamples.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.negativeExamples.splice(index, 1);
    return true;
  }

  /**
   * Prune old negative examples
   */
  private pruneOldNegativeExamples(): void {
    if (this.negativeExamples.length <= this.maxNegativeExamples) return;
    // Keep only the most recent
    this.negativeExamples = this.negativeExamples.slice(
      -this.maxNegativeExamples,
    );
  }

  // ----------------------------------------
  // Stats & Export
  // ----------------------------------------

  /**
   * Get store statistics
   */
  getStats(): SuspiciousStoreStats {
    const suspicious = Array.from(this.suspicious.values());

    const byLevel: Record<SuspiciousLevel, number> = {
      competition: 0,
      event: 0,
      market: 0,
    };

    const negativeByLevel: Record<SuspiciousLevel, number> = {
      competition: 0,
      event: 0,
      market: 0,
    };

    for (const s of suspicious) {
      byLevel[s.level]++;
    }

    for (const n of this.negativeExamples) {
      negativeByLevel[n.level]++;
    }

    return {
      total: suspicious.length,
      byLevel,
      pending: suspicious.filter((s) => s.status === "pending").length,
      confirmedCorrect: suspicious.filter(
        (s) => s.status === "confirmed_correct",
      ).length,
      unmatched: suspicious.filter((s) => s.status === "unmatched").length,
      negativeExamples: this.negativeExamples.length,
      negativeByLevel,
    };
  }

  /**
   * Export data for persistence
   */
  export(): {
    suspicious: SuspiciousMatch[];
    negativeExamples: NegativeExample[];
  } {
    return {
      suspicious: Array.from(this.suspicious.values()),
      negativeExamples: this.negativeExamples,
    };
  }

  /**
   * Import data from persistence
   */
  import(data: {
    suspicious?: SuspiciousMatch[];
    negativeExamples?: NegativeExample[];
  }): void {
    if (data.suspicious) {
      this.suspicious = new Map(data.suspicious.map((s) => [s.id, s]));
    }
    if (data.negativeExamples) {
      this.negativeExamples = data.negativeExamples;
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.suspicious.clear();
    this.negativeExamples = [];
  }
}

// ============================================
// Singleton Instance
// ============================================

let suspiciousStoreInstance: SuspiciousMatchStore | null = null;

export function getSuspiciousStore(): SuspiciousMatchStore {
  if (!suspiciousStoreInstance) {
    suspiciousStoreInstance = new SuspiciousMatchStore();
    loadSuspiciousStore();
  }
  return suspiciousStoreInstance;
}

// ============================================
// Persistence
// ============================================

import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "gemini");
const SUSPICIOUS_FILE = path.join(DATA_DIR, "suspicious-matches.json");

export function saveSuspiciousStore(): void {
  const store = getSuspiciousStore();
  const data = store.export();

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SUSPICIOUS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("[SuspiciousStore] Failed to save:", error);
  }
}

export function loadSuspiciousStore(): void {
  try {
    if (fs.existsSync(SUSPICIOUS_FILE)) {
      const content = fs.readFileSync(SUSPICIOUS_FILE, "utf-8");
      const data = JSON.parse(content);
      getSuspiciousStore().import(data);
      console.log("[SuspiciousStore] Loaded from disk");
    }
  } catch (error) {
    console.error("[SuspiciousStore] Failed to load:", error);
  }
}
