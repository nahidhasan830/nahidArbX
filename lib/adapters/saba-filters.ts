import type { Provider } from "../types";

const SABA_PROVIDER: Provider = "saba-sportsbook";

export const SABA_SYNTHETIC_MARKET_COMPETITION_SQL_RE =
  "^[[:space:]]*fantasy match[[:space:]]*$|[[:space:]]-[[:space:]](1st HALF vs 2nd HALF|BOOKING|BOOKINGS|CORNER|CORNERS|EXTRA TIME|FREE KICK|FREE KICKS|GOAL KICK|GOAL KICKS|OFFSIDE|OFFSIDES|OWN GOAL|OWN GOALS|PENALTY|PENALTIES|RED CARD|RED CARDS|SINGLE TEAM OVER/UNDER|SPECIALS([[:space:]]+[[:alpha:]][[:alpha:][:space:]]*)?|SUBSTITUTION|SUBSTITUTIONS|THROW IN|THROW INS|WHICH TEAM WILL ADVANCE TO NEXT ROUND|WINNER|SPECIFIC[[:space:]]+[0-9]+[[:space:]]*MINS([[:space:]]+(NUMBER OF CORNERS|TOTAL BOOKINGS))?|NUMBER OF CORNERS|TOTAL BOOKINGS|TOTAL CORNER[[:space:]]*&[[:space:]]*TOTAL GOAL|TOTAL GOALS?[[:space:]]+MINUTES)$";

export const SABA_SYNTHETIC_MARKET_TEAM_SQL_RE =
  "[[:space:]]\\+[[:space:]]|(^|[[:space:]-])vs($|[[:space:]-])|[0-9]{1,2}:[0-9]{2}[[:space:]]*-[[:space:]]*[0-9]{1,2}:[0-9]{2}|no\\.?[[:space:]]*of[[:space:]]+corners|total[[:space:]]+bookings";

const SPECIAL_SOCCER_LEAGUE_SUFFIX_RE =
  /\s-\s(?:1st HALF vs 2nd HALF|BOOKINGS?|CORNERS?|EXTRA TIME|FREE KICKS?|GOAL KICKS?|OFFSIDES?|OWN GOALS?|PENALT(?:Y|IES)|RED CARDS?|SINGLE TEAM OVER\/UNDER|SPECIALS(?:\s+[A-Z][A-Z\s]*)?|SUBSTITUTIONS?|THROW INS?|WHICH TEAM WILL ADVANCE TO NEXT ROUND|WINNER|SPECIFIC\s+\d+\s*MINS(?:\s+(?:NUMBER OF CORNERS|TOTAL BOOKINGS))?|NUMBER OF CORNERS|TOTAL BOOKINGS|TOTAL CORNER\s*&\s*TOTAL GOAL|TOTAL GOALS?\s+MINUTES)$/i;

const TEAM_MARKET_FRAGMENT_RE =
  /(?:\s\+\s|(?:^|[\s-])vs(?:$|[\s-])|\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}|\bno\.?\s*of\s+corners\b|\btotal\s+bookings\b)/i;

export function isSabaSyntheticMarketFixture(input: {
  provider?: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
}): boolean {
  if (input.provider !== SABA_PROVIDER) return false;

  const teams = [input.homeTeam, input.awayTeam];
  if (/^fantasy match$/i.test(input.competition)) return true;
  if (SPECIAL_SOCCER_LEAGUE_SUFFIX_RE.test(input.competition)) return true;
  return teams.some((team) => TEAM_MARKET_FRAGMENT_RE.test(team));
}
