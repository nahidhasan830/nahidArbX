import { POST } from "./app/api/bets/place/route";

async function run() {
  const req = new Request("http://localhost/api/bets/place", {
    method: "POST",
    body: JSON.stringify({
      runtime: {
        eventId: "test-event",
        familyId: "test-family",
        atomId: "test-atom",
        atomLabel: "Test Label",
        homeTeam: "Home",
        awayTeam: "Away",
        eventStartTime: new Date(Date.now() + 86400000).toISOString(),
        marketType: "test-market",
        softProvider: "ninewickets-sportsbook",
        softOdds: 2.5,
        commissionPct: 0,
      },
      kellyStake: 100,
      providerRefs: { marketId: "m1", selectionId: "s1" },
    }),
  });

  const res = await POST(req);
  console.log("Status:", res.status);
  console.log("Body:", await res.json());
}
run();
