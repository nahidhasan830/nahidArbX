/**
 * AI Accuracy Test Runner
 *
 * Tests both settlement verification and event matching accuracy
 * by calling the local AI grounding engine (DeepSeek + Vertex/Brave/Tavily)
 * via the Next.js API and comparing against ground-truth data.
 *
 * Usage: npx tsx tests/ai-accuracy-runner.ts [--settlement] [--event-match] [--iterations N]
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// ── Types ──────────────────────────────────────────────────────────

interface SettlementTestCase {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
  groundTruth: { ftHome: number; ftAway: number };
  settledBySource: string;
}

interface MatchPairTestCase {
  id: string;
  decision: string; // "SAME" or "DIFFERENT"
  eventA: {
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: string;
    provider: string;
  };
  eventB: {
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: string;
    provider: string;
  };
  stringScore: number;
}

interface SettlementVerdict {
  answer: string;
  confidence: number;
  reasoning: string;
  sources: Array<{ url: string; title: string; snippet: string }>;
  model: string;
}

interface MatchVerdict {
  decision: string;
  confidence: number;
  reasoning: string;
  sources: Array<{ url: string; title: string; snippet: string }>;
  model: string;
}

interface SettlementTestResult {
  testCase: SettlementTestCase;
  scoreCorrect: boolean;
  aiScore: string | null;
  aiConfidence: number;
  aiAnswer: string;
  aiReasoning: string;
  error?: string;
}

interface MatchPairTestResult {
  testCase: MatchPairTestCase;
  decisionCorrect: boolean;
  aiDecision: string;
  aiConfidence: number;
  error?: string;
}

// ── Ground Truth Data (from Postgres) ──────────────────────────────

const SETTLEMENT_CASES: SettlementTestCase[] = [
  { eventId: "1", homeTeam: "Boston River", awayTeam: "Millonarios", competition: "CONMEBOL - Copa Sudamericana", startTime: "2026-05-07T22:00:00Z", groundTruth: { ftHome: 2, ftAway: 4 }, settledBySource: "espn" },
  { eventId: "2", homeTeam: "BFC Daugavpils", awayTeam: "Riga FC", competition: "Latvia - Virsliga", startTime: "2026-05-08T14:30:00Z", groundTruth: { ftHome: 1, ftAway: 3 }, settledBySource: "sofascore" },
  { eventId: "3", homeTeam: "Bohemians", awayTeam: "Drogheda United", competition: "Ireland - Premier", startTime: "2026-05-15T18:45:00Z", groundTruth: { ftHome: 2, ftAway: 1 }, settledBySource: "api-football" },
  { eventId: "4", homeTeam: "Panevezys", awayTeam: "Kauno Zalgiris", competition: "Lithuania - A Lyga", startTime: "2026-05-10T16:00:00Z", groundTruth: { ftHome: 1, ftAway: 1 }, settledBySource: "api-football" },
  { eventId: "5", homeTeam: "Pau FC", awayTeam: "Nancy", competition: "France - Ligue 2", startTime: "2026-05-02T18:00:00Z", groundTruth: { ftHome: 1, ftAway: 3 }, settledBySource: "espn" },
  { eventId: "6", homeTeam: "Borussia Dortmund", awayTeam: "Eintracht Frankfurt", competition: "Germany - Bundesliga", startTime: "2026-05-08T18:30:00Z", groundTruth: { ftHome: 3, ftAway: 2 }, settledBySource: "espn" },
  { eventId: "7", homeTeam: "Aston Villa", awayTeam: "Nottingham Forest", competition: "UEFA - Europa League", startTime: "2026-05-07T19:00:00Z", groundTruth: { ftHome: 4, ftAway: 0 }, settledBySource: "espn" },
  { eventId: "8", homeTeam: "Aldosivi", awayTeam: "Independiente Rivadavia", competition: "Argentina - Liga Pro", startTime: "2026-05-03T16:30:00Z", groundTruth: { ftHome: 1, ftAway: 1 }, settledBySource: "sofascore" },
  { eventId: "9", homeTeam: "Racing Club de Montevideo", awayTeam: "Montevideo City Torque", competition: "Uruguay - Primera Division", startTime: "2026-05-03T18:30:00Z", groundTruth: { ftHome: 1, ftAway: 1 }, settledBySource: "sofascore" },
  { eventId: "10", homeTeam: "Ipswich Town", awayTeam: "Queens Park Rangers", competition: "England - Championship", startTime: "2026-05-02T11:30:00Z", groundTruth: { ftHome: 3, ftAway: 0 }, settledBySource: "espn" },
  { eventId: "11", homeTeam: "Epitsentr Kamianets-Podilskyi", awayTeam: "Polissya Zhytomyr", competition: "Ukraine - Premier League", startTime: "2026-05-12T12:30:00Z", groundTruth: { ftHome: 3, ftAway: 2 }, settledBySource: "api-football" },
  { eventId: "12", homeTeam: "Rosario Central", awayTeam: "Racing Club", competition: "Argentina - Liga Pro", startTime: "2026-05-13T21:45:00Z", groundTruth: { ftHome: 1, ftAway: 1 }, settledBySource: "sofascore" },
  { eventId: "13", homeTeam: "Academia Puerto Cabello", awayTeam: "Deportivo La Guaira", competition: "Venezuela - Primera Division", startTime: "2026-05-03T00:00:00Z", groundTruth: { ftHome: 1, ftAway: 1 }, settledBySource: "sofascore" },
  { eventId: "14", homeTeam: "Aguilas Doradas", awayTeam: "Jaguares de Cordoba", competition: "Colombia - Cup", startTime: "2026-05-10T20:00:00Z", groundTruth: { ftHome: 2, ftAway: 1 }, settledBySource: "sofascore" },
  { eventId: "15", homeTeam: "Deportivo Cali", awayTeam: "Atletico Bucaramanga", competition: "Colombia - Cup", startTime: "2026-05-11T23:00:00Z", groundTruth: { ftHome: 2, ftAway: 0 }, settledBySource: "api-football" },
  { eventId: "16", homeTeam: "Pharco FC", awayTeam: "Modern Sport", competition: "Egypt - Premier League", startTime: "2026-05-12T14:00:00Z", groundTruth: { ftHome: 0, ftAway: 1 }, settledBySource: "api-football" },
  { eventId: "17", homeTeam: "Coritiba", awayTeam: "Santos", competition: "Brazil - Cup", startTime: "2026-05-13T22:30:00Z", groundTruth: { ftHome: 0, ftAway: 2 }, settledBySource: "api-football" },
  { eventId: "18", homeTeam: "Hassania Agadir", awayTeam: "Olympic Safi", competition: "Morocco - Botola Pro", startTime: "2026-05-04T16:00:00Z", groundTruth: { ftHome: 2, ftAway: 1 }, settledBySource: "sofascore" },
  { eventId: "19", homeTeam: "Santiago Wanderers", awayTeam: "Deportes Temuco", competition: "Chile - Primera B", startTime: "2026-05-03T19:00:00Z", groundTruth: { ftHome: 2, ftAway: 2 }, settledBySource: "sofascore" },
  { eventId: "20", homeTeam: "Pardubice", awayTeam: "MFK Karvina", competition: "Czech Republic - First Liga", startTime: "2026-05-10T13:00:00Z", groundTruth: { ftHome: 1, ftAway: 3 }, settledBySource: "ai-search-hf" },
];

const MATCH_PAIR_CASES: MatchPairTestCase[] = [
  // ── SAME pairs (10) ────────────────────────────────────────
  { id: "a45be95f", decision: "SAME", eventA: { homeTeam: "Atl Tucuman", awayTeam: "Banfield", competition: "Argentinian Primera Division", startTime: "2026-04-26T23:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Atletico Tucuman", awayTeam: "Banfield", competition: "Argentina - Liga Pro", startTime: "2026-04-26T23:00:00Z", provider: "pinnacle" }, stringScore: 0.846 },
  { id: "c448292f", decision: "SAME", eventA: { homeTeam: "El Geish", awayTeam: "Ghazl El Mahallah", competition: "Egyptian Premier", startTime: "2026-05-07T14:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Talaea El Gaish", awayTeam: "Ghazl El Mahallah", competition: "Egypt - Premier League", startTime: "2026-05-07T14:00:00Z", provider: "pinnacle" }, stringScore: 0.827 },
  { id: "c5ddc357", decision: "SAME", eventA: { homeTeam: "Prostejov", awayTeam: "Ceske Budejovice", competition: "Czech 2 Liga", startTime: "2026-05-09T16:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Prostejov", awayTeam: "Ceske Budejovice", competition: "Czech 2 Liga", startTime: "2026-05-09T16:00:00Z", provider: "velki-sportsbook" }, stringScore: 0.813 },
  { id: "9caf4ad4", decision: "SAME", eventA: { homeTeam: "MAS Taborsko", awayTeam: "MFK Chrudim", competition: "Czech 2 Liga", startTime: "2026-05-06T16:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Taborsko", awayTeam: "Chrudim", competition: "Czech Republic - FNL", startTime: "2026-05-06T16:00:00Z", provider: "pinnacle" }, stringScore: 0.813 },
  { id: "a765f361", decision: "SAME", eventA: { homeTeam: "Zizkov", awayTeam: "MAS Taborsko", competition: "Czech 2 Liga", startTime: "2026-05-03T08:15:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Viktoria Zizkov", awayTeam: "Taborsko", competition: "Czech Republic - FNL", startTime: "2026-05-03T08:15:00Z", provider: "pinnacle" }, stringScore: 0.813 },
  { id: "4e61ec4b", decision: "SAME", eventA: { homeTeam: "FK Napredak", awayTeam: "FK Radnicki 1923", competition: "Serbian Super League", startTime: "2026-05-16T18:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Napredak Krusevac", awayTeam: "Radnicki Kragujevac", competition: "Serbia - Super Liga", startTime: "2026-05-16T18:00:00Z", provider: "pinnacle" }, stringScore: 0.811 },
  { id: "2d4149e0", decision: "SAME", eventA: { homeTeam: "Usti Nad Labem", awayTeam: "SFC Opava", competition: "Czech 2 Liga", startTime: "2026-05-06T16:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Usti Nad Labem", awayTeam: "SFC Opava", competition: "Czech 2 Liga", startTime: "2026-05-06T16:00:00Z", provider: "velki-sportsbook" }, stringScore: 0.813 },
  { id: "eef4c91f", decision: "SAME", eventA: { homeTeam: "Anorthosis", awayTeam: "Digenis Ypsona", competition: "Cypriot 1st Division", startTime: "2026-05-08T16:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Anorthosis Famagusta", awayTeam: "Ypsonas", competition: "Cyprus - 1st Division", startTime: "2026-05-08T16:00:00Z", provider: "pinnacle" }, stringScore: 0.834 },
  { id: "6b090b54", decision: "SAME", eventA: { homeTeam: "FC Zbrojovka Brno", awayTeam: "FC Sellier & Bellot Vlasim", competition: "Czech 2 Liga", startTime: "2026-05-10T15:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "FC Zbrojovka Brno", awayTeam: "FC Sellier & Bellot Vlasim", competition: "Czech 2 Liga", startTime: "2026-05-10T15:00:00Z", provider: "velki-sportsbook" }, stringScore: 0.813 },
  { id: "d17f149b", decision: "SAME", eventA: { homeTeam: "AD Taubate FF (W)", awayTeam: "Red Bull Bragantino (W)", competition: "Brazilian Ladies State League", startTime: "2026-05-06T19:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Taubate", awayTeam: "RB Bragantino", competition: "Brazil - Paulista Women", startTime: "2026-05-06T19:00:00Z", provider: "pinnacle" }, stringScore: 0.807 },
  // ── DIFFERENT pairs (10) ────────────────────────────────────
  { id: "e98860ed", decision: "DIFFERENT", eventA: { homeTeam: "Al Ahli Amman", awayTeam: "Al Buqaa", competition: "Jordanian Premier League", startTime: "2026-05-04T16:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Al Najma", awayTeam: "Al Muharraq", competition: "Bahrain - Premier League", startTime: "2026-05-04T16:00:00Z", provider: "pinnacle" }, stringScore: 0.754 },
  { id: "1c8563ac", decision: "DIFFERENT", eventA: { homeTeam: "Dibba Al Fujairah", awayTeam: "Al Bataeh", competition: "UAE Arabian Gulf League", startTime: "2026-05-05T16:45:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Bani Yas", awayTeam: "Al Dhafra", competition: "UAE - Pro League", startTime: "2026-05-05T16:45:00Z", provider: "pinnacle" }, stringScore: 0.766 },
  { id: "30ae712b", decision: "DIFFERENT", eventA: { homeTeam: "Orlando City", awayTeam: "Atlanta Utd", competition: "US MLS", startTime: "2026-05-16T23:30:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "DC Utd", awayTeam: "St Louis City SC", competition: "US MLS", startTime: "2026-05-16T23:30:00Z", provider: "velki-sportsbook" }, stringScore: 0.783 },
  { id: "3b372763", decision: "DIFFERENT", eventA: { homeTeam: "Dukla Prague II", awayTeam: "Slavia Prague III", competition: "Czech Republic - 3. Liga CFL", startTime: "2026-05-06T15:00:00Z", provider: "pinnacle" }, eventB: { homeTeam: "H Slavia Kromeriz", awayTeam: "Slavia Praha B", competition: "Czech 2 Liga", startTime: "2026-05-06T15:00:00Z", provider: "velki-sportsbook" }, stringScore: 0.832 },
  { id: "97ff9f23", decision: "DIFFERENT", eventA: { homeTeam: "Cianorte", awayTeam: "Sao Luiz", competition: "Brazil - Serie D", startTime: "2026-05-10T19:00:00Z", provider: "pinnacle" }, eventB: { homeTeam: "Casertana", awayTeam: "Salernitana", competition: "Italian Serie C", startTime: "2026-05-10T19:00:00Z", provider: "velki-sportsbook" }, stringScore: 0.766 },
  { id: "82a1d323", decision: "DIFFERENT", eventA: { homeTeam: "Kitakyushu", awayTeam: "Oita", competition: "Japanese J. League 2/3 100 Year Vision", startTime: "2026-05-03T05:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Fukushima Utd", awayTeam: "Omiya", competition: "Japanese J. League 2/3 100 Year Vision", startTime: "2026-05-03T05:00:00Z", provider: "velki-sportsbook" }, stringScore: 0.773 },
  { id: "fe6fb17d", decision: "DIFFERENT", eventA: { homeTeam: "Dibba Al Fujairah", awayTeam: "Al Bataeh", competition: "UAE Arabian Gulf League", startTime: "2026-05-05T16:45:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Al Ittihad Kalba", awayTeam: "Khor Fakkan Club", competition: "UAE - Pro League", startTime: "2026-05-05T16:45:00Z", provider: "pinnacle" }, stringScore: 0.751 },
  { id: "580f841f", decision: "DIFFERENT", eventA: { homeTeam: "Al Batin", awayTeam: "Al Taee", competition: "Saudi 1st Division", startTime: "2026-05-09T16:15:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Al-Najma", awayTeam: "Al-Hazem", competition: "Saudi Arabia - Pro League", startTime: "2026-05-09T16:15:00Z", provider: "pinnacle" }, stringScore: 0.823 },
  { id: "eb4159c1", decision: "DIFFERENT", eventA: { homeTeam: "CD Gualberto Villarroel", awayTeam: "Bolivar", competition: "Bolivian Liga de Futbol Profesional", startTime: "2026-05-03T19:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Club Ciudad de Bolivar", awayTeam: "Ferro Carril Oeste", competition: "Argentina - Primera B Nacional", startTime: "2026-05-03T19:00:00Z", provider: "pinnacle" }, stringScore: 0.770 },
  { id: "9554a7ed", decision: "DIFFERENT", eventA: { homeTeam: "BG Pathumthani United", awayTeam: "Prachuap", competition: "Thai League 1", startTime: "2026-05-10T11:00:00Z", provider: "ninewickets-sportsbook" }, eventB: { homeTeam: "Ayutthaya United", awayTeam: "Port FC", competition: "Thai League 1", startTime: "2026-05-10T11:00:00Z", provider: "velki-sportsbook" }, stringScore: 0.762 },
];

// ── Helpers ──────────────────────────────────────────────────────────

function parseScore(answer: string): { home: number; away: number } | null {
  const patterns = [
    /(\d+)\s*[-–—:]\s*(\d+)/,
    /(\d+)\s*x\s*(\d+)/i,
    /(\d+)\s+to\s+(\d+)/i,
  ];
  for (const pat of patterns) {
    const m = answer.match(pat);
    if (m) {
      const home = parseInt(m[1], 10);
      const away = parseInt(m[2], 10);
      if (!isNaN(home) && !isNaN(away) && home >= 0 && away >= 0 && home <= 20 && away <= 20) {
        return { home, away };
      }
    }
  }
  return null;
}

async function callVerifySettlement(
  tc: SettlementTestCase
): Promise<SettlementVerdict> {
  const dateStr = tc.startTime.slice(0, 10);
  const question =
    `What was the final score of the football match ${tc.homeTeam} vs ${tc.awayTeam}` +
    (tc.competition ? ` in ${tc.competition}` : "") +
    ` on ${dateStr}? Please give the exact final score (e.g. "2-1") and half-time score if available.`;

  const res = await fetch(`${BASE_URL}/api/ai-search/verify-settlement`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: {
        home_team: tc.homeTeam,
        away_team: tc.awayTeam,
        competition: tc.competition,
        start_time: tc.startTime,
      },
      question,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SettlementVerdict;
}

async function callEntityMatch(
  tc: MatchPairTestCase
): Promise<MatchVerdict> {
  const res = await fetch(`${BASE_URL}/api/ai-search/entity-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_a: {
        home_team: tc.eventA.homeTeam,
        away_team: tc.eventA.awayTeam,
        competition: tc.eventA.competition,
        start_time: tc.eventA.startTime,
        provider: tc.eventA.provider,
      },
      event_b: {
        home_team: tc.eventB.homeTeam,
        away_team: tc.eventB.awayTeam,
        competition: tc.eventB.competition,
        start_time: tc.eventB.startTime,
        provider: tc.eventB.provider,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MatchVerdict;
}

// ── Settlement Test ───────────────────────────────────────────────────

async function runSettlementTests(
  cases: SettlementTestCase[]
): Promise<{ results: SettlementTestResult[]; summary: string }> {
  const results: SettlementTestResult[] = [];
  
  console.log(`\n=== SETTLEMENT ACCURACY TEST (${cases.length} events) ===\n`);
  
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const label = `${tc.homeTeam} vs ${tc.awayTeam} (${tc.competition})`;
    process.stdout.write(`[${i + 1}/${cases.length}] ${label.slice(0, 70)}... `);
    
    try {
      const verdict = await callVerifySettlement(tc);
      const score = parseScore(verdict.answer) ?? parseScore(verdict.reasoning);
      const scoreCorrect = score !== null &&
        score.home === tc.groundTruth.ftHome &&
        score.away === tc.groundTruth.ftAway;
      
      const aiScore = score ? `${score.home}-${score.away}` : "unparseable";
      const icon = scoreCorrect ? "✓" : "✗";
      console.log(`${icon} AI:${aiScore} GT:${tc.groundTruth.ftHome}-${tc.groundTruth.ftAway} conf:${verdict.confidence}%`);
      
      results.push({
        testCase: tc,
        scoreCorrect,
        aiScore,
        aiConfidence: verdict.confidence,
        aiAnswer: verdict.answer.slice(0, 200),
        aiReasoning: verdict.reasoning?.slice(0, 300) || "",
      });
      
      if (!scoreCorrect) {
        console.log(`  AI said: "${verdict.answer.slice(0, 150)}"`);
        if (verdict.reasoning) {
          console.log(`  Reasoning: "${verdict.reasoning.slice(0, 200)}"`);
        }
      }
    } catch (err) {
      console.log(`✗ ERROR: ${(err as Error).message}`);
      results.push({
        testCase: tc,
        scoreCorrect: false,
        aiScore: null,
        aiConfidence: 0,
        aiAnswer: "",
        aiReasoning: "",
        error: (err as Error).message,
      });
    }
    
    // Rate limit: small delay between calls
    if (i < cases.length - 1) await new Promise(r => setTimeout(r, 500));
  }
  
  // Summary
  const correct = results.filter(r => r.scoreCorrect).length;
  const total = results.length;
  const accuracy = ((correct / total) * 100).toFixed(1);
  const avgConf = results.reduce((s, r) => s + r.aiConfidence, 0) / total;
  const highConfCorrect = results.filter(r => r.aiConfidence >= 70 && r.scoreCorrect).length;
  const highConfTotal = results.filter(r => r.aiConfidence >= 70).length;
  const highConfAcc = highConfTotal > 0 ? ((highConfCorrect / highConfTotal) * 100).toFixed(1) : "N/A";
  
  const summary = `
  ┌──────────────────────────────────────────┐
  │     SETTLEMENT ACCURACY SUMMARY          │
  ├──────────────────────────────────────────┤
  │ Total tested:          ${String(total).padEnd(17)} │
  │ Score correct:         ${String(correct).padEnd(17)} │
  │ Overall accuracy:      ${String(accuracy + '%').padEnd(17)} │
  │ Avg confidence:        ${String(avgConf.toFixed(1) + '%').padEnd(17)} │
  │ High-conf (≥70%) acc:  ${String(highConfAcc + '%').padEnd(17)} │
  │ High-conf correct:     ${String(highConfCorrect + '/' + highConfTotal).padEnd(17)} │
  └──────────────────────────────────────────┘
`;
  
  return { results, summary };
}

// ── Event Matching Test ───────────────────────────────────────────────

async function runMatchPairTests(
  cases: MatchPairTestCase[]
): Promise<{ results: MatchPairTestResult[]; summary: string }> {
  const results: MatchPairTestResult[] = [];
  
  console.log(`\n=== EVENT MATCHING ACCURACY TEST (${cases.length} pairs) ===\n`);
  
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const label = `${tc.eventA.homeTeam}/${tc.eventA.awayTeam} ↔ ${tc.eventB.homeTeam}/${tc.eventB.awayTeam}`;
    process.stdout.write(`[${i + 1}/${cases.length}] ${label.slice(0, 70)}... `);
    
    try {
      const verdict = await callEntityMatch(tc);
      const decisionCorrect = verdict.decision === tc.decision;
      const icon = decisionCorrect ? "✓" : "✗";
      console.log(`${icon} AI:${verdict.decision} GT:${tc.decision} conf:${verdict.confidence}%`);
      
      results.push({
        testCase: tc,
        decisionCorrect,
        aiDecision: verdict.decision,
        aiConfidence: verdict.confidence,
      });
    } catch (err) {
      console.log(`✗ ERROR: ${(err as Error).message}`);
      results.push({
        testCase: tc,
        decisionCorrect: false,
        aiDecision: "ERROR",
        aiConfidence: 0,
        error: (err as Error).message,
      });
    }
    
    if (i < cases.length - 1) await new Promise(r => setTimeout(r, 500));
  }
  
  const correct = results.filter(r => r.decisionCorrect).length;
  const total = results.length;
  const accuracy = ((correct / total) * 100).toFixed(1);
  
  // Breakdown by SAME vs DIFFERENT
  const sameCases = results.filter(r => r.testCase.decision === "SAME");
  const diffCases = results.filter(r => r.testCase.decision === "DIFFERENT");
  const sameCorrect = sameCases.filter(r => r.decisionCorrect).length;
  const diffCorrect = diffCases.filter(r => r.decisionCorrect).length;
  
  const summary = `
  ┌──────────────────────────────────────────┐
  │   EVENT MATCHING ACCURACY SUMMARY         │
  ├──────────────────────────────────────────┤
  │ Total pairs:            ${String(total).padEnd(17)} │
  │ Correct decisions:      ${String(correct).padEnd(17)} │
  │ Overall accuracy:       ${String(accuracy + '%').padEnd(17)} │
  │ SAME pairs correct:     ${String(sameCorrect + '/' + sameCases.length).padEnd(17)} │
  │ DIFFERENT pairs correct: ${String(diffCorrect + '/' + diffCases.length).padEnd(17)} │
  └──────────────────────────────────────────┘
`;
  
  return { results, summary };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const runSettlement = args.includes("--settlement") || args.length === 0;
  const runEventMatch = args.includes("--event-match") || args.length === 0;
  
  console.log("AI Accuracy Test Runner");
  console.log(`AI Search via: ${BASE_URL}/api/ai-search`);
  console.log(`Time: ${new Date().toISOString()}`);
  
  if (runSettlement) {
    const { summary } = await runSettlementTests(SETTLEMENT_CASES);
    console.log(summary);
  }
  
  if (runEventMatch) {
    const { summary } = await runMatchPairTests(MATCH_PAIR_CASES);
    console.log(summary);
  }
  
  console.log("Done.");
}

main().catch(console.error);
