export type SearchQueryVariant = {
  query: string;
  reason: string;
};

const MAX_VERTEX_VARIANTS = 32;

const DATE_TIME_PATTERN =
  /\b\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s+UTC)?)?\b/i;
const CLUB_WORD_PATTERN = /\b(?:club|SC|FC|CF|CD|CA|EC)\b/gi;
const ONE_WORD_PARTICLES = new Set([
  "da",
  "das",
  "de",
  "del",
  "do",
  "dos",
  "el",
  "la",
  "las",
  "los",
  "the",
  "y",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripQuotes(value: string): string {
  return value.replace(/["“”]/g, "");
}

function expandReserveShorthand(value: string): string {
  const reserveContext = /\bres(?:erve|erves)?\b|\breserve league\b|\([Rr]\)/i.test(
    value,
  );
  const withParentheticalReserve = value.replace(
    /\((?:R|Res|Reserve|Reserves)\)/gi,
    " reserve ",
  );
  if (!reserveContext) return withParentheticalReserve;
  return withParentheticalReserve.replace(/\bR\b/gi, "reserve");
}

function stripParentheticalCodes(value: string): string {
  return normalizeWhitespace(value.replace(/\([A-Z]{2,4}\)/g, " "));
}

function stripParentheticalDescriptors(value: string): string {
  return normalizeWhitespace(
    value.replace(/\([^)]*(?:\bin\b|\bmins?\b|\d+x\d+)[^)]*\)/gi, " "),
  );
}

function stripResultMarkers(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\((?:PEN|AET)\)/gi, " ")
      .replace(/\b(?:PEN|AET)\b/gi, " "),
  );
}

function expandFootballAbbreviations(value: string): string {
  return normalizeWhitespace(
    expandReserveShorthand(value)
      .replace(/\bEstud\.(?=\W|$)/gi, "Estudiantes")
      .replace(/\bInd\.?(?=\W|$)/gi, "Independiente")
      .replace(/\bAtl\.?(?=\W|$)/gi, "Atletico")
      .replace(/\bDep\.?(?=\W|$)/gi, "Deportivo")
      .replace(/\bGyE\b/g, "Gimnasia y Esgrima")
      .replace(/\bRes\b/gi, "reserve"),
  );
}

function stripClubSuffixes(value: string): string {
  return normalizeWhitespace(value.replace(CLUB_WORD_PATTERN, " "));
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const clean = normalizeWhitespace(value);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }
  return unique;
}

function teamSurfaceVariants(surface: string): string[] {
  const clean = compactSearchSyntax(surface);
  const withoutClubWords = stripClubSuffixes(clean);
  const variants = [clean, withoutClubWords];
  const hadClubWord = withoutClubWords !== clean;
  const tokens = withoutClubWords.split(" ").filter(Boolean);

  if (
    hadClubWord &&
    tokens.length === 1 &&
    ONE_WORD_PARTICLES.has(tokens[0]?.toLowerCase() ?? "")
  ) {
    variants.pop();
  }

  if (hadClubWord && tokens.length >= 3) {
    variants.push(tokens.slice(0, -1).join(" "));
  }

  return uniqueValues(variants);
}

function stripFixtureCompetitionContext(value: string): string | null {
  const match = value.match(
    /^(.*?\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s+UTC)?)?)(?:\s+.*)?\s+(?:football\s+)?fixture$/i,
  );
  if (!match) return null;
  return normalizeWhitespace(`${match[1]} football fixture`);
}

function stripFixtureTime(value: string): string | null {
  const clean = normalizeWhitespace(value);
  const withoutTime = normalizeWhitespace(
    clean.replace(
      /\b(\d{4}-\d{2}-\d{2})\s+\d{1,2}:\d{2}(?:\s+UTC)?\b/i,
      "$1",
    ),
  );
  return withoutTime !== clean ? withoutTime : null;
}

