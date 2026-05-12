#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Provider Health Observer — monitors 9W/Velki connectivity for 60 min
#
# Polls the engine health endpoint every 30s and logs:
#   • Provider status (ok/error)
#   • Circuit breaker state (open/closed/half-open)
#   • Response sizes + transfer times for fixture APIs
#   • Session diagnostics (step-level capture status)
#   • Network reachability metrics
#
# Usage:  bash scripts/observe-providers.sh [duration_minutes]
#         Default: 60 minutes
#
# Output: logs/provider-observe-<timestamp>.log
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

DURATION_MINUTES="${1:-60}"
INTERVAL_SECONDS=30
LOG_DIR="logs"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/provider-observe-${TIMESTAMP}.log"

ENGINE_URL="http://127.0.0.1:3001"

# Velki session info
VELKI_SESSION_FILE="sessions/velki/session.json"
VELKI_EVENTS_URL="https://bkqawscf.fwick7ets.xyz/exchange/member/playerService/queryEventsWithMarket"

# 9W session info
NW_SESSION_FILE="sessions/9wkts/session.json"
NW_EVENTS_URL="https://gakvx.seofmi.live/exchange/member/playerService/queryEvents"

# Colors for terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" >> "$LOG_FILE"
  echo -e "$msg"
}

log_section() {
  local msg="$*"
  echo "" >> "$LOG_FILE"
  echo "═══════════════════════════════════════════════════════" >> "$LOG_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $msg" >> "$LOG_FILE"
  echo "═══════════════════════════════════════════════════════" >> "$LOG_FILE"
  echo ""
  echo -e "${CYAN}═══ [$(date '+%H:%M:%S')] $msg ═══${NC}"
}

# ── Helper: test raw API connectivity ────────────────────────────────

test_velki_api() {
  local jsessionid
  jsessionid=$(python3 -c "import json; print(json.load(open('$VELKI_SESSION_FILE'))['jsessionid'])" 2>/dev/null || echo "")
  if [[ -z "$jsessionid" ]]; then
    echo "NO_SESSION"
    return
  fi

  local result
  result=$(curl -sS --max-time 45 -o /dev/null \
    -w '%{http_code}|%{time_total}|%{size_download}|%{time_starttransfer}' \
    -X POST \
    "${VELKI_EVENTS_URL};jsessionid=${jsessionid}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Authorization: ${jsessionid}" \
    -H "Cookie: JSESSIONID=${jsessionid}" \
    -H "Origin: https://www.fwick7ets.xyz" \
    -H "Referer: https://www.fwick7ets.xyz/" \
    -d "eventType=1&eventTs=-1&marketTs=-1&selectionTs=-1&viewType=openDateTime&competitionId=-1&pageNumber=-1" \
    2>&1 || echo "0|0|0|0")
  echo "$result"
}

test_nw_api() {
  local querypass
  querypass=$(python3 -c "import json; print(json.load(open('$NW_SESSION_FILE'))['queryPass'])" 2>/dev/null || echo "")
  if [[ -z "$querypass" ]]; then
    echo "NO_SESSION"
    return
  fi

  local result
  result=$(curl -sS --max-time 45 -o /dev/null \
    -w '%{http_code}|%{time_total}|%{size_download}|%{time_starttransfer}' \
    -X POST \
    "${NW_EVENTS_URL};jsessionid=${querypass}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Authorization: ${querypass}" \
    -H "Cookie: JSESSIONID=${querypass}" \
    -H "Origin: https://www.seofmi.live" \
    -H "Referer: https://www.seofmi.live/" \
    -d "type=1&eventType=1&competitionTs=-1&eventTs=-1&marketTs=-1&selectionTs=-1&collectEventIds=" \
    2>&1 || echo "0|0|0|0")
  echo "$result"
}

# ── Helper: get engine health ────────────────────────────────────────

get_engine_health() {
  curl -sS --max-time 5 "${ENGINE_URL}/engine/value-bets?fields=connectionHealth" 2>/dev/null || echo "{}"
}

# ── Main observation loop ────────────────────────────────────────────

TOTAL_TICKS=$(( DURATION_MINUTES * 60 / INTERVAL_SECONDS ))
TICK=0

