import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE_FIELDS = {
  secretKey: "LANGFUSE_SECRET_KEY",
  publicKey: "LANGFUSE_PUBLIC_KEY",
  baseUrl: "LANGFUSE_BASE_URL",
};

export function configFilePath() {
  if (process.env.CURSOR_LANGFUSE_CONFIG) {
    return process.env.CURSOR_LANGFUSE_CONFIG;
  }
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "cursor-langfuse", "config.json");
}

export async function readUserConfig(path = configFilePath()) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Config file must be a JSON object: ${path}`);
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Fill Langfuse environment variables that are not already set.
 * Existing process environment values win over the config file.
 */
export async function applyUserConfig(path = configFilePath()) {
  let config;
  try {
    config = await readUserConfig(path);
  } catch (error) {
    console.error(`[cursor-langfuse] ${error.message}`);
    return;
  }
  if (!config) return;

  for (const [field, envName] of Object.entries(FILE_FIELDS)) {
    const value = config[field];
    if (process.env[envName]) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) process.env[envName] = trimmed;
  }
}

export async function writeUserConfig(
  { secretKey, publicKey, baseUrl },
  path = configFilePath()
) {
  const secret = requiredText(secretKey, "secret key");
  const publicKeyValue = requiredText(publicKey, "public key");
  const payload = { secretKey: secret, publicKey: publicKeyValue };
  const base = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (base) payload.baseUrl = base;

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`A ${label} is required`);
  }
  return value.trim();
}

export function parseConfigureArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--secret-key") {
      result.secretKey = requireValue(argv, ++i, arg);
    } else if (arg === "--public-key") {
      result.publicKey = requireValue(argv, ++i, arg);
    } else if (arg === "--base-url") {
      result.baseUrl = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--secret-key=")) {
      result.secretKey = arg.slice("--secret-key=".length);
    } else if (arg.startsWith("--public-key=")) {
      result.publicKey = arg.slice("--public-key=".length);
    } else if (arg.startsWith("--base-url=")) {
      result.baseUrl = arg.slice("--base-url=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

export const CONFIGURE_USAGE = `Usage: cursor-langfuse configure --secret-key <key> --public-key <key> [--base-url <url>]

Writes ~/.config/cursor-langfuse/config.json (mode 0600).
Set XDG_CONFIG_HOME or CURSOR_LANGFUSE_CONFIG to choose a different path.
`;
