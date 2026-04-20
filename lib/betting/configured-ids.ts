/**
 * Client-safe list of provider IDs that have a registered betting adapter.
 *
 * KEEP THIS FILE FREE OF SERVER-ONLY IMPORTS.
 * lib/betting/registry.ts pulls in adapter code that ultimately imports
 * `playwright`, which Turbopack cannot bundle for the client. Any component
 * that needs to know whether a provider is placeable should import from here,
 * NOT from registry.ts.
 *
 * When you add a new adapter to BETTING_PROVIDERS in registry.ts, add the
 * same providerId string here.
 */
export const CONFIGURED_BETTING_PROVIDER_IDS: string[] = [
  "ninewickets-sportsbook",
];
