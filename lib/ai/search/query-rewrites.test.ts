import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVertexSearchQueries } from "./query-rewrites";

describe("Vertex search query rewrites", () => {
  it("distills competition-classification prompts before Vertex search", () => {
    const variants = buildVertexSearchQueries(
      [
        "Classify the football betting-market efficiency context for this competition: Australia - NPL Capital Territory Youth U23",
        "",
        "Return only a JSON object with these keys:",
      ].join("\n"),
    );

    assert.equal(
      variants[0]?.query,
      "Australia - NPL Capital Territory Youth U23 football competition league country market tier",
    );
    assert(
      variants.every((v) => !/Return only a JSON object/i.test(v.query)),
      "instruction text should not be sent to Vertex search",
    );
  });

  it("strips site filters and exact-match syntax for curated Vertex corpora", () => {
    const variants = buildVertexSearchQueries(
      '"India (W)" "Bhutan (W)" 2026-06-03 site:sofascore.com',
    );

    assert.equal(
      variants[0]?.query,
      "India (W) vs Bhutan (W) 2026-06-03 football fixture",
    );
    assert(
      variants.some((v) => v.reason === "site-filter-stripped"),
      "site-filtered queries should keep a filter-free fallback",
    );
  });

  it("adds quoted site identity fallbacks for abbreviated surfaces", () => {
    const variants = buildVertexSearchQueries(
      '"Oakland Roots" "Colorado SSFC" 2026-05-31 site:flashscore.com',
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "quoted-fixture-identity" &&
          v.query === "Oakland Roots Colorado SSFC football club",
      ),
      "quoted site rows should keep a generic identity search alongside fixture search",
    );
  });

  it("turns quoted team/date site filters into fixture searches", () => {
    const variants = buildVertexSearchQueries(
      '"Alpha FC" "Beta United" 2026-06-03 site:espn.com/soccer',
    );

    assert.equal(
      variants[0]?.query,
      "Alpha FC vs Beta United 2026-06-03 football fixture",
    );
    assert(
      variants.some((v) => v.reason === "quoted-fixture-no-date"),
      "quoted site queries should get a broader no-date fallback",
    );
  });

  it("adds generic club-word simplifications for quoted site fixtures", () => {
    const variants = buildVertexSearchQueries(
      '"CD Alpha City District" "Beta United" 2026-06-03 site:flashscore.com',
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "quoted-fixture" &&
          v.query === "Alpha City vs Beta United 2026-06-03 football fixture",
      ),
      "quoted fixture variants should trim generic club prefixes and over-specific trailing qualifiers",
    );
  });

  it("turns alias questions into keyword searches", () => {
    const variants = buildVertexSearchQueries(
      'Is "Gimnasia Mendoza" the same football team as "Estud. de La Plata"? Argentina - Liga Pro Reserves',
    );

    assert.equal(
      variants[0]?.query,
      "Gimnasia Mendoza Estudiantes de La Plata Argentina - Liga Pro Reserves football fixture",
    );
    assert(
      variants.some((v) =>
        v.query.includes(
          "Gimnasia Mendoza Estudiantes de La Plata football club alias Argentina - Liga Pro Reserves",
        ),
      ),
      "expanded alias query should still be available for Vertex",
    );
  });

  it("adds generic club-word simplifications for alias questions", () => {
    const variants = buildVertexSearchQueries(
      'Is "CD Alpha City District" the same football team as "Club Alpha City"? Example Cup',
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "team-alias-short" &&
          v.query === "Alpha City football club",
      ),
      "alias questions should be able to search the shared simplified surface",
    );
  });

  it("adds side-specific identity searches for long-tail alias questions", () => {
    const variants = buildVertexSearchQueries(
      'Is "Alpha City" the same football team as "Beta Rovers"? Country A - Regional League Country B - Amateur Cup',
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "team-alias-side" &&
          v.query ===
            "Alpha City Country A - Regional League Country B - Amateur Cup football club",
      ),
      "alias misses should retain a generic single-side identity fallback",
    );
    assert(
      variants.some(
        (v) =>
          v.reason === "team-alias-side" &&
          v.query ===
            "Beta Rovers football club Country A - Regional League Country B - Amateur Cup",
      ),
    );
  });

  it("splits two-provider fixture queries into individual event searches", () => {
    const variants = buildVertexSearchQueries(
      '"Egersund" vs "Stromsgodset" "Strommen" vs "Sogndal" 2026-05-31 15:00 UTC football match',
    );

    assert.equal(
      variants[0]?.query,
      "Egersund Stromsgodset 2026-05-31 15:00 UTC football fixture",
    );
    assert.equal(
      variants[1]?.query,
      "Egersund Stromsgodset 2026-05-31 football fixture",
    );
    assert.equal(
      variants[2]?.query,
      "Egersund Stromsgodset football fixture",
    );
    assert.equal(
      variants[3]?.query,
      "Strommen Sogndal 2026-05-31 15:00 UTC football fixture",
    );
    assert(
      variants.some((v) => v.reason === "paired-fixture-date-only"),
      "paired fixture searches should include date-only fallbacks",
    );
    assert(
      variants.some((v) => v.reason === "paired-fixture-no-date"),
      "paired fixture searches should include no-date fallbacks",
    );
  });

  it("splits fused same-match queries into candidate fixture halves", () => {
    const variants = buildVertexSearchQueries(
      "Alpha City Beta United Gamma Town Delta FC 2026-05-31 same football match",
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "same-match-split-fixture" &&
          v.query === "Alpha City Beta United 2026-05-31 football fixture",
      ),
    );
    assert(
      variants.some(
        (v) =>
          v.reason === "same-match-split-fixture" &&
          v.query === "Gamma Town Delta FC football fixture",
      ),
    );
  });

  it("drops result markers and fantasy labels without team-specific aliases", () => {
    const siteVariants = buildVertexSearchQueries(
      '"Alpha City (PEN)" "Beta United (PEN)" 2026-06-02 site:espn.com/soccer',
    );

    assert.equal(
      siteVariants[0]?.query,
      "Alpha City vs Beta United 2026-06-02 football fixture",
    );
    assert(
      siteVariants.every((v) => v.reason === "original" || !/\bPEN\b/i.test(v.query)),
      "result markers should be stripped from generated variants",
    );

    const fixtureVariants = buildVertexSearchQueries(
      "Alpha + Beta Gamma + Delta 2026-06-01 FANTASY MATCH football fixture",
    );
    assert(
      fixtureVariants.some(
        (v) =>
          v.reason !== "original" &&
          v.query === "Alpha Beta Gamma Delta 2026-06-01 football fixture",
      ),
      "fantasy labels and plus separators should be removed generically",
    );
  });

  it("decomposes quoted plus-compound fixture surfaces generically", () => {
    const variants = buildVertexSearchQueries(
      '"Alpha + Beta" "Gamma + Delta FC" 2026-06-01 site:sofascore.com',
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "plus-compound-fixture" &&
          v.query === "Beta Delta 2026-06-01 football fixture",
      ),
      "plus-composed surfaces should generate component fixture searches",
    );
  });

  it("adds generic token-window fallbacks for fantasy fixture strings", () => {
    const variants = buildVertexSearchQueries(
      "alpha beta gamma delta 2026-06-01 FANTASY MATCH fixture",
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "fantasy-window-fixture" &&
          v.query === "beta gamma 2026-06-01 football fixture",
      ),
      "fantasy fixture strings should get short contiguous surface fallbacks",
    );
  });

  it("removes generic competition descriptors from classification prompts", () => {
    const variants = buildVertexSearchQueries(
      [
        "Classify the football betting-market efficiency context for this competition: Example Youth Cup (IN EXAMPLE)(2x40 mins)",
        "",
        "Return only a JSON object with these keys:",
      ].join("\n"),
    );

    assert.equal(
      variants[0]?.query,
      "Example Youth Cup football competition league country market tier",
    );
    assert(
      variants.some(
        (v) =>
          v.reason === "competition-classification-general" &&
          v.query === "Example Youth Cup football competition",
      ),
    );
  });

  it("strips generic parenthetical provider/country codes without team synonyms", () => {
    const variants = buildVertexSearchQueries(
      "Alpha City Beta United (ABC) 2026-05-31 Premier League football fixture",
    );

    assert(
      variants.some((v) => v.query.includes("Alpha City Beta United")),
    );
    assert(
      variants.some(
        (v) =>
          v.reason !== "original" &&
          v.query ===
            "Alpha City Beta United 2026-05-31 Premier League football fixture",
      ),
      "generic parenthetical codes should be stripped in cleaned variants",
    );
  });

  it("drops over-specific fixture context for reserve matches", () => {
    const variants = buildVertexSearchQueries(
      "Alpha FC (Res) Beta United (Res) 2026-06-01 Reserve League football fixture",
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "reserve-core-fixture" &&
          v.query === "Alpha Beta United 2026-06-01 football fixture",
      ),
    );
  });

  it("preserves competition context when splitting short fixture subjects", () => {
    const variants = buildVertexSearchQueries(
      "pro gorodenka pryk pattya 2026-06-01 Ukrainian Persha Liga fixture",
    );

    assert(
      variants.some(
        (v) =>
          v.reason === "fixture-subject-split" &&
          v.query ===
            "pro gorodenka 2026-06-01 Ukrainian Persha Liga football fixture",
      ),
      "short fixture subjects should still split into contextual generic searches",
    );
    assert(
      variants.some(
        (v) =>
          v.reason === "fixture-subject-split" &&
          v.query ===
            "pryk pattya Ukrainian Persha Liga football club",
      ),
    );
  });

  it("only expands standalone R when the query has reserve context", () => {
    const ordinary = buildVertexSearchQueries(
      "Club R Example City 2026-06-03 football fixture",
    );
    assert(
      ordinary.every((v) => !v.query.includes("Club reserve Example")),
      "standalone R should not become reserve without reserve context",
    );

    const reserve = buildVertexSearchQueries(
      "Alpha R Beta R 2026-06-01 Reserve League football fixture",
    );
    assert(
      reserve.some((v) =>
        v.query.includes("Alpha reserve Beta reserve 2026-06-01"),
      ),
    );
  });

  it("keeps ordinary clean queries as original", () => {
    const variants = buildVertexSearchQueries(
      "Poland Nigeria 2026-06-03 football fixture",
    );

    assert.equal(variants[0]?.query, "Poland Nigeria 2026-06-03 football fixture");
    assert.equal(variants[0]?.reason, "original");
    assert(
      variants.some(
        (v) =>
          v.reason === "fixture-no-date" &&
          v.query === "Poland Nigeria football fixture",
      ),
      "clean fixture queries should keep a broad fallback after the exact query",
    );
  });
});