log "╔══════════════════════════════════════════════════════════════╗"
log "║  Provider Health Observer                                   ║"
log "║  Duration: ${DURATION_MINUTES} minutes  |  Interval: ${INTERVAL_SECONDS}s  |  Ticks: ${TOTAL_TICKS}       ║"
log "║  Log: ${LOG_FILE}                                           ║"
log "╚══════════════════════════════════════════════════════════════╝"
log ""

# Counters for summary
VK_OK=0; VK_FAIL=0; VK_TIMEOUT=0
NW_OK=0; NW_FAIL=0; NW_TIMEOUT=0
CB_OPEN_EVENTS=0

while [[ $TICK -lt $TOTAL_TICKS ]]; do
  TICK=$((TICK + 1))
  ELAPSED_MIN=$(( TICK * INTERVAL_SECONDS / 60 ))

  log_section "Tick ${TICK}/${TOTAL_TICKS}  (${ELAPSED_MIN}/${DURATION_MINUTES} min)"

  # ── 1. Engine Health Status ──
  HEALTH_JSON=$(get_engine_health)

  if [[ "$HEALTH_JSON" == "{}" ]]; then
    log "  ⚠ Engine unreachable"
  else
    # Parse with Python for reliable JSON handling
    python3 -c "
import json, sys
d = json.loads('''${HEALTH_JSON}''')
ch = d.get('connectionHealth', {})
engine = ch.get('engine', {})

# Provider status
for pid in ['ninewickets-sportsbook', 'velki-sportsbook']:
    entry = ch.get(pid, {})
    status = entry.get('status', '?')
    error = entry.get('error', '')
    last = entry.get('lastFetch', '?')
    icon = '✓' if status == 'ok' else '✗'
    print(f'  {icon} {pid}: status={status}, lastFetch={last}')
    if error:
        print(f'      error: {error}')

# Circuit breakers
cbs = engine.get('circuitBreakers', {})
for cid in ['ninewickets-sportsbook', 'velki-sportsbook', 'pinnacle']:
    cb = cbs.get(cid, {})
    state = cb.get('state', '?')
    fails = cb.get('failures', 0)
    icon = '🔴' if state == 'open' else '🟡' if state == 'half-open' else '🟢'
    print(f'  {icon} CB {cid}: {state} (failures={fails})')

# Matched events
matched = engine.get('matchedCount', '?')
total = engine.get('totalEvents', '?')
print(f'  📊 Matched: {matched}/{total}')

# Polling loops
loops = engine.get('pollingLoops', {})
print(f'  🔄 Loops: nw={loops.get(\"ninewickets\", 0)}, vk={loops.get(\"velki\", 0)}')

# Session capture diagnostics
sc = engine.get('sessionCapture', {})
if sc:
    print(f'  🔑 Session Capture:')
    for pid, diag in sc.items():
        cap_status = diag.get('lastCaptureStatus', '?')
        consec = diag.get('consecutiveFailures', 0)
        attempts = diag.get('totalAttempts', 0)
        icon = '✓' if cap_status == 'ok' else '✗' if cap_status == 'failed' else '⏳'
        print(f'      {icon} {pid}: {cap_status} (consec_fail={consec}, total_attempts={attempts})')
        for step in diag.get('steps', []):
            s_icon = '✓' if step['status'] == 'ok' else '✗'
            dur = f' {step.get(\"durationMs\", \"?\")}ms' if step.get('durationMs') is not None else ''
            err = f' — {step[\"error\"][:80]}' if step.get('error') else ''
            print(f'          {s_icon} {step[\"step\"]}{dur}{err}')
