import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOOK_EVENT_NAMES } from "../src/handlers.js";
import { installUserHooks, runInit } from "../src/init.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cursor-langfuse-init-"));
  const command = join(dir, "cursor-langfuse.js");
  writeFileSync(command, "#!/usr/bin/env node\n");
  chmodSync(command, 0o755);
  return { command, hooksPath: join(dir, "hooks.json") };
}

function readHooks(hooksPath) {
  return JSON.parse(readFileSync(hooksPath, "utf8"));
}

test("init registers every supported hook and keeps other commands", async () => {
  const { command, hooksPath } = fixture();
  await writeFile(
    hooksPath,
    JSON.stringify({
      version: 1,
      extra: true,
      hooks: {
        beforeShellExecution: [{ command: "/usr/local/bin/other-hook", matcher: "rm" }],
        stop: [{ command: "cursor-langfuse", timeout: 10 }, { command: "cursor-langfuse" }],
      },
    })
  );

  const result = await runInit({ hooksPath, command });
  assert.equal(result.hooksPath, hooksPath);

  const stored = readHooks(hooksPath);
  assert.equal(stored.version, 1);
  assert.equal(stored.extra, true);
  assert.deepEqual(new Set(Object.keys(stored.hooks)), new Set(HOOK_EVENT_NAMES));

  assert.deepEqual(stored.hooks.beforeShellExecution, [
    { command: "/usr/local/bin/other-hook", matcher: "rm" },
    { command },
  ]);
  assert.deepEqual(stored.hooks.stop, [{ command, timeout: 10 }]);
  assert.deepEqual(stored.hooks.beforeSubmitPrompt, [{ command }]);
});

test("running init again does not duplicate hook commands", async () => {
  const { command, hooksPath } = fixture();
  await installUserHooks({ hooksPath, command });
  await installUserHooks({ hooksPath, command });

  const stored = readHooks(hooksPath);
  for (const event of HOOK_EVENT_NAMES) {
    assert.equal(stored.hooks[event].length, 1);
    assert.equal(stored.hooks[event][0].command, command);
  }
});

test("init refuses extra arguments and an unreadable hooks file", async () => {
  const { command, hooksPath } = fixture();
  await assert.rejects(() => runInit({ argv: ["--force"], hooksPath, command }), /Usage: cursor-langfuse init/);

  await writeFile(hooksPath, "{");
  await assert.rejects(() => runInit({ hooksPath, command }), /Could not read/);
});
