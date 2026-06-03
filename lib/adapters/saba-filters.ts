import type { Provider } from "../types";

const SABA_PROVIDER: Provider = "saba-sportsbook";

const SPECIAL_SOCCER_LEAGUE_SUFFIX_RE =
  /\s-\s(?:1st HALF vs 2nd HALF|BOOKING|CORNERS|EXTRA TIME|FREE KICK|GOAL KICK|OFFSIDE|OWN GOAL|PENALTY|RED CARD|SINGLE TEAM OVER\/UNDER|SUBSTITUTION|THROW IN|WHICH TEAM WILL ADVANCE TO NEXT ROUND|WINNER)$/i;

export function isSabaSyntheticMarketFixture(input: {
  provider?: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
}): boolean {
  if (input.provider !== SABA_PROVIDER) return false;

  const teams = [input.homeTeam, input.awayTeam];
  if (/^fantasy match$/i.test(input.competition)) return true;
  if (teams.some((team) => /\s\+\s/.test(team))) return true;
  if (SPECIAL_SOCCER_LEAGUE_SUFFIX_RE.test(input.competition)) return true;
  return teams.some((team) => /(?:^|[\s-])vs(?:$|[\s-])/i.test(team));
}
