

export type SuspiciousLevel = "competition" | "event" | "market";

export interface SuspiciousProviderItem {
  provider: string;
  id: string;
  name: string;
  details?: Record<string, unknown>;
}

export interface SuspiciousMatch {
  id: string;
  level: SuspiciousLevel;
  matchedId: string;
  providerItems: SuspiciousProviderItem[];
  originalScore: number;
  aiConfidence: number;
  aiReasoning: string;
  suspiciousElements: string[];
  detectedAt: string;
  detectedBy: string;
  status: "pending" | "confirmed_correct" | "unmatched";
  resolvedAt?: string;
  resolvedBy?: string;
  metadata?: {
    homeTeamA?: string;
    awayTeamA?: string;
    homeTeamB?: string;
    awayTeamB?: string;
    competitionA?: string;
    competitionB?: string;
    startTimeA?: string;
    startTimeB?: string;
    competitionNameA?: string;
    competitionNameB?: string;
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
    normalized: string;
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
  source: string;
  metadata?: {
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


class SuspiciousMatchStore {
  private suspicious: Map<string, SuspiciousMatch> = new Map();
  private negativeExamples: NegativeExample[] = [];
  private maxSuspicious = 500;
  private maxNegativeExamples = 1000;


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

  getSuspicious(id: string): SuspiciousMatch | undefined {
    return this.suspicious.get(id);
  }

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

  listSuspicious(
    options: {
      level?: SuspiciousLevel;
      status?: SuspiciousMatch["status"];
      limit?: number;
      offset?: number;
    } = {},
  ): SuspiciousMatch[] {
    let results = Array.from(this.suspicious.values());

    if (options.level) {
      results = results.filter((s) => s.level === options.level);
    }

    if (options.status) {
      results = results.filter((s) => s.status === options.status);
    }

    results.sort(
      (a, b) =>
        new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );

    const offset = options.offset || 0;
    const limit = options.limit || 50;
    return results.slice(offset, offset + limit);
  }

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

  removeSuspicious(id: string): boolean {
    return this.suspicious.delete(id);
  }

  private pruneOldSuspicious(): void {
    if (this.suspicious.size <= this.maxSuspicious) return;

    const sorted = Array.from(this.suspicious.entries()).sort(
      ([, a], [, b]) =>
        new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );

    const toKeep = sorted.slice(0, this.maxSuspicious);
    this.suspicious = new Map(toKeep);
  }


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

  getNegativeExamples(level?: SuspiciousLevel): NegativeExample[] {
    if (level) {
      return this.negativeExamples.filter((e) => e.level === level);
    }
    return [...this.negativeExamples];
  }

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

      const matchNormal = exA === inputA && exB === inputB;
      const matchSwapped = exA === inputB && exB === inputA;

      if (matchNormal || matchSwapped) {
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

  checkNegativeEventExample(
    homeA: string,
    awayA: string,
    homeB: string,
    awayB: string,
  ): NegativeExample | null {
    const nameA = `${homeA} vs ${awayA}`;
    const nameB = `${homeB} vs ${awayB}`;

    return this.checkNegativeExample("event", nameA, nameB, {
      homeTeamA: homeA,
      awayTeamA: awayA,
      homeTeamB: homeB,
      awayTeamB: awayB,
    });
  }

  removeNegativeExample(id: string): boolean {
    const index = this.negativeExamples.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.negativeExamples.splice(index, 1);
    return true;
  }

  private pruneOldNegativeExamples(): void {
    if (this.negativeExamples.length <= this.maxNegativeExamples) return;
    this.negativeExamples = this.negativeExamples.slice(
      -this.maxNegativeExamples,
    );
  }


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

  export(): {
    suspicious: SuspiciousMatch[];
    negativeExamples: NegativeExample[];
  } {
    return {
      suspicious: Array.from(this.suspicious.values()),
      negativeExamples: this.negativeExamples,
    };
  }

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

  clear(): void {
    this.suspicious.clear();
    this.negativeExamples = [];
  }
}


let suspiciousStoreInstance: SuspiciousMatchStore | null = null;

export function getSuspiciousStore(): SuspiciousMatchStore {
  if (!suspiciousStoreInstance) {
    suspiciousStoreInstance = new SuspiciousMatchStore();
    loadSuspiciousStore();
  }
  return suspiciousStoreInstance;
}


import * as fs from "fs";
import * as path from "path";
import { logger } from "../../shared/logger";

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
    logger.error("SuspiciousStore", "Failed to save", error);
  }
}

export function loadSuspiciousStore(): void {
  try {
    if (fs.existsSync(SUSPICIOUS_FILE)) {
      const content = fs.readFileSync(SUSPICIOUS_FILE, "utf-8");
      const data = JSON.parse(content);
      getSuspiciousStore().import(data);
      logger.info("SuspiciousStore", "Loaded from disk");
    }
  } catch (error) {
    logger.error("SuspiciousStore", "Failed to load", error);
  }
}