function stripFixtureDate(value: string): string | null {
  const clean = normalizeWhitespace(value);
  const date = clean.match(DATE_TIME_PATTERN);
  if (!date || date.index === undefined) return null;
  const subject = normalizeWhitespace(clean.slice(0, date.index));
  if (subject.split(" ").length < 2) return null;
  return `${subject} football fixture`;
}

function reserveCoreFixtureQuery(value: string): string | null {
  const clean = compactSearchSyntax(value);
  if (!/\breserve|reserves\b/i.test(clean)) return null;
  const date = clean.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (!date?.index) return null;
  const core = normalizeWhitespace(
    clean
      .slice(0, date.index)
      .replace(/\b(?:reserve|reserves|club|fc|cf|sc|cd|ca|ec)\b/gi, " "),
  );
  if (core.split(" ").length < 2) return null;
  return `${core} ${date[0]} football fixture`;
}

function splitFixtureSubjectQueries(value: string): string[] {
  const clean = compactSearchSyntax(value);
  const match = clean.match(
    /^(.*?)\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s+UTC)?)?)(?:\s+(.*?))?\s+(?:football\s+)?fixture$/i,
  );
  if (!match) return [];

  const subject = normalizeWhitespace(match[1] ?? "");
  const date = normalizeWhitespace(match[2] ?? "");
  const context = normalizeWhitespace(match[3] ?? "");
  const tokens = subject.split(" ").filter(Boolean);
  if (tokens.length < 4 || !date) return [];

  const queries: string[] = [];
  const mid = Math.floor(tokens.length / 2);
  const splits = [mid, mid + 1, mid - 1, mid + 2, mid - 2].filter(
    (split) => split >= 2 && split <= tokens.length - 2,
  );
  const seenSplits = new Set<number>();

  for (const split of splits) {
    if (seenSplits.has(split)) continue;
    seenSplits.add(split);
    const sides = [
      normalizeWhitespace(tokens.slice(0, split).join(" ")),
      normalizeWhitespace(tokens.slice(split).join(" ")),
    ];
    for (const side of sides) {
      for (const surface of teamSurfaceVariants(side)) {
        queries.push(`${surface} ${date} football fixture`);
        if (context) {
          queries.push(`${surface} ${date} ${context} football fixture`);
          queries.push(`${surface} ${context} football fixture`);
          queries.push(`${surface} ${context} football club`);
        }
        queries.push(`${surface} football fixture`);
      }
    }
  }

  return uniqueValues(queries);
}

function plusCompoundFixtureQueries(query: string): string[] {
  if (!query.includes("+")) return [];
  const dateMatch = query.match(DATE_TIME_PATTERN);
  if (!dateMatch) return [];
  const date = normalizeWhitespace(dateMatch[0] ?? "");
  const queries: string[] = [];

  const quoted = query.match(
    /^"([^"]*\+[^"]*)"\s+"([^"]*\+[^"]*)"\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s+UTC)?)?)/i,
  );
  if (quoted) {
    const left = (quoted[1] ?? "").split("+").flatMap(teamSurfaceVariants);
    const right = (quoted[2] ?? "").split("+").flatMap(teamSurfaceVariants);
    for (const a of left) {
      for (const b of right) {
        queries.push(`${a} ${b} ${date} football fixture`);
        queries.push(`${a} ${b} football fixture`);
      }
    }
    return uniqueValues(queries);
  }

  const beforeDate = normalizeWhitespace(query.slice(0, dateMatch.index));
  const unquoted = beforeDate.match(/^(.+?)\s+\+\s+(.+?)\s+(.+?)\s+\+\s+(.+)$/);
  if (!unquoted) return [];
  const left = [
    ...(unquoted[1] ?? "").split("+"),
    unquoted[2] ?? "",
  ].flatMap(teamSurfaceVariants);
  const right = [
    unquoted[3] ?? "",
    ...(unquoted[4] ?? "").split("+"),
  ].flatMap(teamSurfaceVariants);

  for (const a of left) {
    for (const b of right) {
      queries.push(`${a} ${b} ${date} football fixture`);
      queries.push(`${a} ${b} football fixture`);
    }
  }
  return uniqueValues(queries);
}

