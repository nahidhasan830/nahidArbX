# Project-Scoped MCP

MCP servers for this repository live here so agent-specific folders only point at a shared project-local source of truth. This directory is tracked so the agent toolchain is visible alongside `AGENTS.md`.

- Codex reads `.codex/config.toml`, which symlinks to `codex.config.toml`.
- Claude Code reads `.mcp.json`, which symlinks to `claude.mcp.json`.
- The Postgres server loads the root `.env` and connects to the project Cloud SQL Postgres database (credentials never committed).
- `cwd` in the MCP configs is `.` (repo root when the agent starts from the project).
