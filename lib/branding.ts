
export const BRAND = {
  name: "NahidArbX",

  tagline: "Real-time value-bet finder across betting providers",

  email: {
    from: "NahidArbX <noreply@nahidarbx.com>",
    name: "NahidArbX",
  },
} as const;

export const BRAND_STYLES = {
  gradientText: "from-cyan-400 to-blue-500",
  gradientButton: "from-cyan-600 to-blue-600",
  gradientButtonHover: "from-cyan-500 to-blue-500",
  gradientAvatar: "from-cyan-500 to-blue-500",

  focusRing: "focus:ring-cyan-500",

  textLink: "text-cyan-400",
  textLinkHover: "hover:text-cyan-300",
  textInfo: "text-cyan-200",
  textIcon: "text-cyan-400",

  bgSolid: "bg-cyan-600",
  bgSolidHover: "hover:bg-cyan-500",
  bgMuted: "bg-cyan-500/20",
  bgInfoBox: "bg-cyan-500/10",
  borderInfo: "border-cyan-500/30",
  bgActionHover: "hover:bg-cyan-500/10",

  badgeAdmin: "bg-cyan-500/20 text-cyan-300",
  badgeSession: "bg-cyan-500/20 text-cyan-400",

  spinnerBorder: "border-cyan-500",

  toggleEnabled: "bg-cyan-600",
} as const;

export type BrandConfig = typeof BRAND;
export type BrandStyles = typeof BRAND_STYLES;