function fantasyWindowFixtureQueries(query: string): string[] {
  if (!/\bFANTASY MATCH\b/i.test(query)) return [];
  const clean = compactSearchSyntax(query);
  const date = clean.match(DATE_TIME_PATTERN);
  if (!date || date.index === undefined) return [];
  const subject = normalizeWhitespace(clean.slice(0, date.index));
  const tokens = subject.split(" ").filter(Boolean);
  if (tokens.length < 4) return [];

  const queries: string[] = [];
  for (const size of [2, 3, 4]) {
    if (size > tokens.length) continue;
    for (let start = 0; start <= tokens.length - size; start += 1) {
      const window = tokens.slice(start, start + size).join(" ");
      for (const surface of teamSurfaceVariants(window)) {
        queries.push(`${surface} ${date[0]} football fixture`);
        queries.push(`${surface} football fixture`);
      }
    }
  }
  return uniqueValues(queries);
}

function compactSearchSyntax(value: string): string {
  return normalizeWhitespace(
    stripResultMarkers(
      stripParentheticalCodes(
        stripParentheticalDescriptors(stripQuotes(expandFootballAbbreviations(value))),
      ),
    )
      .replace(/\bsite:[^\s]+/gi, " ")
      .replace(/[?+]/g, " ")
      .replace(/\bFANTASY MATCH\b/gi, " ")
      .replace(/\bsame football match\b/gi, "football fixture")
      .replace(/\bsame football league tournament country tier\b/gi, "football league country")
      .replace(/\bthe same football team as\b/gi, "football club alias")
      .replace(/\bIs\s+/gi, " "),
  );
}

function addVariant(
  variants: SearchQueryVariant[],
  seen: Set<string>,
  query: string,
  reason: string,
) {
  const clean = normalizeWhitespace(query);
  if (!clean) return;
  const key = clean.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  variants.push({ query: clean, reason });
}

function domainLabel(site: string): string | null {
  const host = site.toLowerCase();
  if (host.includes("espn")) return "ESPN soccer";
  if (host.includes("sofascore")) return "SofaScore";
  if (host.includes("flashscore")) return "Flashscore";
  const first = host
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/.]/)[0];
  return first ? first : null;
}

function extractSiteLabels(query: string): string[] {
  const labels = new Set<string>();
  for (const match of query.matchAll(/\bsite:([^\s]+)/gi)) {
    const label = domainLabel(match[1] ?? "");
    if (label) labels.add(label);
  }
  return [...labels];
}

function competitionClassificationQuery(query: string): string | null {
  const match = query.match(
    /^Classify the football betting-market efficiency context for this competition:\s*([^\n]+)/i,
  );
  const name = match?.[1]?.trim();
  if (!name) return null;
  return `${compactSearchSyntax(name)} football competition league country market tier`;
}

function pairedFixtureQueries(query: string): string[] {
  const match = query.match(
    /^"([^"]+)"\s+vs\s+"([^"]+)"\s+"([^"]+)"\s+vs\s+"([^"]+)"\s+(.+?)\s+football match$/i,
  );
  if (!match) return [];
  const context = normalizeWhitespace(match[5] ?? "");
  return [
    `${match[1]} ${match[2]} ${context} football fixture`,
    `${match[3]} ${match[4]} ${context} football fixture`,
    `${match[1]} vs ${match[2]} ${context} football fixture`,
    `${match[3]} vs ${match[4]} ${context} football fixture`,
  ];
}

