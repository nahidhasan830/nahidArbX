/**
 * Locate an event in the current store that matches one side of a UI pair.
 * Requires home/away slot alignment while tolerating internal-ID rotation via
 * aliased team names + time-bucket minute for identity.
 *
 * Shared between the match-review route (approve/reject flow, AI auto-merge)
 * and the matcher's reconcile pass.
 */

import type { NormalizedEvent } from "../types";
import { getEvents } from "../store";
import { applyTeamAlias } from "./normalize";

export interface EventSideRef {
  provider: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string | Date;
}

export function locateEventBySide(
  side: EventSideRef,
  events: NormalizedEvent[] = getEvents(),
): NormalizedEvent | undefined {
  const canonHome = applyTeamAlias(side.homeTeam);
  const canonAway = applyTeamAlias(side.awayTeam);
  const minute = Math.floor(new Date(side.startTime).getTime() / 60_000);
  return events.find((e) => {
    if (!e.providers[side.provider as keyof typeof e.providers]) return false;
    const eMinute = Math.floor(new Date(e.startTime).getTime() / 60_000);
    if (eMinute !== minute) return false;
    const eHome = applyTeamAlias(e.homeTeam);
    const eAway = applyTeamAlias(e.awayTeam);
    return eHome === canonHome && eAway === canonAway;
  });
}
