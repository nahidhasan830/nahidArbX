export interface EventFingerprintInput {
  homeTeam: string;
  awayTeam: string;
  competition: string;
}

function sideIdentity(
  e: EventFingerprintInput,
  aliasTeam: (s: string) => string,
  aliasComp: (s: string) => string,
): string {
  const teams = [aliasTeam(e.homeTeam), aliasTeam(e.awayTeam)].sort();
  return `${teams[0]}|${teams[1]}|${aliasComp(e.competition)}`;
}

export function computePairKey(
  a: EventFingerprintInput,
  b: EventFingerprintInput,
  alias: {
    team: (s: string) => string;
    competition: (s: string) => string;
  },
): string {
  const sideA = sideIdentity(a, alias.team, alias.competition);
  const sideB = sideIdentity(b, alias.team, alias.competition);
  return sideA < sideB ? `${sideA}::${sideB}` : `${sideB}::${sideA}`;
}
