import { bestSim } from "@/lib/matching/string-sim";

const stringSimilarity = { compareTwoStrings: bestSim };


function normalizeTeamName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/-/g, " ")
      .replace(/^(fk|fc|pfc|afc|sc|sv|tsv|vfb|vfl|bsc|1\.)\s+/i, "")
      .trim()
  );
}


export function getTeamMatchScore(
  selectionName: string,
  teamName: string,
): number {
  if (!selectionName || !teamName) return 0;

  const selNorm = normalizeTeamName(selectionName);
  const teamNorm = normalizeTeamName(teamName);

  const selLower = selectionName.toLowerCase();
  const teamLower = teamName.toLowerCase();

  if (selNorm === teamNorm || selLower === teamLower) return 1.0;

  const isSubstring =
    selNorm.includes(teamNorm) ||
    teamNorm.includes(selNorm) ||
    selLower.includes(teamLower) ||
    teamLower.includes(selLower);

  if (isSubstring) {
    const shorter = Math.min(teamNorm.length, selNorm.length);
    const longer = Math.max(teamNorm.length, selNorm.length);
    const coverage = shorter / longer;
    return 0.8 + coverage * 0.15;
  }

  const selWords = selNorm.split(/\s+/).filter((w) => w.length > 2);
  const teamWords = teamNorm.split(/\s+/).filter((w) => w.length > 2);

  let matchingWords = 0;
  for (const teamWord of teamWords) {
    if (
      selWords.some(
        (sw) =>
          sw === teamWord || sw.includes(teamWord) || teamWord.includes(sw),
      )
    ) {
      matchingWords++;
    }
  }

  const wordMatchRatio =
    teamWords.length > 0 ? matchingWords / teamWords.length : 0;
  if (wordMatchRatio >= 0.5) {
    return Math.max(0.7, stringSimilarity.compareTwoStrings(selNorm, teamNorm));
  }

  return stringSimilarity.compareTwoStrings(selNorm, teamNorm);
}

export function matchTeamSide(
  selectionName: string,
  homeTeam: string,
  awayTeam: string,
): "home" | "away" | null {
  const homeScore = getTeamMatchScore(selectionName, homeTeam);
  const awayScore = getTeamMatchScore(selectionName, awayTeam);

  const minThreshold = 0.25;

  if (homeScore < minThreshold && awayScore < minThreshold) {
    return null;
  }

  if (homeScore > awayScore) return "home";
  if (awayScore > homeScore) return "away";

  return null;
}

export function isSameTeam(selectionName: string, teamName: string): boolean {
  if (!selectionName || !teamName) return false;
  const similarity = stringSimilarity.compareTwoStrings(
    selectionName.toLowerCase(),
    teamName.toLowerCase(),
  );
  return similarity >= 0.5;
}


export function parseTeamsFromEventName(
  eventName: string,
): { home: string; away: string } | null {
  const separators = [/ v /i, / vs /i, / - /];

  for (const sep of separators) {
    const parts = eventName.split(sep);
    if (parts.length === 2) {
      return {
        home: parts[0].trim(),
        away: parts[1].trim(),
      };
    }
  }

  return null;
}
