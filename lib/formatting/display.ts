
import {
  applyTeamAlias as _applyTeamAlias,
  applyCompetitionAlias as _applyCompetitionAlias,
  normalize as _normalize,
  normalizeCompetition as _normalizeCompetition,
  preNormalizeEvent as _preNormalizeEvent,
  preNormalizeAll as _preNormalizeAll,
  type PreNormalizedNames,
} from "@/lib/matching/normalize";

export {
  _applyTeamAlias as applyTeamAlias,
  _applyCompetitionAlias as applyCompetitionAlias,
  _normalize as normalize,
  _normalizeCompetition as normalizeCompetition,
  _preNormalizeEvent as preNormalizeEvent,
  _preNormalizeAll as preNormalizeAll,
};
export type { PreNormalizedNames };


export function formatTeamName(name: string): string {
  if (!name) return "—";
  const aliased = _applyTeamAlias(name);
  const normalized = _normalize(name);
  if (aliased && aliased !== normalized) {
    return aliased
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return titleCase(name);
}


export function formatCompetitionName(name: string): string {
  if (!name || name.toLowerCase() === "unknown") return "—";
  const aliased = _applyCompetitionAlias(name);
  const normalized = _normalizeCompetition(name);
  if (aliased && aliased !== normalized) {
    return aliased
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return titleCase(name);
}


export function formatEventTitle(
  homeTeam: string,
  awayTeam: string,
  competition?: string | null,
): string {
  const home = formatTeamName(homeTeam);
  const away = formatTeamName(awayTeam);
  const comp = competition ? formatCompetitionName(competition) : null;
  return comp ? `${home} vs ${away} · ${comp}` : `${home} vs ${away}`;
}


function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9]+$/.test(word)) return word;
      if (word.includes("'")) {
        return word
          .split("'")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("'");
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}