" 2>/dev/null || log "  ⚠ Failed to parse engine health"
  fi

  # ── 2. Direct API Tests ──
  log "  ── Direct API Test ──"

  # Velki
  VK_RESULT=$(test_velki_api)
  if [[ "$VK_RESULT" == "NO_SESSION" ]]; then
    log "  VK: no session file"
    VK_FAIL=$((VK_FAIL + 1))
  else
    VK_STATUS=$(echo "$VK_RESULT" | cut -d'|' -f1)
    VK_TIME=$(echo "$VK_RESULT" | cut -d'|' -f2)
    VK_SIZE=$(echo "$VK_RESULT" | cut -d'|' -f3)
    VK_TTFB=$(echo "$VK_RESULT" | cut -d'|' -f4)

    if [[ "$VK_STATUS" == "200" ]]; then
      VK_SIZE_KB=$(echo "scale=0; ${VK_SIZE} / 1024" | bc 2>/dev/null || echo "?")
      log "  ${GREEN}VK: HTTP ${VK_STATUS} | ${VK_SIZE_KB}KB | TTFB ${VK_TTFB}s | Total ${VK_TIME}s${NC}"
      VK_OK=$((VK_OK + 1))
    elif [[ "$VK_STATUS" == "0" ]]; then
      log "  ${RED}VK: TIMEOUT (>45s) | partial ${VK_SIZE} bytes${NC}"
      VK_TIMEOUT=$((VK_TIMEOUT + 1))
    else
      log "  ${RED}VK: HTTP ${VK_STATUS} | ${VK_TIME}s${NC}"
      VK_FAIL=$((VK_FAIL + 1))
    fi
  fi

  # NineWickets
  NW_RESULT=$(test_nw_api)
  if [[ "$NW_RESULT" == "NO_SESSION" ]]; then
    log "  NW: no session file"
    NW_FAIL=$((NW_FAIL + 1))
  else
    NW_STATUS=$(echo "$NW_RESULT" | cut -d'|' -f1)
    NW_TIME=$(echo "$NW_RESULT" | cut -d'|' -f2)
    NW_SIZE=$(echo "$NW_RESULT" | cut -d'|' -f3)
    NW_TTFB=$(echo "$NW_RESULT" | cut -d'|' -f4)

    if [[ "$NW_STATUS" == "200" ]]; then
      NW_SIZE_KB=$(echo "scale=0; ${NW_SIZE} / 1024" | bc 2>/dev/null || echo "?")
      log "  ${GREEN}NW: HTTP ${NW_STATUS} | ${NW_SIZE_KB}KB | TTFB ${NW_TTFB}s | Total ${NW_TIME}s${NC}"
      NW_OK=$((NW_OK + 1))
    elif [[ "$NW_STATUS" == "0" ]]; then
      log "  ${RED}NW: TIMEOUT (>45s) | partial ${NW_SIZE} bytes${NC}"
      NW_TIMEOUT=$((NW_TIMEOUT + 1))
    else
      log "  ${RED}NW: HTTP ${NW_STATUS} | ${NW_TIME}s${NC}"
      NW_FAIL=$((NW_FAIL + 1))
    fi
  fi

  # ── 3. Check if sessions changed ──
  VK_CAPTURED=$(python3 -c "import json; print(json.load(open('$VELKI_SESSION_FILE')).get('capturedAt','?'))" 2>/dev/null || echo "?")
  NW_CAPTURED=$(python3 -c "import json; print(json.load(open('$NW_SESSION_FILE')).get('capturedAt','?'))" 2>/dev/null || echo "?")
  log "  🔑 Sessions: VK captured=${VK_CAPTURED}, NW captured=${NW_CAPTURED}"

  # ── 4. Count CB open events ──
  CB_OPEN=$(echo "$HEALTH_JSON" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    cbs = d.get('connectionHealth',{}).get('engine',{}).get('circuitBreakers',{})
    opens = [k for k, v in cbs.items() if v.get('state') == 'open']
    print(len(opens))
except:
    print(0)
" 2>/dev/null || echo "0")
  if [[ "$CB_OPEN" -gt 0 ]]; then
    CB_OPEN_EVENTS=$((CB_OPEN_EVENTS + 1))
  fi

  # Sleep until next tick
  if [[ $TICK -lt $TOTAL_TICKS ]]; then
    sleep "$INTERVAL_SECONDS"
  fi
done

# ── Final Summary ────────────────────────────────────────────────────

log ""
log "╔══════════════════════════════════════════════════════════════╗"
log "║  OBSERVATION COMPLETE — ${DURATION_MINUTES} min summary                       ║"
log "╠══════════════════════════════════════════════════════════════╣"
log "║  Velki:       OK=${VK_OK}  FAIL=${VK_FAIL}  TIMEOUT=${VK_TIMEOUT}                          ║"
log "║  NineWickets: OK=${NW_OK}  FAIL=${NW_FAIL}  TIMEOUT=${NW_TIMEOUT}                          ║"
log "║  CB open ticks: ${CB_OPEN_EVENTS}/${TOTAL_TICKS}                                        ║"
log "╚══════════════════════════════════════════════════════════════╝"
log ""
log "Full log: ${LOG_FILE}"
