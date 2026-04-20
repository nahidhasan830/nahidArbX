# Sync Pipeline Test

Run a quick health check of the entire sync pipeline without triggering a full sync.

## Steps

### 1. Verify Providers Are Registered

- Read `lib/adapters/index.ts` and confirm all 3 adapters are exported
- Read `lib/providers/registry.ts` and confirm provider metadata is correct

### 2. Check Token Status

- Check if `sessions/betjili/pinnacle-token.json` exists and if the token is expired
- Report token age and expiry status

### 3. Test API Endpoints

Run these checks:

```bash
# Check if dev server is running
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null || echo "Server not running"

# Check admin API response shape
curl -s http://localhost:3000/api/dashboard 2>/dev/null | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); try{const j=JSON.parse(d); console.log('Events:', j.events?.length ?? 0, 'Arbs:', j.arbitrageOpportunities?.length ?? 0, 'Syncing:', j.syncStatus?.isSyncing)}catch{console.log('API not responding or invalid JSON')}"
```

### 4. Validate Store State

- Read `lib/store.ts` and check the current store structure
- Verify atoms store at `lib/atoms/store.ts` is properly initialized

### 5. Report Summary

Present a table:
| Check | Status | Details |
|-------|--------|---------|
| Providers registered | ? | ... |
| Pinnacle token | ? | ... |
| Dev server | ? | ... |
| API response | ? | ... |
| Store initialized | ? | ... |
