import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyUserConfig,
  parseConfigureArgs,
  writeUserConfig,
} from "../src/config.js";
import { runConfigure } from "../src/configure.js";

function tempConfigPath() {
  return join(mkdtempSync(join(tmpdir(), "cursor-langfuse-config-")), "config.json");
}

function withClearedLangfuseEnv(fn) {
  const previous = {
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
  };
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("configure writes a user-only config file and hook startup fills empty env", async () => {
  const path = tempConfigPath();
  await withClearedLangfuseEnv(async () => {
    const written = await runConfigure(
      ["--secret-key", " sk-test ", "--public-key=pk-test", "--base-url", "https://langfuse.example"],
      { io: { stdin: { isTTY: false }, stdout: { isTTY: false } }, path }
    );
    assert.equal(written, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);

    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(stored, {
      secretKey: "sk-test",
      publicKey: "pk-test",
      baseUrl: "https://langfuse.example",
    });

    await applyUserConfig(path);
    assert.equal(process.env.LANGFUSE_SECRET_KEY, "sk-test");
    assert.equal(process.env.LANGFUSE_PUBLIC_KEY, "pk-test");
    assert.equal(process.env.LANGFUSE_BASE_URL, "https://langfuse.example");
  });
});

test("existing environment variables win over the config file", async () => {
  const path = tempConfigPath();
  await writeUserConfig(
    { secretKey: "from-file", publicKey: "pk-file", baseUrl: "https://file.example" },
    path
  );
  await withClearedLangfuseEnv(async () => {
    process.env.LANGFUSE_SECRET_KEY = "from-env";
    await applyUserConfig(path);
    assert.equal(process.env.LANGFUSE_SECRET_KEY, "from-env");
    assert.equal(process.env.LANGFUSE_PUBLIC_KEY, "pk-file");
    assert.equal(process.env.LANGFUSE_BASE_URL, "https://file.example");
  });
});

test("a missing config file leaves the environment unchanged", async () => {
  await withClearedLangfuseEnv(async () => {
    await applyUserConfig(join(tmpdir(), "cursor-langfuse-missing", "config.json"));
    assert.equal(process.env.LANGFUSE_SECRET_KEY, undefined);
    assert.equal(process.env.LANGFUSE_PUBLIC_KEY, undefined);
  });
});

test("invalid config is reported and ignored", async () => {
  const path = tempConfigPath();
  await writeUserConfig({ secretKey: "sk", publicKey: "pk" }, path);
  writeFileSync(path, "{", { mode: 0o600 });
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    await withClearedLangfuseEnv(async () => {
      await applyUserConfig(path);
      assert.equal(process.env.LANGFUSE_SECRET_KEY, undefined);
    });
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cursor-langfuse/);
});

test("configure requires keys when there is no terminal", async () => {
  const path = tempConfigPath();
  await assert.rejects(
    () => runConfigure(["--public-key", "pk"], {
      io: { stdin: { isTTY: false }, stdout: { isTTY: false } },
      path,
    }),
    /Usage: cursor-langfuse configure/
  );
});

test("parseConfigureArgs rejects unknown flags", () => {
  assert.throws(() => parseConfigureArgs(["--token", "x"]), /Unknown argument/);
});
