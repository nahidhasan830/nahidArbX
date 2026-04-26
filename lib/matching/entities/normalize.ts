/**
 * Surface-name normalization for the entity-resolution system.
 *
 * Mirrors the legacy `lib/matching/normalize.ts` rules (lowercase, NFD
 * diacritic strip, club-token strip, short-form expansion, country
 * adjective→noun, country prefix strip), but lives in the entities/
 * namespace so the resolver path is self-contained and the legacy file
 * can be retired cleanly.
 *
 * Adds a transliteration layer that's missing from the legacy normalizer:
 * Cyrillic, Greek and Vietnamese diacritics that survive NFD all collapse
 * to ASCII so "công an hồ chí minh city" and "ho chi minh city" don't end
 * up in different normalization buckets. The full LaBSE-cosine-similarity
 * fallback for harder transliteration cases (Arabic, CJK) lives in
 * resolver.ts as a pgvector lookup — this file handles the cheap cases.
 */

const COUNTRY_ADJECTIVE_MAP: Record<string, string> = {
  english: "england",
  british: "england",
  scottish: "scotland",
  welsh: "wales",
  irish: "ireland",
  spanish: "spain",
  german: "germany",
  french: "france",
  italian: "italy",
  dutch: "netherlands",
  portuguese: "portugal",
  belgian: "belgium",
  austrian: "austria",
  swiss: "switzerland",
  turkish: "turkey",
  greek: "greece",
  polish: "poland",
  czech: "czech republic",
  russian: "russia",
  ukrainian: "ukraine",
  brazilian: "brazil",
  argentine: "argentina",
  mexican: "mexico",
  american: "usa",
  japanese: "japan",
  korean: "korea",
  chinese: "china",
  australian: "australia",
};

const ADJECTIVE_REGEXES = Object.entries(COUNTRY_ADJECTIVE_MAP).map(
  ([adj, noun]) => ({ regex: new RegExp(`\\b${adj}\\b`, "g"), noun }),
);

const ALL_COUNTRIES = [
  ...Object.values(COUNTRY_ADJECTIVE_MAP),
  ...Object.keys(COUNTRY_ADJECTIVE_MAP),
];
const COUNTRY_PREFIX_REGEXES = ALL_COUNTRIES.map(
  (country) => new RegExp(`^${country}\\s+`, "i"),
);

const CLUB_TOKEN_STRIP_RE =
  /(^|\s)(fc|sc|cf|ac|as|ss|sv|us|aek|vfb|vfl|tsv|bk|if|kv|sk|rc|rcd|psc|dsc)(?=$|\s)/g;

const SHORT_FORM_MAP: Array<[RegExp, string]> = [
  [/\butd\b/g, "united"],
  [/\bunt\b/g, "united"],
  [/\bcty\b/g, "city"],
  [/\bintl\b/g, "international"],
  [/\bathl\b/g, "athletic"],
  [/\batl\b/g, "atletico"],
  [/\bwnd\b/g, "wanderers"],
  [/\bwdrs\b/g, "wanderers"],
  [/\brvrs\b/g, "rovers"],
  [/\brgrs\b/g, "rangers"],
];

// ── Cyrillic, Greek and Vietnamese transliteration table ────────────────
//
// These are the cheap cases — single-char substitutions that NFD doesn't
// catch. CJK and Arabic remain non-transliterated; we rely on the
// embedding-cosine fallback in resolver.ts for those.
const TRANSLIT_MAP: Record<string, string> = {
  // Cyrillic
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  // Greek
  α: "a",
  β: "b",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "ks",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
  // Vietnamese-only diacritics that survive NFD
  đ: "d",
  Đ: "d",
};

function transliterate(s: string): string {
  let out = "";
  for (const ch of s) {
    out += TRANSLIT_MAP[ch] ?? ch;
  }
  return out;
}

/**
 * Normalize a surface name for entity lookup. Pipeline:
 *   1. lowercase
 *   2. NFD diacritic strip
 *   3. transliterate Cyrillic/Greek/Vietnamese
 *   4. punctuation → space
 *   5. expand short forms
 *   6. strip club prefix/suffix tokens (twice for "FC X FC" patterns)
 *
 * Identical-input safety: returns the basic-normalized original if
 * stripping consumed everything (e.g. just "FC").
 */
