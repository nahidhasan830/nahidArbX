/**
 * Shared styles for diagnostics tables
 * Use these constants to maintain consistent styling across all diagnostics components
 */

// Panel wrapper
export const panelWrapper =
  "h-full flex flex-col bg-zinc-900/30 rounded-lg border border-zinc-800 overflow-hidden";

// Header styles
export const panelHeader =
  "flex items-center justify-between px-4 py-3 border-b border-zinc-800/50";
export const panelTitle = "text-base font-semibold text-zinc-100";
export const panelDescription = "text-sm text-zinc-500";

// Tab styles
export const tabContainer =
  "flex items-center gap-1 px-3 py-2 border-b border-zinc-800/50";
export const tabButton =
  "px-3 py-1.5 text-sm font-medium rounded-md transition-all";
export const tabButtonActive = "bg-zinc-800 text-zinc-100";
export const tabButtonInactive =
  "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50";

// Search & Filter styles
export const searchContainer =
  "flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/30";
export const searchInput =
  "h-8 pl-9 text-sm bg-zinc-800/50 border-zinc-700/50 focus:border-violet-500/50";
export const searchIcon =
  "absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500";
export const filterButton =
  "px-3 py-1 text-xs font-medium rounded-md transition-colors";
export const filterButtonActive = "bg-zinc-800 text-zinc-200";
export const filterButtonInactive = "text-zinc-500 hover:text-zinc-300";

// Column header styles
export const columnHeader =
  "flex items-center gap-3 px-4 py-2 border-b border-zinc-800/20 text-xs text-zinc-500 uppercase tracking-wider font-medium";

// Row styles
export const tableRow =
  "flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800/30 transition-colors";
export const tableRowSelected = "bg-violet-500/5";

// Cell content styles
export const cellPrimary = "text-sm text-zinc-300";
export const cellSecondary = "text-xs text-zinc-500";
export const cellMono = "font-mono";

// Badge styles
export const badge = "text-xs px-2 py-1 rounded";
export const badgeAuto = "bg-zinc-800 text-zinc-400";
export const badgeManual = "bg-violet-500/10 text-violet-400";
export const badgeCount = "text-xs tabular-nums text-zinc-500";

// Icon sizes
export const iconSm = "w-3.5 h-3.5";
export const iconMd = "w-4 h-4";
export const iconLg = "w-5 h-5";

// Button styles
export const actionButton = "h-8 text-sm";
export const iconButton =
  "p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300";
export const deleteButton =
  "p-1.5 rounded hover:bg-red-500/10 text-zinc-600 hover:text-red-500 transition-colors";

// Empty states
export const emptyState =
  "h-full flex flex-col items-center justify-center text-zinc-500 p-8";
export const emptyStateIcon = "w-10 h-10 mb-3 opacity-30";
export const emptyStateText = "text-base";
export const emptyStateSubtext = "text-sm mt-1";

// Stats bar
export const statsBar =
  "flex items-center justify-between px-4 py-2 border-b border-zinc-800/20 text-xs text-zinc-500";
