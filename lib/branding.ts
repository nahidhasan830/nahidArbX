/**
 * Centralized Branding Configuration
 *
 * Single source of truth for all branding across the application.
 * Change values here to update branding everywhere.
 *
 * NOTE: Tailwind requires static class names for JIT compilation.
 * When changing colors, update both the color names AND the class strings.
 */

export const BRAND = {
  /** Application name */
  name: "NahidArbX",

  /** Short tagline for meta description */
  tagline: "Real-time value-bet finder across betting providers",

  /** Email configuration */
  email: {
    from: "NahidArbX <noreply@nahidarbx.com>",
    name: "NahidArbX",
  },
} as const;

/**
 * Pre-built Tailwind class combinations for common UI patterns.
 * Use these in components for consistent styling.
 *
 * To change the brand colors, update these classes:
 * - Primary: cyan-{shade} → your-color-{shade}
 * - Accent: blue-{shade} → your-color-{shade}
 */
export const BRAND_STYLES = {
  // === GRADIENTS ===
  /** Logo/heading text gradient */
  gradientText: "from-cyan-400 to-blue-500",
  /** Primary button gradient */
  gradientButton: "from-cyan-600 to-blue-600",
  /** Primary button hover gradient */
  gradientButtonHover: "from-cyan-500 to-blue-500",
  /** Avatar/profile gradient */
  gradientAvatar: "from-cyan-500 to-blue-500",

  // === FOCUS STATES ===
  /** Input focus ring */
  focusRing: "focus:ring-cyan-500",

  // === TEXT COLORS ===
  /** Link text color */
  textLink: "text-cyan-400",
  /** Link hover color */
  textLinkHover: "hover:text-cyan-300",
  /** Info/muted text */
  textInfo: "text-cyan-200",
  /** Icon color */
  textIcon: "text-cyan-400",

  // === BACKGROUNDS ===
  /** Solid background (buttons, tabs) */
  bgSolid: "bg-cyan-600",
  /** Solid background hover */
  bgSolidHover: "hover:bg-cyan-500",
  /** Muted/transparent background */
  bgMuted: "bg-cyan-500/20",
  /** Info box background */
  bgInfoBox: "bg-cyan-500/10",
  /** Info box border */
  borderInfo: "border-cyan-500/30",
  /** Hover background for actions */
  bgActionHover: "hover:bg-cyan-500/10",

  // === BADGES ===
  /** Admin badge styling */
  badgeAdmin: "bg-cyan-500/20 text-cyan-300",
  /** Session/status badge */
  badgeSession: "bg-cyan-500/20 text-cyan-400",

  // === SPINNERS ===
  /** Loading spinner border */
  spinnerBorder: "border-cyan-500",

  // === TOGGLES ===
  /** Toggle enabled state */
  toggleEnabled: "bg-cyan-600",
} as const;

/** Type for the BRAND config */
export type BrandConfig = typeof BRAND;
export type BrandStyles = typeof BRAND_STYLES;
