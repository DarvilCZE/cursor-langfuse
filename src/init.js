import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readUserConfig } from "./config.js";
import { HOOK_EVENT_NAMES } from "./handlers.js";

export function userHooksPath() {
  return join(homedir(), ".cursor", "hooks.json");
}

export function cliCommandPath(scriptPath = process.argv[1]) {
  return realpathSync(scriptPath);
}

export async function runInit({
  argv = [],
  hooksPath = userHooksPath(),
  command = cliCommandPath(),
} = {}) {
  if (argv.length > 0) {
    throw new Error("Usage: cursor-langfuse init");
  }

  const installedPath = await installUserHooks({ hooksPath, command });
  return {
    hooksPath: installedPath,
    needsConfigure: !(await hasCredentials()),
  };
}

export async function installUserHooks({ hooksPath, command }) {
  const existing = await readHooksFile(hooksPath);
  const hooks = { ...(existing.hooks ?? {}) };
  const next = {
    ...existing,
    version: existing.version ?? 1,
    hooks,
  };

  for (const event of HOOK_EVENT_NAMES) {
    const current = hooks[event];
    if (current != null && !Array.isArray(current)) {
      throw new Error(`${event} in ${hooksPath} must be an array of hook commands`);
    }
    hooks[event] = mergeCommand(current ?? [], command);
  }

  await mkdir(dirname(hooksPath), { recursive: true });
  await writeFile(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
  return hooksPath;
}

async function readHooksFile(hooksPath) {
  let raw;
  try {
    raw = await readFile(hooksPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    if (parsed.hooks != null && (typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks))) {
      throw new Error("hooks must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Could not read ${hooksPath}: ${error.message}`);
  }
}

function mergeCommand(entries, command) {
  let seen = false;
  const merged = [];
  for (const entry of entries) {
    if (!isLangfuseHook(entry, command)) {
      merged.push(entry);
      continue;
    }
    if (seen) continue;
    seen = true;
    merged.push({ ...entry, command });
  }
  if (!seen) merged.push({ command });
  return merged;
}

function isLangfuseHook(entry, scriptPath) {
  const command = entry?.command;
  if (typeof command !== "string") return false;
  const executable = command.trim().split(/\s+/)[0];
  const name = basename(executable);
  if (name === "cursor-langfuse" || name === "cursor-langfuse.js") return true;
  try {
    return realpathSync(executable) === realpathSync(scriptPath);
  } catch {
    return false;
  }
}

async function hasCredentials() {
  if (process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY) return true;
  try {
    const config = await readUserConfig();
    return Boolean(config?.secretKey && config?.publicKey);
  } catch {
    return false;
  }
}
