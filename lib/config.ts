import {
  SYNC_INTERVAL_MS,
  PINNACLE_DAYS_AHEAD,
  DEFAULT_PAGE_SIZE,
} from "./shared/constants";

export const config = {
  fetchInterval: parseInt(
    process.env.FETCH_INTERVAL_MS || String(SYNC_INTERVAL_MS),
  ),
  providers: {
    pinnacle: {
      baseUrl: "https://www.ps388win.com",
      daysAhead: parseInt(
        process.env.PINNACLE_DAYS_AHEAD || String(PINNACLE_DAYS_AHEAD),
      ),
      pageSize: parseInt(
        process.env.PINNACLE_PAGE_SIZE || String(DEFAULT_PAGE_SIZE),
      ),
    },
  },
};
