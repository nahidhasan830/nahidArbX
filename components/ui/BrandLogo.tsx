import { BRAND, BRAND_STYLES } from "@/lib/branding";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  /** Size variant */
  size?: "sm" | "md" | "lg";
  /** Additional className */
  className?: string;
}

const sizeClasses = {
  sm: "text-lg",
  md: "text-xl",
  lg: "text-3xl",
} as const;

/**
 * Styled brand logo component with gradient text.
 * Uses centralized branding from lib/branding.ts
 */
export function BrandLogo({ size = "md", className }: BrandLogoProps) {
  return (
    <span
      className={cn(
        "font-bold bg-gradient-to-r bg-clip-text text-transparent",
        BRAND_STYLES.gradientText,
        sizeClasses[size],
        className,
      )}
    >
      {BRAND.name}
    </span>
  );
}
