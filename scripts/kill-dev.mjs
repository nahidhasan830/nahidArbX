#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const PORTS = ["3000", "3001", "8090"];
const PATTERNS = [
  "tsx engine.ts",
  "tsx scripts/ai-search-supervisor.ts",
  "uvicorn app.main:app",
  "next dev",
];
const SELF_PID = process.pid;

const pids = new Set();

for (const port of PORTS) {
  for (const pid of pidsFromLsof(port)) pids.add(pid);
}

for (const pattern of PATTERNS) {
  for (const pid of pidsFromPgrep(pattern)) pids.add(pid);
}

pids.delete(String(SELF_PID));

if (pids.size === 0) {
  console.log("No local dev servers found");
  process.exit(0);
}

console.log(`Stopping local dev servers: ${[...pids].join(", ")}`);

for (const pid of pids) {
  signalPid(pid, "SIGTERM");
}

await sleep(7000);

const survivors = [...pids].filter(isRunning);
if (survivors.length > 0) {
  console.log(`Force-stopping remaining processes: ${survivors.join(", ")}`);
  for (const pid of survivors) signalPid(pid, "SIGKILL");
}

console.log("✓ Local dev servers stopped");

function pidsFromLsof(port) {
  try {
    const output = execFileSync("lsof", ["-ti", `:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function pidsFromPgrep(pattern) {
  try {
    const output = execFileSync("pgrep", ["-f", pattern], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\s+/)
      .filter(Boolean)
      .filter((pid) => pid !== String(SELF_PID));
  } catch {
    return [];
  }
}

function signalPid(pid, signal) {
  try {
    process.kill(Number(pid), signal);
  } catch {
    // Process already exited.
  }
}

function isRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