export function normalize(s: string): string {
  let out = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  out = transliterate(out);
  out = out
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, replacement] of SHORT_FORM_MAP) {
    out = out.replace(re, replacement);
  }
  for (let i = 0; i < 2; i++) {
    out = out.replace(CLUB_TOKEN_STRIP_RE, "$1").replace(/\s+/g, " ").trim();
  }
  if (!out) {
    return s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
  }
  return out;
}

/**
 * Competition-name normalization. After basic normalize, fold country
 * adjectives to nouns ("english" → "england") and strip leading country
 * prefix ("England FA Cup" → "FA Cup"). This keeps the (provider, surface,
 * competition_id) UNIQUE key stable across providers that say "Spanish
 * Liga" vs "Spain La Liga" vs "La Liga".
 */
export function normalizeCompetition(s: string): string {
  let result = normalize(s);
  for (const { regex, noun } of ADJECTIVE_REGEXES) {
    result = result.replace(regex, noun);
  }
  for (const prefixRegex of COUNTRY_PREFIX_REGEXES) {
    result = result.replace(prefixRegex, "");
  }
  return result.trim();
}

// ── Gender detection (for promoter Tier 0 gate) ──────────────────────

const WOMEN_PATTERNS = [
  /\(wom/i,
  /\(w\)/i,
  /\bwomen\b/i,
  /\bwomens\b/i,
  / w\b/i,
  / w$/i,
  /\bladies\b/i,
  /\bfemenino\b/i,
  /\bfemeni\b/i,
  /\bfeminino\b/i,
  /\bfrauen\b/i,
  /\bdames\b/i,
  /\bvrouwen\b/i,
];

export function isWomensTeam(name: string): boolean {
  return WOMEN_PATTERNS.some((re) => re.test(name));
}

export function gendersDiffer(a: string, b: string): boolean {
  return isWomensTeam(a) !== isWomensTeam(b);
}

// ── Team-variant detection (U-class, Olympic, Reserves, Futsal, etc.) ─
//
// The legacy alias store had no concept of "different team that shares
// the base name." The harvester would happily merge "Brazil U20" into
// "Brazil", "Real Madrid B" into "Real Madrid", "Barcelona Futsal" into
// "Barcelona", and so on — because most of the surrounding text matches.
//
// `teamVariantTag(name)` returns a normalised tag for any non-senior
// variant. Different tags = different teams; promoter Tier 0 rejects
// candidates whose tag differs from the canonical entity's tag.
//
// Categories handled:
//   age:        U15, U-17, U20, Sub-21, Under-23 → 'u15', 'u17', 'u20', …
//   olympic:    "Olympic" / "Olímpico" / "OL" (de-facto U23 for men)     → 'olympic'
//   youth:      "Youth", "Junior", "Cadet", "Juvenile" (no number)       → 'youth'
//   reserves:   "Reserves", "II", "2nd team", "B", "Castilla", "EDS",
//               "Academy"                                                → 'reserves'
//   futsal:     "Futsal", "Sala", "Indoor"                               → 'futsal'
//   beach:      "Beach", "Beach Soccer", "Sand"                          → 'beach'
//   esports:    "eSports", "eFootball", "FIFA Pro", "e-Sport", "(E)"     → 'esports'
//   selects:    "Selects", "All-Stars", "Allstars", "XI"                 → 'selects'
//   amateur:    "Amateur" / "Amateurs" (e.g. "Bayern Amateurs")          → 'amateur'
//
// Order matters — age is checked first because "Brazil U-20 Olympic"
// should resolve to U-20, not Olympic.

const AGE_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/\bu[\s-]?(\d{2})\b/i, (m) => `u${m[1]}`], // U17, U-17, U 17
  [/\bsub[\s-]?(\d{2})\b/i, (m) => `u${m[1]}`], // Sub20, Sub-20
  [/\bunder[\s-]?(\d{2})\b/i, (m) => `u${m[1]}`], // Under 20, Under-20
  [/\busub[\s-]?(\d{2})\b/i, (m) => `u${m[1]}`], // Italian "U-Sub20"
];

const OLYMPIC_PATTERNS = [
  /\bolympic\b/i,
  /\bol[íi]mpico\b/i,
  /\bolimpijska\b/i,
  /\bolimpiyada\b/i,
  /\(ol\)/i,
];

const YOUTH_PATTERNS = [
  /\byouth\b/i,
  /\bjunior\b/i,
  /\bjuniors\b/i,
  /\bcadet\b/i,
  /\bcadets\b/i,
  /\bjuvenile\b/i,
];

