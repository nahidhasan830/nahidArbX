/**
 * In-memory command registry. `commands/index.ts` registers every command
 * at import time; the long-poll loop dispatches to it via `getCommand`
 * and `listCommands`.
 */

import type { CommandSpec } from "./types";

const REGISTRY = new Map<string, CommandSpec>();

export function registerCommand(spec: CommandSpec): void {
  REGISTRY.set(spec.name.toLowerCase(), spec);
}

export function getCommand(name: string): CommandSpec | undefined {
  return REGISTRY.get(name.toLowerCase().replace(/^\//, ""));
}

export function listCommands(): CommandSpec[] {
  return Array.from(REGISTRY.values()).sort((a, b) => {
    const order = { meta: 0, read: 1, control: 2, destructive: 3 };
    if (order[a.group] !== order[b.group])
      return order[a.group] - order[b.group];
    return a.name.localeCompare(b.name);
  });
}
