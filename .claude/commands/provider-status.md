# Provider Adapter Status Check

Deep-dive into all provider adapters to verify they're correctly implemented and aligned.

## Steps

### 1. Read All Adapters

- `lib/adapters/pinnacle.ts` (or `lib/adapters/pinnacle/`)
- `lib/adapters/ninewickets-exchange.ts`
- `lib/adapters/ninewickets-sportsbook.ts`
- `lib/adapters/index.ts` (registry)

### 2. Check Each Adapter Implements the Pattern

Verify each follows the ProviderAdapter interface:

```typescript
interface ProviderAdapter {
  name: Provider;
  fetchEvents(): Promise<NormalizedEvent[]>;
}
```

### 3. Validate Data Normalization

For each adapter, check:

- [ ] Events have unique IDs
- [ ] Team names are properly extracted
- [ ] Competition names are normalized
- [ ] Start times are valid Date objects
- [ ] Provider-specific event IDs are preserved

### 4. Check Atoms Adapters

Read the odds-fetching adapters:

- `lib/atoms/adapters/pinnacle.ts`
- `lib/atoms/adapters/ninewickets-exchange.ts`
- `lib/atoms/adapters/ninewickets-sportsbook.ts`

Verify each implements:

```typescript
interface AtomsProviderAdapter {
  providerId: ProviderKey;
  fetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
  ): Promise<number>;
}
```

### 5. Cross-Check Provider Registry

- Read `lib/providers/registry.ts`
- Verify all adapters are registered
- Check oddsSource is correct (exchange vs sportsbook)

### 6. Report

Table format:
| Provider | Events Adapter | Atoms Adapter | Registry | Odds Source | Issues |
|----------|---------------|---------------|----------|-------------|--------|
| Pinnacle | ? | ? | ? | exchange | ... |
| NW Exchange | ? | ? | ? | exchange | ... |
| NW Sportsbook | ? | ? | ? | sportsbook | ... |
