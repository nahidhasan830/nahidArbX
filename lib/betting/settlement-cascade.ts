/**
 * In the merged schema, settlement is inline in the bets table — no
 * separate cascade is needed. Outcome + P&L are written directly to the
 * bet row via applySettlement() in the bets repository.
 *
 * This file is kept (empty export) to avoid breaking any existing imports
 * during the transition. Remove after all callers are updated.
 */

// Re-export eq so anybody else wanting to extend can use it without a
// separate drizzle import.
export { eq } from "drizzle-orm";
