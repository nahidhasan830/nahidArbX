import { NextResponse } from "next/server";
import { getEnabledEventAdapters, getAtomsDebugAdapter } from "@/lib/adapters/unified-registry";
import { mapSportsbookToAtom } from "@/lib/atoms/mappings/ninewickets-sportsbook";

export async function GET() {
  const providerId = "ninewickets-sportsbook";
  
  const adapters = getEnabledEventAdapters();
  const eventAdapter = adapters.find(a => a.name === providerId);
  const debugAtomsAdapter = getAtomsDebugAdapter(providerId as any);

  if (!eventAdapter || !debugAtomsAdapter) {
    return NextResponse.json({ error: "Adapters not found" });
  }

  const events = await eventAdapter.fetchEvents();
  const now = Date.now();
  
  const live = events.filter(e => e.startTime.getTime() <= now);
  const upcoming = events.filter(e => e.startTime.getTime() > now);
  
  const result: any = {
    liveCount: live.length,
    upcomingCount: upcoming.length,
    liveAnalysis: [],
    upcomingAnalysis: []
  };
  
  const processEvents = async (eventList: any[], outArray: any[]) => {
    for (const ev of eventList.slice(0, 15)) {
      const providerData = ev.providers[providerId];
      if (!providerData) continue;
      
      try {
        const fetchResult = await debugAtomsAdapter.debugFetchAndStoreOdds(
          providerData.eventId,
          ev.id,
          ev.homeTeam,
          ev.awayTeam
        );
        
        const rawResponses = fetchResult.rawResponses || [];
        if (rawResponses.length === 0) continue;
        
        const raw = rawResponses[0];
        const markets = new Set<string>();
        
        const searchForMarketNames = (obj: any) => {
          if (!obj) return;
          if (Array.isArray(obj)) {
            obj.forEach(searchForMarketNames);
          } else if (typeof obj === "object") {
            if (obj.marketName) markets.add(obj.marketName);
            if (obj.MarketName) markets.add(obj.MarketName);
            if (obj.market_name) markets.add(obj.market_name);
            Object.values(obj).forEach(searchForMarketNames);
          }
        };
        
        searchForMarketNames(raw);
        
        const teamTotals = Array.from(markets).filter(m => 
          m.toLowerCase().includes("total") && 
          (m.toLowerCase().includes("home") || m.toLowerCase().includes("away") || 
           m.toLowerCase().includes(ev.homeTeam.toLowerCase()) || 
           m.toLowerCase().includes(ev.awayTeam.toLowerCase()))
        );
        
        if (teamTotals.length > 0) {
          const mappedList = teamTotals.map(m => {
            const mapped = mapSportsbookToAtom(0, "over", m, ev.homeTeam, ev.awayTeam, 0);
            return { raw: m, mapped };
          });
          
          outArray.push({
            event: `${ev.homeTeam} vs ${ev.awayTeam}`,
            id: providerData.eventId,
            teamTotals: mappedList
          });
        }
      } catch (e) {
        // ignore errors
      }
    }
  };

  await processEvents(live, result.liveAnalysis);
  await processEvents(upcoming, result.upcomingAnalysis);
  
  return NextResponse.json(result);
}
