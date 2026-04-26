/**
 * /help — auto-generated from the registry. Always enabled.
 */

import { isCommandEnabled } from "../config";
import { registerCommand, listCommands } from "../registry";
import { b, esc } from "../format";

registerCommand({
  name: "help",
  usage: "/help",
  description: "List every available command, grouped by purpose.",
  explanation:
    "Shows the full command menu so you don't have to remember names. Each entry includes the command itself, its usage, and a one-line description. Disabled commands appear with a 🚫 marker so you know which ones to re-enable from the /telegram dashboard page.",
  group: "meta",
  async handler({ argsRaw, reply }) {
    const all = listCommands();
    if (argsRaw) {
      const target = argsRaw.replace(/^\//, "").toLowerCase();
      const found = all.find((c) => c.name === target);
      if (!found) {
        await reply(`❓ Unknown command: ${esc(argsRaw)}`);
        return { alreadyReplied: true };
      }
      const enabled = isCommandEnabled(found.name);
      const lines = [
        `${b("/" + found.name)} ${found.destructive ? "⚠️" : ""} ${enabled ? "" : "🚫"}`.trim(),
        `<i>${esc(found.usage)}</i>`,
        "",
        esc(found.description),
        "",
        esc(found.explanation),
      ];
      await reply(lines.join("\n"));
      return { alreadyReplied: true };
    }
    const groups: Record<string, typeof all> = {
      meta: [],
      read: [],
      control: [],
      destructive: [],
    };
    for (const c of all) groups[c.group].push(c);
    const sections: Array<[string, string]> = [
      ["📖 Help", "meta"],
      ["📊 Read", "read"],
      ["🎛 Control", "control"],
      ["⚠️ Destructive", "destructive"],
    ];
    const out: string[] = ["🤖 " + b("NahidArbX Telegram Control") + "\n"];
    for (const [label, key] of sections) {
      const list = groups[key];
      if (list.length === 0) continue;
      out.push(b(label));
      for (const c of list) {
        const dis = isCommandEnabled(c.name) ? "" : " 🚫";
        const dest = c.destructive ? " ⚠️" : "";
        out.push(`/${c.name}${dest}${dis} — ${esc(c.description)}`);
      }
      out.push("");
    }
    out.push(
      "<i>🚫 = disabled in dashboard. Use /help &lt;cmd&gt; for full details.</i>",
    );
    await reply(out.join("\n"));
    return { alreadyReplied: true };
  },
});
