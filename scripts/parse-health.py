#!/usr/bin/env python3
"""Quick health check — prints engine store counts."""
import sys, json
d = json.load(sys.stdin)
e = d.get("connectionHealth", {}).get("engine", {})
m = d.get("memory", {}).get("stores", {})
det = e.get("detector", {})
polls = e.get("pollingLoops", {})
print(f'uptime={d.get("uptime")} events={m.get("events",0)} odds={m.get("odds",0)} valueBets={m.get("valueBets",0)} 9W={polls.get("ninewickets",0)} VK={polls.get("velki",0)} passes={det.get("totalPasses",0)}')