const RESERVES_PATTERNS = [
  /\breserves?\b/i, // Real Madrid Reserves
  /\bcastilla\b/i, // Real Madrid Castilla = the B team
  /\bamateur(?:s|e)?\b/i, // Bayern Amateure
  /\beds\b/i, // Manchester City EDS (Elite Development Squad)
  /\bacademy\b/i, // Chelsea Academy
  /\b(?:ii|2nd|3rd)\s+team\b/i, // Bayern II, Bayern 2nd team
  /\bb[\s-]?team\b/i, // Barcelona B
  /\b(?:ii|iii)\b(?!\s*division)/i, // bare "II" / "III" but not "II Division"
  /\b[ab]\b(?=\s*$)/i, // trailing single A/B suffix (Sevilla B, Atletico B)
];

const FUTSAL_PATTERNS = [
  /\bfutsal\b/i,
  /\bsala\b/i, // FC ... Sala (Spanish "fútbol sala")
  /\bindoor\b/i,
];

const BEACH_PATTERNS = [
  /\bbeach\b/i,
  /\bbeach\s*soccer\b/i,
  /\bsand\b(?!\s*(?:bar|stone))/i,
];

const ESPORTS_PATTERNS = [
  /\besports?\b/i,
  /\befootball\b/i,
  /\bfifa[\s-]?pro\b/i,
  /\b(?:fc[\s-])?fifa\b(?=\s*(?:pro|ultimate))/i,
  /\(e\)/i,
  /\be[\s-]team\b/i,
];

const SELECTS_PATTERNS = [
  /\bselects?\b/i,
  /\ball[\s-]?stars?\b/i,
  /\ballstars?\b/i,
  /\bxi\b(?=\s*$)/i, // trailing "XI" (e.g. "Asia XI")
];

/**
 * Returns the variant tag for a name, or null if it's the canonical
 * senior team. The tag normalises across languages and abbreviations
 * so "U20", "Sub-20", "Under 20" all → "u20"; "Olympic", "Olímpico"
 * → "olympic"; "Reserves", "II", "B", "Castilla" → "reserves"; etc.
 *
 *   "Brazil U20"            → "u20"
 *   "Argentina Sub-17"      → "u17"
 *   "Mexico Olympic"        → "olympic"
 *   "Bayern II"             → "reserves"
 *   "Real Madrid Castilla"  → "reserves"
 *   "Barcelona Futsal"      → "futsal"
 *   "Brazil Beach Soccer"   → "beach"
 *   "Real Madrid eSports"   → "esports"
 *   "Asia XI"               → "selects"
 *   "Brazil"                → null
 */
export function teamVariantTag(name: string): string | null {
  for (const [re, mk] of AGE_PATTERNS) {
    const m = name.match(re);
    if (m) return mk(m);
  }
  if (OLYMPIC_PATTERNS.some((re) => re.test(name))) return "olympic";
  if (FUTSAL_PATTERNS.some((re) => re.test(name))) return "futsal";
  if (BEACH_PATTERNS.some((re) => re.test(name))) return "beach";
  if (ESPORTS_PATTERNS.some((re) => re.test(name))) return "esports";
  if (RESERVES_PATTERNS.some((re) => re.test(name))) return "reserves";
  if (SELECTS_PATTERNS.some((re) => re.test(name))) return "selects";
  if (YOUTH_PATTERNS.some((re) => re.test(name))) return "youth";
  return null;
}

/**
 * True if two names belong to different team variants. Promoter Tier 0
 * rejects any candidate where this returns true — same gate shape as
 * the gender check.
 *
 *   teamVariantsDiffer("Brazil U20", "Brazil")        → true
 *   teamVariantsDiffer("Brazil U20", "Brazil U-20")   → false
 *   teamVariantsDiffer("Bayern II", "Bayern Munich")  → true
 *   teamVariantsDiffer("Spain Youth", "Spain U17")    → true (different tags)
 *   teamVariantsDiffer("Real Madrid", "Real Madrid CF") → false (both null)
 */
export function teamVariantsDiffer(a: string, b: string): boolean {
  return teamVariantTag(a) !== teamVariantTag(b);
}

/** Backwards-compat alias for the old age-class-only check. Now that the
 *  promoter calls teamVariantsDiffer, this is just a thin wrapper for
 *  any external caller that still names the predicate with the older
 *  vocabulary. */
export function ageClassOf(name: string): string | null {
  return teamVariantTag(name);
}
export function ageClassesDiffer(a: string, b: string): boolean {
  return teamVariantsDiffer(a, b);
}
