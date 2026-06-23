
import { setOddsBatch, applyProviderSnapshot } from "../store";
import { formatError } from "../../shared/errors";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import type { AtomsFetchOptions } from "../../adapters/unified-registry";
import { logger } from "../../shared/logger";

export interface FetchContext {
  providerEventId: string;
  normalizedEventId: string;
  homeTeam: string;
  awayTeam: string;
  options: AtomsFetchOptions;
  resolvedSelections?: Record<string, string>;
}

export abstract class BaseAtomsAdapter {
  abstract readonly providerId: ProviderKey;

  protected abstract fetchRawData(ctx: FetchContext): Promise<unknown>;

  protected abstract extractOdds(
    rawData: unknown,
    ctx: FetchContext,
  ): NormalizedOddsEntry[];

  async fetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
    homeTeam: string,
    awayTeam: string,
    options: AtomsFetchOptions = {},
  ): Promise<number> {
    const ctx: FetchContext = {
      providerEventId,
      normalizedEventId,
      homeTeam,
      awayTeam,
      options,
    };

    try {
      const rawData = await this.fetchRawData(ctx);
      if (!rawData) return 0;

      const entries = this.extractOdds(rawData, ctx);

      if (entries.length > 0) {
        setOddsBatch(entries);
      }

      return entries.length;
    } catch (error) {
      logger.warn(
        "AtomsBase",
        `[${this.providerId}] Error for event ${providerEventId}: ${formatError(error)}`,
      );
      return 0;
    }
  }

  public processRawOdds(rawData: unknown, ctx: FetchContext): number {
    try {
      const entries = this.extractOdds(rawData, ctx);
      applyProviderSnapshot(ctx.normalizedEventId, this.providerId, entries);
      return entries.length;
    } catch (error) {
      logger.error(
        "AtomsBase",
        `[${this.providerId}] Error processing raw odds for event ${ctx.providerEventId}: ${formatError(error)}`,
      );
      return 0;
    }
  }
}
