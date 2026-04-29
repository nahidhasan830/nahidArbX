import { NextResponse } from "next/server";
import { getEnabledEventAdapters, getAtomsDebugAdapter } from "@/lib/adapters/unified-registry";
import { PROVIDER_IDS } from "@/lib/providers/registry";
import { mapPinnacleToAtom } from "@/lib/atoms/mappings/pinnacle";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") || "pinnacle";

  const allRawData: Record<string, any[]> = {};
  const unmapped: Record<string, Set<string>> = {
    [provider]: new Set<string>()
  };

  const adapters = getEnabledEventAdapters();
  const pinnEventAdapter = adapters.find(a => a.name === provider);
  const pinnDebugAdapter = getAtomsDebugAdapter(provider as any);

  if (pinnEventAdapter && pinnDebugAdapter) {
    try {
      const events = await pinnEventAdapter.fetchEvents();
      const upcoming = events.filter(e => e.startTime.getTime() > Date.now()).slice(0, 10);
      allRawData[provider] = [];

      for (const ev of upcoming) {
        const providerData = ev.providers[provider as keyof typeof ev.providers];
        if (!providerData) continue;
        
        const result = await pinnDebugAdapter.debugFetchAndStoreOdds(
          providerData.eventId,
          ev.id,
          ev.homeTeam,
          ev.awayTeam
        );
        allRawData[provider].push({
          eventId: providerData.eventId,
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          rawResponses: result.rawResponses
        });

        if (provider !== "pinnacle") continue;

        // Analyze unmapped
        for (const resp of result.rawResponses) {
          const respData = resp.data as any;
          if (respData && respData.data && Array.isArray(respData.data) && respData.data[0] && Array.isArray(respData.data[0])) {
            const leagues = respData.data[0][3];
            for (const league of leagues) {
              const matches = league[2];
              for (const match of matches) {
                const matchId = match[0];
                if (matchId.toString() !== providerData.eventId) continue;
                
                const periods = match[5];
                for (const period of periods) {
                  const hasMarkets = period[4];
                  if (!hasMarkets) continue;
                  
                  const rawMarkets = period[5];
                  for (const market of rawMarkets) {
                    const marketType = market[4];
                    const periodType = market[10];
                    const halfIndicator = market[1];
                    const outcomes = market[12];
                    const handicap = market[13];
                    const marketSide = market[15];
                  
                  if (market[16] !== "OPEN") continue;

                  let isUnmapped = false;
                  for (const outcome of outcomes) {
                    const side = outcome[2];
                    const direction = outcome[3];
                    
                    const atomId = mapPinnacleToAtom(
                      marketType,
                      periodType,
                      handicap,
                      side,
                      direction,
                      marketSide,
                      halfIndicator
                    );
                    
                    if (!atomId) {
                      isUnmapped = true;
                      break;
                    }
                  }
                  
                  if (isUnmapped) {
                    unmapped["pinnacle"].add(`${marketType} | ${periodType} | halfIndicator=${halfIndicator}`);
                  }
                }
              }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Convert Sets to Arrays for JSON serialization
  const result: any = { rawData: allRawData, unmapped: {} };
  for (const k of Object.keys(unmapped)) {
    result.unmapped[k] = Array.from(unmapped[k]);
  }

  return NextResponse.json(result);
}
