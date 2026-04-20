/**
 * Live Scores Module
 *
 * Export all score-related functionality
 */

// Types
export type {
  LiveScore,
  LiveScoreMessage,
  DisplayScore,
  CornersScore,
  // Multi-source types
  ScoreSource,
  ScoreConfidence,
  SourceScore,
  MultiSourceScore,
  MultiSourceDisplayScore,
  ScoreDiscrepancy,
} from "./types";
export { stateToPeriod, toDisplayScore, bcStateToPeriod } from "./types";

// Store (legacy Pinnacle-only)
export {
  setLiveScore,
  getLiveScore,
  getDisplayScore,
  getAllLiveScores,
  clearLiveScore,
  clearAllScores,
  getScoreCount,
  cleanupOldScores,
  // Corners
  setCornersScore,
  getCornersScore,
  clearCornersScore,
  getCornersScoreCount,
} from "./store";

// Multi-source store
export {
  registerProviderEventId,
  registerEventMappings,
  getNormalizedId,
  getProviderEventId,
  setSourceScore,
  getMultiSourceScore,
  getMultiSourceDisplayScore,
  getScoreByProviderEventId,
  getDiscrepancyEvents,
  getConfidenceStats,
  getMultiScoreCount,
  cleanupOldMultiScores,
  clearAllMultiScores,
} from "./multi-source-store";

// BC Poller
export {
  startBCScorePolling,
  stopBCScorePolling,
  addBCEventsToPolling,
  removeBCEventsFromPolling,
  isBCPollingActive,
  getBCPollingCount,
  pollBCScoresNow,
} from "./bc-poller";

// WebSocket
export {
  subscribeToScore,
  unsubscribeFromScore,
  subscribeToScores,
  disconnectScores,
  isScoreWebSocketConnected,
  getSubscribedEventIds,
} from "./websocket";
