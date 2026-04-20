/**
 * Auth Components - Index
 *
 * Feature Permission Pattern:
 * - useFeature(id): Hook for checking single feature permission
 * - useFeatures([ids]): Hook for checking multiple features
 * - <Feature id="...">: Declarative component for conditional rendering
 *
 * Example:
 * ```tsx
 * // Hook pattern
 * const { enabled } = useFeature("sync-all");
 * if (!enabled) return null;
 *
 * // Component pattern
 * <Feature id="export-data" fallback={<UpgradePrompt />}>
 *   <ExportButton />
 * </Feature>
 * ```
 */

export {
  AuthProvider,
  useAuth,
  // Feature permission hooks
  useFeature,
  useFeatures,
  // Feature permission components
  Feature,
  RequirePermission,
  RequireAdmin,
} from "./AuthProvider";
export { ProfileMenu } from "./ProfileMenu";
export { UserManagementModal } from "./UserManagementModal";
export { LockedStatePlaceholder } from "./LockedStatePlaceholder";
