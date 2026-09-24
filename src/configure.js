import { createInterface } from "node:readline";
import {
  CONFIGURE_USAGE,
  configFilePath,
  parseConfigureArgs,
  writeUserConfig,
} from "./config.js";

export async function runConfigure(argv, { io = process, path = configFilePath() } = {}) {
  const args = parseConfigureArgs(argv);
  const interactive = Boolean(io.stdin.isTTY && io.stdout.isTTY);
  if (!interactive && (!args.secretKey || !args.publicKey)) {
    throw new Error(CONFIGURE_USAGE.trim());
  }

  const secretKey = args.secretKey || (await prompt(io, "Langfuse secret key: ", { hidden: true }));
  const publicKey = args.publicKey || (await prompt(io, "Langfuse public key: "));
  let baseUrl = args.baseUrl;
  const promptedForKey = !args.secretKey || !args.publicKey;
  if (baseUrl === undefined && interactive && promptedForKey) {
    baseUrl = await prompt(io, "Langfuse base URL (Enter for https://cloud.langfuse.com): ");
  }

  return writeUserConfig({ secretKey, publicKey, baseUrl }, path);
}

function prompt(io, question, { hidden = false } = {}) {
  if (hidden && typeof io.stdin.setRawMode === "function") {
    return promptHidden(io, question);
  }
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(io, question) {
  return new Promise((resolve) => {
    io.stdout.write(question);
    io.stdin.setRawMode(true);
    io.stdin.resume();
    io.stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      const char = String(chunk);
      if (char === "\n" || char === "\r" || char === "\u0004") {
        io.stdin.setRawMode(false);
        io.stdin.pause();
        io.stdin.removeListener("data", onData);
        io.stdout.write("\n");
        resolve(value.trim());
        return;
      }
      if (char === "\u0003") {
        io.stdout.write("\n");
        process.exit(1);
      }
      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    io.stdin.on("data", onData);
  });
}
