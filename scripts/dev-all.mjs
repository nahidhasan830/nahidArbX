#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const bootDir = "/tmp/nahidarbx-boot";
const children = new Set();
const processGroups = new Map();
let shuttingDown = false;
let exitCode = 0;

rmSync(bootDir, { recursive: true, force: true });

const sharedEnv = {
  ...process.env,
  NAHIDARBX_UNIFIED_BOOT: "1",
};

start("engine", "npm", ["run", "engine"], {
  ...sharedEnv,
  NAHIDARBX_ENGINE: "1",
});

const frontendTimer = setTimeout(() => {
  start("frontend", "npm", ["run", "dev"], sharedEnv);
}, 2_000);

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("exit", () => {
  clearTimeout(frontendTimer);
  for (const group of processGroups.values()) terminateGroup(group, "SIGTERM");
});

function start(name, command, args, env) {
  if (shuttingDown) return null;

  const child = spawn(command, args, {
    detached: true,
    env,
    stdio: "inherit",
  });

  child.__name = name;
  children.add(child);
  if (child.pid) {
    processGroups.set(child.pid, { pid: child.pid, name });
  }

  child.on("exit", (code, signal) => {
    children.delete(child);
    pruneExitedGroups();
    if (shuttingDown) return;

    if (signal) {
      console.error(`[dev:all] ${name} exited from ${signal}`);
      exitCode = 1;
    } else if (code && code !== 0) {
      console.error(`[dev:all] ${name} exited with code ${code}`);
      exitCode = code;
    } else {
      console.error(`[dev:all] ${name} exited`);
    }

    shutdown("SIGTERM");
  });

  child.on("error", (err) => {
    children.delete(child);
    console.error(`[dev:all] failed to start ${name}: ${err.message}`);
    exitCode = 1;
    shutdown("SIGTERM");
  });

  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  clearTimeout(frontendTimer);

  for (const group of processGroups.values()) terminateGroup(group, signal);

  const deadline = setTimeout(() => {
    for (const group of processGroups.values()) {
      terminateGroup(group, "SIGKILL");
    }
    process.exit(exitCode);
  }, 7_000);

  const check = setInterval(() => {
    pruneExitedGroups();
    if (children.size === 0 && processGroups.size === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  }, 100);
}

function terminateGroup(group, signal) {
  if (!group?.pid) return;
  try {
    process.kill(-group.pid, signal);
  } catch {
    processGroups.delete(group.pid);
  }
}

function pruneExitedGroups() {
  for (const group of processGroups.values()) {
    if (!isGroupAlive(group.pid)) {
      processGroups.delete(group.pid);
    }
  }
}

function isGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
