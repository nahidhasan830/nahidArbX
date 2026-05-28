/**
 * Client-safe list of provider IDs that can submit real bets.
 *
 * KEEP THIS FILE FREE OF SERVER-ONLY ADAPTER IMPORTS.
 * lib/betting/registry.ts pulls in adapter code that can import Node-only
 * modules. Components should use this derived list instead.
 */
import { getPlaceableProviderIds } from "@/lib/providers/registry";

export const CONFIGURED_BETTING_PROVIDER_IDS: string[] =
  getPlaceableProviderIds();
