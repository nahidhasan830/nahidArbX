/**
 * /settings (read) and /set (write) — manipulate the singleton
 * `betting_settings` row used by the auto-placer.
 */

import {
  getBettingSettings,
  updateBettingSettings,
} from "@/lib/db/repositories/betting-settings";
import { registerCommand } from "../registry";
import { b, code, esc, header, kvList, money, pct } from "../format";

registerCommand({
  name: "settings",
  usage: "/settings",
  description: "Show the current betting settings (EV cutoff, Kelly, caps).",
  explanation:
    "Displays every field on the singleton betting_settings row that the auto-placer reads on every tick: minimum EV%, Kelly fraction + cap, stake unit + minimum + bucket. Use /set to change any field; use the dashboard for the long-form 'why each one matters' tooltips.",
  group: "read",
  async handler({ reply }) {
    const { row, ready, error } = await getBettingSettings();
    if (!ready) {
      await reply(`⚠️ Settings unavailable: ${esc(error ?? "unknown")}`);
      return { alreadyReplied: true };
    }
    const lines = [
      header("⚙️", "Betting settings"),
      "",
      b("Stake sizing"),
      kvList([
        [
          "Live balance",
          row.useLiveBalance
            ? "🟢 use live"
            : `⚪ manual ${money(row.manualBankrollBdt)}`,
        ],
        ["Unit size", money(row.unitSizeBdt)],
        ["Min stake", money(row.minStakeBdt)],
        ["Stake bucket", money(row.stakeBucketBdt)],
        ["Kelly fraction", row.kellyFraction.toString()],
        ["Kelly cap", pct(row.kellyCapPct)],
      ]),
      "",
      kvList([
        ["Min EV%", pct(row.minEvPct)],
      ]),
      "",
      `<i>Last updated ${esc(row.updatedAt)}. Use ${code("/set ev=2.5 kelly=0.25 …")} to change.</i>`,
    ];
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

const FIELD_MAP: Record<
  string,
  {
    field: string;
    parse: (raw: string) => unknown;
    nullable?: boolean;
  }
> = {
  ev: { field: "minEvPct", parse: (s) => parseFloat(s) },
  minev: { field: "minEvPct", parse: (s) => parseFloat(s) },
  kelly: { field: "kellyFraction", parse: (s) => parseFloat(s) },
  kellycap: { field: "kellyCapPct", parse: (s) => parseFloat(s) },
  unit: { field: "unitSizeBdt", parse: (s) => parseFloat(s) },
  minstake: { field: "minStakeBdt", parse: (s) => parseFloat(s) },
  bucket: { field: "stakeBucketBdt", parse: (s) => parseFloat(s) },
  manualbank: { field: "manualBankrollBdt", parse: (s) => parseFloat(s) },
  livebal: {
    field: "useLiveBalance",
    parse: (s) => s === "true" || s === "on" || s === "1",
  },

};

registerCommand({
  name: "set",
  usage: "/set <key>=<value> [<key>=<value> ...]",
  description: "Update one or more betting-settings fields.",
  explanation:
    `Patches the betting_settings row. Whitespace-separate kv pairs, e.g. ${"<code>/set ev=2.5 kelly=0.5</code>"}. ` +
    "Recognised keys: ev / minev (min EV%), kelly (Kelly fraction 0–1), kellycap (Kelly cap %), " +
    "unit (unit size BDT), minstake (min stake BDT), bucket (stake bucket BDT), manualbank (manual bankroll BDT), " +
    "livebal (true/false). Changes are applied atomically and " +
    "the auto-placer picks them up on the next tick.",
  group: "control",
  async handler({ args, reply }) {
    if (args.length === 0) {
      await reply("Usage: /set ev=2.5 kelly=0.25 …");
      return { alreadyReplied: true };
    }
    const patch: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const tok of args) {
      const eq = tok.indexOf("=");
      if (eq === -1) {
        errors.push(`${tok}: missing '=' (use key=value)`);
        continue;
      }
      const key = tok.slice(0, eq).toLowerCase();
      const raw = tok.slice(eq + 1);
      const def = FIELD_MAP[key];
      if (!def) {
        errors.push(`${key}: unknown key`);
        continue;
      }
      const val = def.parse(raw);
      if (val === undefined || (typeof val === "number" && Number.isNaN(val))) {
        errors.push(`${key}: invalid value '${raw}'`);
        continue;
      }
      patch[def.field] = val;
    }
    if (Object.keys(patch).length === 0) {
      await reply(`⚠️ Nothing to update.\n${errors.join("\n")}`);
      return { alreadyReplied: true };
    }
    try {
      await updateBettingSettings(patch);
      const summary = Object.entries(patch)
        .map(([k, v]) => `${k}=${v === null ? "off" : v}`)
        .join(", ");
      const note =
        errors.length > 0 ? `\n\n⚠️ Skipped: ${errors.join("; ")}` : "";
      await reply(`✅ Updated: ${esc(summary)}${esc(note)}`);
    } catch (err) {
      await reply(`⚠️ Update failed: ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});