function sameMatchFixtureQueries(query: string): string[] {
  const match = query.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s+UTC)?)?)\s+same football match$/i);
  if (!match) return [];

  const subject = compactSearchSyntax(match[1] ?? "");
  const date = normalizeWhitespace(match[2] ?? "");
  const tokens = subject.split(" ").filter(Boolean);
  if (tokens.length < 4 || !date) {
    return subject && date ? [`${subject} ${date} football fixture`] : [];
  }

  const queries: string[] = [];
  const mid = Math.floor(tokens.length / 2);
  const splits = [mid, mid + 1, mid - 1, mid + 2, mid - 2]
    .filter((split) => split >= 2 && split <= tokens.length - 2);
  const seenSplits = new Set<number>();

  for (const split of splits) {
    if (seenSplits.has(split)) continue;
    seenSplits.add(split);
    const left = normalizeWhitespace(tokens.slice(0, split).join(" "));
    const right = normalizeWhitespace(tokens.slice(split).join(" "));
    if (left) {
      queries.push(`${left} ${date} football fixture`);
      queries.push(`${left} football fixture`);
    }
    if (right) {
      queries.push(`${right} ${date} football fixture`);
      queries.push(`${right} football fixture`);
    }
  }

  queries.push(`${subject} ${date} football fixture`);
  queries.push(`${subject} football fixture`);
  return queries;
}

function quotedFixtureQueries(query: string): string[] {
  const match = query.match(
    /^"([^"]+)"\s+"([^"]+)"\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s+UTC)?)?)/i,
  );
  if (!match) return [];
  const left = teamSurfaceVariants(match[1] ?? "");
  const right = teamSurfaceVariants(match[2] ?? "");
  const queries: string[] = [];
  for (const a of left) {
    for (const b of right) {
      queries.push(`${a} vs ${b} ${match[3]} football fixture`);
      queries.push(`${a} ${b} ${match[3]} football fixture`);
    }
  }
  return uniqueValues(queries);
}

function quotedFixtureIdentityQueries(query: string): string[] {
  const match = query.match(
    /^"([^"]+)"\s+"([^"]+)"\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s+UTC)?)?)/i,
  );
  if (!match) return [];

  const left = teamSurfaceVariants(match[1] ?? "");
  const right = teamSurfaceVariants(match[2] ?? "");
  const queries: string[] = [];
  for (const a of left) {
    for (const b of right) {
      queries.push(`${a} ${b} football club`);
      queries.push(`${a} ${b} soccer club`);
      queries.push(`${a} ${b} ${match[3]} football club`);
    }
  }
  for (const surface of [...left, ...right]) {
    queries.push(`${surface} football club`);
    queries.push(`${surface} soccer club`);
  }
  return uniqueValues(queries);
}

function teamAliasQuery(query: string): string | null {
  const match = query.match(
    /^Is\s+"([^"]+)"\s+the same football team as\s+"([^"]+)"\?\s*(.*)$/i,
  );
  if (!match) return null;
  return normalizeWhitespace(
    `${compactSearchSyntax(match[1] ?? "")} ${compactSearchSyntax(match[2] ?? "")} football club alias ${compactSearchSyntax(match[3] ?? "")}`,
  );
}

function teamAliasFixtureQuery(query: string): string | null {
  const match = query.match(
    /^Is\s+"([^"]+)"\s+the same football team as\s+"([^"]+)"\?\s*(.*)$/i,
  );
  if (!match) return null;
  return normalizeWhitespace(
    `${compactSearchSyntax(match[1] ?? "")} ${compactSearchSyntax(match[2] ?? "")} ${compactSearchSyntax(match[3] ?? "")} football fixture`,
  );
}

