/**
 * Feature Registry - Single Source of Truth
 *
 * All permissionable features are defined here.
 * Each feature can be toggled per-user by admin.
 *
 * Pattern follows PROVIDER_REGISTRY in lib/providers/registry.ts
 */

// ============================================
// Types
// ============================================

export interface FeatureMetadata {
  id: string;
  displayName: string;
  description: string;
  category: "view" | "action" | "data";
  defaultEnabled: boolean;
  adminOnly?: boolean;
  implemented?: boolean; // false = coming soon, cannot be toggled
}

// ============================================
// Registry
// ============================================

export const FEATURE_REGISTRY = {
  // ============================================
  // Core View Features
  // ============================================
  "event-details": {
    id: "event-details",
    displayName: "Event Details",
    description: "View detailed event information",
    category: "view" as const,
    defaultEnabled: true,
    implemented: false, // Coming soon
  },
  "odds-comparison": {
    id: "odds-comparison",
    displayName: "Odds Comparison",
    description: "Side-by-side odds across providers",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "stake-calculator": {
    id: "stake-calculator",
    displayName: "Stake Calculator",
    description: "View calculated stake amounts",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },

  // ============================================
  // Search & Filter Features
  // ============================================
  search: {
    id: "search",
    displayName: "Text Search",
    description: "Search events by name",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "filter-provider": {
    id: "filter-provider",
    displayName: "Provider Filter",
    description: "Filter by betting provider",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "filter-profit": {
    id: "filter-profit",
    displayName: "Profit Filter",
    description: "Filter by minimum value bet percentage",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "filter-market": {
    id: "filter-market",
    displayName: "Market Filter",
    description: "Filter by market type",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "filter-time": {
    id: "filter-time",
    displayName: "Time Filter",
    description: "Filter by event time",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "filter-suspicious": {
    id: "filter-suspicious",
    displayName: "Suspicious Filter",
    description: "Filter suspicious high-profit arbs",
    category: "view" as const,
    defaultEnabled: false,
    implemented: true,
  },

  // ============================================
  // Betting Mode Features
  // ============================================
  "value-betting-mode": {
    id: "value-betting-mode",
    displayName: "Value Betting Mode",
    description: "Enable value bet detection based on sharp odds",
    category: "view" as const,
    defaultEnabled: true, // DEFAULT ON - primary mode for all users
    implemented: true,
  },

  // ============================================
  // Health & Status Features
  // ============================================
  "health-status": {
    id: "health-status",
    displayName: "Health Status",
    description: "View provider connection status",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "health-metrics": {
    id: "health-metrics",
    displayName: "Health Metrics",
    description: "View detailed health metrics",
    category: "view" as const,
    defaultEnabled: false,
    implemented: false, // Coming soon
  },
  "sync-status": {
    id: "sync-status",
    displayName: "Sync Status",
    description: "View current sync status",
    category: "view" as const,
    defaultEnabled: true,
    implemented: true,
  },

  // ============================================
  // Action Features
  // ============================================
  "copy-odds": {
    id: "copy-odds",
    displayName: "Copy Odds",
    description: "Copy odds/raw data to clipboard",
    category: "action" as const,
    defaultEnabled: true,
    implemented: true,
  },
  "export-data": {
    id: "export-data",
    displayName: "Export Data",
    description: "Export data to CSV/JSON",
    category: "action" as const,
    defaultEnabled: false,
    implemented: false, // Coming soon
  },



  // ============================================
  // Admin Features
  // ============================================
  "user-management": {
    id: "user-management",
    displayName: "User Management",
    description: "Manage users and permissions",
    category: "action" as const,
    defaultEnabled: false,
    adminOnly: true,
    implemented: true,
  },
  "view-activity-logs": {
    id: "view-activity-logs",
    displayName: "Activity Logs",
    description: "View system activity logs",
    category: "data" as const,
    defaultEnabled: false,
    adminOnly: true,
    implemented: false, // Coming soon
  },
  "system-settings": {
    id: "system-settings",
    displayName: "System Settings",
    description: "Modify system configuration",
    category: "action" as const,
    defaultEnabled: false,
    adminOnly: true,
    implemented: false, // Coming soon
  },
} as const;

// ============================================
// Derived Types
// ============================================

export type FeatureId = keyof typeof FEATURE_REGISTRY;
export const FEATURE_IDS = Object.keys(FEATURE_REGISTRY) as FeatureId[];

// ============================================
// Helper Functions
// ============================================

/**
 * Get feature metadata by ID
 */
export function getFeature(id: string): FeatureMetadata | undefined {
  return FEATURE_REGISTRY[id as FeatureId];
}

/**
 * Get display name for feature
 */
export function getFeatureDisplayName(id: string): string {
  return FEATURE_REGISTRY[id as FeatureId]?.displayName ?? id;
}

/**
 * Check if feature is admin-only
 */
export function isAdminOnlyFeature(id: string): boolean {
  const feature = FEATURE_REGISTRY[id as FeatureId];
  if (!feature) return false;
  return "adminOnly" in feature ? feature.adminOnly : false;
}

/**
 * Get default enabled state for feature
 */
export function getFeatureDefaultEnabled(id: string): boolean {
  return FEATURE_REGISTRY[id as FeatureId]?.defaultEnabled ?? false;
}

/**
 * Get all features grouped by category
 */
export function getFeaturesByCategory(): Record<string, FeatureMetadata[]> {
  const categories: Record<string, FeatureMetadata[]> = {
    view: [],
    action: [],
    data: [],
  };

  for (const feature of Object.values(FEATURE_REGISTRY)) {
    categories[feature.category].push(feature);
  }

  return categories;
}

/**
 * Get user-assignable features (excludes admin-only)
 */
export function getUserAssignableFeatures(): FeatureMetadata[] {
  return Object.values(FEATURE_REGISTRY).filter(
    (f) => !("adminOnly" in f && f.adminOnly),
  );
}
