/**
 * Pinnacle API URL Builders
 *
 * Centralized URL construction for all Pinnacle API endpoints.
 */

import { config } from "../../config";
import { SOCCER_SPORT_ID } from "./schemas";
import { addDays, format } from "date-fns";

/**
 * Build URL for fetching events list.
 * Used by: events adapter, debug-machine/pinnacle-fixtures
 */
export function buildEventsUrl(): string {
  const { daysAhead, pageSize } = config.providers.pinnacle;

  const now = new Date();
  const fromDate = `${format(now, "yyyy-MM-dd")}T00:00:00`;

  // Calculate end date (today + daysAhead)
  const endDate = addDays(now, daysAhead);
  const toDate = `${format(endDate, "yyyy-MM-dd")}T23:59:59`;

  // Pinnacle's path router requires the timezone segment for this endpoint.
  // Without it, the same request shape returns a 404 "No static resource".
  const tzOffset = now.getTimezoneOffset();
  const tzSign = tzOffset <= 0 ? "+" : "-";
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
  const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, "0");
  const tz = `${tzSign}${tzHours}:${tzMins}`;

  const params = [
    `odds-format/decimal`,
    `view-mode/ASIAN`,
    `sport-id/${SOCCER_SPORT_ID}`,
    `period-type/TODAY`,
    `country-ids/ALL`,
    `league-ids/ALL`,
    `period-id/-1`,
    `market-type/ALL`,
    `tz/${encodeURIComponent(tz)}`,
    `from-date/${fromDate}`,
    `to-date/${toDate}`,
    `sort-by/LEAGUE`,
    `page-no/1`,
    `page-size/${pageSize}`,
    `locale/en-US`,
  ].join("/");

  return `/proteus-member-service/after-login/odds/v3/events/${params}?keySearch=`;
}

/**
 * Build URL for fetching single event markets.
 * Used by: atoms adapter, debug-machine/pinnacle-markets
 */
export function buildEventMarketsUrl(eventId: string): string {
  return `/proteus-member-service/after-login/odds/v3/event/decimal/${eventId}/locale/en-US`;
}