function teamAliasShortQueries(query: string): string[] {
  const match = query.match(
    /^Is\s+"([^"]+)"\s+the same football team as\s+"([^"]+)"\?\s*(.*)$/i,
  );
  if (!match) return [];
  const a = compactSearchSyntax(match[1] ?? "");
  const b = compactSearchSyntax(match[2] ?? "");
  if (!a || !b) return [];
  const queries: string[] = [];
  for (const left of teamSurfaceVariants(a)) {
    for (const right of teamSurfaceVariants(b)) {
      if (left.toLowerCase() === right.toLowerCase()) {
        queries.push(`${left} football club`);
        queries.push(`${left} football team`);
        continue;
      }
      queries.push(`${left} ${right} football club`);
      queries.push(`${left} ${right} same football team`);
      queries.push(`${left} ${right} football`);
    }
  }
  return uniqueValues(queries);
}

function teamAliasSideQueries(query: string): string[] {
  const match = query.match(
    /^Is\s+"([^"]+)"\s+the same football team as\s+"([^"]+)"\?\s*(.*)$/i,
  );
  if (!match) return [];

  const context = compactSearchSyntax(match[3] ?? "");
  const queries: string[] = [];
  for (const surface of teamSurfaceVariants(match[1] ?? "")) {
    queries.push(`${surface} ${context} football club`);
    queries.push(`${surface} football club ${context}`);
    queries.push(`${surface} football team ${context}`);
  }
  for (const surface of teamSurfaceVariants(match[2] ?? "")) {
    queries.push(`${surface} ${context} football club`);
    queries.push(`${surface} football club ${context}`);
    queries.push(`${surface} football team ${context}`);
  }
  return uniqueValues(queries);
}

function leagueAliasQuery(query: string): string | null {
  const match = query.match(
    /^"([^"]+)"\s+"([^"]+)"\s+same football league tournament country tier/i,
  );
  if (!match) return null;
  return normalizeWhitespace(`${match[1]} ${match[2]} football league country`);
}

