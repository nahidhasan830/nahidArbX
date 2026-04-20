/**
 * Model tier metadata — safe to import from client components.
 *
 * Lives in its own file so the UI can read `MODEL_LABELS` / `ModelTier`
 * without pulling in `@google/genai` (which is a server-only dep).
 *
 * **Default tier is `lite`** (Gemini 3.1 Flash-Lite). It's the cheapest
 * model, ~10× less than Flash, with comparable quality for short,
 * factual prompts (score extraction, alias verification). Flash is
 * balanced; Pro is reserved for deep-reasoning tasks.
 */

export type ModelTier = "lite" | "flash" | "pro";

export const DEFAULT_MODEL_TIER: ModelTier = "lite";

export const MODEL_LABELS: Record<
  ModelTier,
  { label: string; tagline: string }
> = {
  lite: {
    label: "Lite",
    tagline: "Cheapest — default for most calls",
  },
  flash: {
    label: "Flash",
    tagline: "Balanced — when Lite looks shaky",
  },
  pro: {
    label: "Pro",
    tagline: "Expert — deep reasoning",
  },
};

export const MODEL_TIERS: ModelTier[] = ["lite", "flash", "pro"];
