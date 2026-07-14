# Central agent config

Shared, versioned configuration for AI coding agents that work on NahidArbX.

| Path | Purpose |
| --- | --- |
| `agent-instruction.md` | Canonical operating contract (linked as root `AGENTS.md` / `CLAUDE.md`) |
| `skills/` | Domain workflows agents load for matcher, settlement, and cleanup work |
| `mcp/` | Project-scoped MCP servers (Postgres via Cloud SQL + `.env`) |

Local tool state (`.claude/`, `.cursor/`, `.codex/`, `.grok/`, etc.) stays gitignored. Only this project contract is committed — as evidence of how the system was built under agent rules, and so every tool keeps reading the same constraints.