export function buildVertexSearchQueries(query: string): SearchQueryVariant[] {
  const original = normalizeWhitespace(query);
  const variants: SearchQueryVariant[] = [];
  const seen = new Set<string>();
  if (!original) return variants;

  const classification = competitionClassificationQuery(query);
  if (classification) {
    addVariant(variants, seen, classification, "competition-classification");
    addVariant(
      variants,
      seen,
      classification.replace(/\bmarket tier\b/i, "competition level"),
      "competition-classification-level",
    );
    addVariant(
      variants,
      seen,
      classification.replace(
        /football competition league country market tier/i,
        "football competition",
      ),
      "competition-classification-general",
    );
    return variants.slice(0, MAX_VERTEX_VARIANTS);
  }

  for (const fixtureQuery of pairedFixtureQueries(original)) {
    const expandedFixture = compactSearchSyntax(fixtureQuery);
    addVariant(variants, seen, expandedFixture, "paired-fixture");
    const dateOnly = stripFixtureTime(expandedFixture);
    if (dateOnly) {
      addVariant(variants, seen, dateOnly, "paired-fixture-date-only");
    }
    const noDate = stripFixtureDate(expandedFixture);
    if (noDate) {
      addVariant(variants, seen, noDate, "paired-fixture-no-date");
    }
  }

  const alias = teamAliasQuery(original);
  if (alias) {
    const fixtureAlias = teamAliasFixtureQuery(original);
    if (fixtureAlias) {
      addVariant(
        variants,
        seen,
        expandFootballAbbreviations(fixtureAlias),
        "team-alias-fixture-expanded",
      );
    }
    const expandedAlias = expandFootballAbbreviations(alias);
    if (expandedAlias !== alias) {
      addVariant(variants, seen, expandedAlias, "team-alias-expanded");
    }
    for (const shortAlias of teamAliasShortQueries(original)) {
      addVariant(variants, seen, shortAlias, "team-alias-short");
    }
    for (const sideAlias of teamAliasSideQueries(original)) {
      addVariant(variants, seen, sideAlias, "team-alias-side");
    }
    addVariant(variants, seen, alias, "team-alias");
    return variants.slice(0, MAX_VERTEX_VARIANTS);
  }

  const league = leagueAliasQuery(original);
  if (league) {
    addVariant(variants, seen, league, "league-alias");
  }

  for (const plusFixture of plusCompoundFixtureQueries(original)) {
    addVariant(variants, seen, plusFixture, "plus-compound-fixture");
  }

  if (/\bsite:/i.test(original)) {
    for (const quotedFixture of quotedFixtureQueries(original)) {
      const expandedQuotedFixture = compactSearchSyntax(quotedFixture);
      addVariant(variants, seen, expandedQuotedFixture, "quoted-fixture");
      const withoutDate = stripFixtureDate(expandedQuotedFixture);
      if (withoutDate) {
        addVariant(
          variants,
          seen,
          withoutDate,
          "quoted-fixture-no-date",
        );
      }
    }
    for (const identityQuery of quotedFixtureIdentityQueries(original)) {
      addVariant(
        variants,
        seen,
        compactSearchSyntax(identityQuery),
        "quoted-fixture-identity",
      );
    }
    const labels = extractSiteLabels(original);
    const withoutSite = compactSearchSyntax(original);
    addVariant(
      variants,
      seen,
      labels.length ? `${withoutSite} ${labels.join(" ")}` : withoutSite,
      "site-filter-expanded",
    );
    addVariant(variants, seen, withoutSite, "site-filter-stripped");
  }

  if (/\bsame football match\b/i.test(original)) {
    for (const sameMatchFixture of sameMatchFixtureQueries(original)) {
      addVariant(
        variants,
        seen,
        sameMatchFixture,
        "same-match-split-fixture",
      );
    }
    addVariant(variants, seen, compactSearchSyntax(original), "same-match");
  }

  for (const fantasyFixture of fantasyWindowFixtureQueries(original)) {
    addVariant(variants, seen, fantasyFixture, "fantasy-window-fixture");
  }

  const expanded = expandFootballAbbreviations(original);
  if (expanded !== original) {
    addVariant(
      variants,
      seen,
      compactSearchSyntax(expanded),
      "abbreviation-expanded",
    );
  }

  const cleaned = compactSearchSyntax(original);
  if (variants.length === 0 && cleaned === original) {
    addVariant(variants, seen, original, "original");
  }
  if (/\bfixture\b/i.test(cleaned)) {
    const reserveCore = reserveCoreFixtureQuery(cleaned);
    if (reserveCore) {
      addVariant(variants, seen, reserveCore, "reserve-core-fixture");
    }
    const timeStripped = stripFixtureTime(cleaned);
    if (timeStripped) {
      addVariant(variants, seen, timeStripped, "fixture-date-only");
    }
    const noDateFixture = stripFixtureDate(cleaned);
    if (noDateFixture) {
      addVariant(variants, seen, noDateFixture, "fixture-no-date");
    }
    const contextStripped = stripFixtureCompetitionContext(cleaned);
    if (contextStripped && contextStripped !== cleaned) {
      addVariant(
        variants,
        seen,
        contextStripped,
        "fixture-context-stripped",
      );
      const withoutDate = stripFixtureDate(contextStripped);
      if (withoutDate) {
        addVariant(
          variants,
          seen,
          withoutDate,
          "fixture-context-no-date",
        );
      }
    }
    const suffixStripped = stripClubSuffixes(cleaned);
    if (suffixStripped !== cleaned) {
      addVariant(
        variants,
        seen,
        suffixStripped,
        "club-suffix-stripped",
      );
    }
    for (const splitFixture of splitFixtureSubjectQueries(cleaned)) {
      addVariant(variants, seen, splitFixture, "fixture-subject-split");
    }
  }

  if (original.includes("\n")) {
    addVariant(
      variants,
      seen,
      compactSearchSyntax(original.split("\n")[0] ?? original),
      "first-line",
    );
  }

  if (cleaned !== original) {
    addVariant(variants, seen, cleaned, "syntax-cleaned");
  }
  addVariant(variants, seen, original, "original");

  return variants.slice(0, MAX_VERTEX_VARIANTS);
}
