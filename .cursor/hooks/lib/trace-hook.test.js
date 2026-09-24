import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createTraceId } from "@langfuse/tracing";
import { routeHookHandler } from "./handlers.js";
import {
  HOOK_HANDLER_VERSION,
  configureLangfuseTesting,
  flushLangfuse,
  getRecordedScoresForTests,
  shutdownLangfuse,
  traceHookEvent,
} from "./langfuse-client.js";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "cursor-langfuse-test-"));
process.env.CURSOR_LANGFUSE_STATE_DIR = stateDir;
delete process.env.LANGFUSE_TRACING_ENVIRONMENT;

const exporter = new InMemorySpanExporter();
configureLangfuseTesting({ exporter, captureScores: true });

after(async () => {
  await shutdownLangfuse();
});

function finishedSpans() {
  return exporter.getFinishedSpans();
}

async function runHook(input) {
  const response = await traceHookEvent(input, (trace, event) =>
    routeHookHandler(event.hook_event_name, trace, event)
  );
  await flushLangfuse();
  return response;
}

test("session observations carry root input/output and propagated session attributes", async () => {
  const conversationId = "conv-session-1";
  const prompt = "Fix the hook and keep the session on every child";
  const responseText = "Updated the Langfuse client";
  const base = {
    conversation_id: conversationId,
    workspace_roots: ["/work/demo-workspace"],
    user_email: "dev@example.com",
    model: "gpt-test",
    cursor_version: "1.2.3",
    generation_id: "gen-1",
  };

  const promptResponse = await runHook({
    ...base,
    hook_event_name: "beforeSubmitPrompt",
    prompt,
    attachments: [{ type: "file", filePath: "/work/demo-workspace/hook.js" }],
  });
  assert.deepEqual(promptResponse, { continue: true });

  const shellResponse = await runHook({
    ...base,
    hook_event_name: "afterShellExecution",
    command: "npm test",
    output: "error: failed",
    duration: 12,
  });
  assert.equal(shellResponse, null);

  await runHook({
    ...base,
    hook_event_name: "afterAgentResponse",
    text: responseText,
    input_tokens: 11,
    output_tokens: 7,
    cache_read_tokens: 3,
    cache_write_tokens: 2,
  });

  const stopResponse = await runHook({
    ...base,
    hook_event_name: "stop",
    status: "completed",
    loop_count: 2,
  });
  assert.deepEqual(stopResponse, {});

  const traceId = await createTraceId(conversationId);
  const rootSpanId = traceId.slice(0, 16);
  const spans = finishedSpans().filter(
    (span) => span.spanContext().traceId === traceId
  );
  assert.ok(spans.length >= 4, `expected several spans, got ${spans.length}`);

  const rootExports = spans.filter(
    (span) => span.spanContext().spanId === rootSpanId
  );
  assert.ok(rootExports.length >= 2);
  for (const root of rootExports) {
    assert.equal(root.parentSpanContext, undefined);
    assert.equal(root.attributes["langfuse.internal.is_app_root"], true);
    assert.equal(root.attributes["session.id"], "cursor-demo-workspace-conv-session-1");
    assert.equal(root.attributes["user.id"], "dev@example.com");
    assert.equal(root.attributes["langfuse.version"], "1.2.3");
    assert.equal(
      root.attributes["langfuse.release"],
      process.env.LANGFUSE_RELEASE || HOOK_HANDLER_VERSION
    );
    assert.equal(root.attributes["langfuse.trace.metadata.model"], "gpt-test");
    assert.notEqual(root.attributes["langfuse.trace.public"], true);
    assert.equal(root.attributes["langfuse.environment"], undefined);
  }

  const withBoth = rootExports.find(
    (span) =>
      span.attributes["langfuse.observation.input"] === prompt &&
      span.attributes["langfuse.observation.output"] === responseText
  );
  assert.ok(withBoth, "root observation should carry both input and output");
  assert.deepEqual(rootExports[0].startTime, withBoth.startTime);

  const generation = spans.find((span) => span.name === "Agent Response");
  assert.ok(generation);
  assert.equal(generation.parentSpanContext?.spanId, rootSpanId);
  assert.equal(generation.attributes["langfuse.observation.type"], "generation");
  assert.equal(generation.attributes["session.id"], "cursor-demo-workspace-conv-session-1");
  assert.equal(generation.attributes["user.id"], "dev@example.com");
  assert.equal(generation.attributes["langfuse.version"], "1.2.3");
  assert.notEqual(generation.attributes["langfuse.internal.is_app_root"], true);
  assert.deepEqual(
    JSON.parse(generation.attributes["langfuse.observation.usage_details"]),
    {
      input: 11,
      output: 7,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    }
  );

  const attachment = spans.find((span) => span.name === "Attachment: file");
  assert.ok(attachment);
  const userPrompt = spans.find((span) => span.name === "User Prompt");
  assert.ok(userPrompt);
  assert.equal(userPrompt.parentSpanContext?.spanId, rootSpanId);
  assert.equal(attachment.parentSpanContext?.spanId, userPrompt.spanContext().spanId);
  assert.equal(attachment.attributes["session.id"], "cursor-demo-workspace-conv-session-1");

  const shell = spans.find((span) => span.name.startsWith("Shell Result:"));
  assert.ok(shell);
  assert.equal(shell.parentSpanContext?.spanId, rootSpanId);
  assert.equal(shell.attributes["langfuse.observation.level"], "WARNING");
  assert.equal(shell.attributes["session.id"], "cursor-demo-workspace-conv-session-1");

  const stopped = spans.find((span) => span.name === "Agent Stopped");
  assert.ok(stopped);
  assert.equal(stopped.attributes["langfuse.observation.type"], "event");
  assert.ok(
    stopped.attributes["langfuse.trace.tags"].includes("status-completed")
  );
  assert.ok(stopped.attributes["langfuse.trace.tags"].includes("cursor"));
  assert.equal(stopped.attributes["session.id"], "cursor-demo-workspace-conv-session-1");

  const scores = getRecordedScoresForTests().filter(
    (score) => score.traceId === traceId
  );
  assert.deepEqual(
    scores.map((score) => ({
      name: score.name,
      value: score.value,
      dataType: score.dataType,
      observationId: score.observationId,
    })),
    [
      {
        name: "completion_status",
        value: 1,
        dataType: "NUMERIC",
        observationId: rootSpanId,
      },
      {
        name: "efficiency",
        value: 0.8,
        dataType: "NUMERIC",
        observationId: rootSpanId,
      },
    ]
  );
});

test("propagated attributes stay within the 200 character limit", async () => {
  const conversationId = "conv-truncate-1";
  const longVersion = "v".repeat(250);
  const longRoot = `/work/${"p".repeat(250)}`;

  await runHook({
    conversation_id: conversationId,
    hook_event_name: "beforeSubmitPrompt",
    prompt: "truncate me",
    workspace_roots: [longRoot],
    cursor_version: longVersion,
    model: "m".repeat(80),
    user_email: `${"u".repeat(210)}@example.com`,
  });

  const traceId = await createTraceId(conversationId);
  const root = finishedSpans().find(
    (span) =>
      span.spanContext().traceId === traceId &&
      span.spanContext().spanId === traceId.slice(0, 16)
  );
  assert.ok(root);
  assert.equal(root.attributes["langfuse.version"].length, 200);
  assert.equal(root.attributes["session.id"].length, 200);
  assert.equal(root.attributes["user.id"].length, 200);
  assert.equal(root.attributes["langfuse.trace.metadata.cursor_version"].length, 200);
  assert.equal(root.attributes["langfuse.trace.metadata.model"].length, 80);
});

test("hook sources do not call the legacy SDK or deprecated trace APIs", () => {
  const files = ["hook-handler.js", "lib/langfuse-client.js", "lib/handlers.js"];
  const forbidden = [
    'from "langfuse"',
    "from 'langfuse'",
    "updateActiveTrace",
    "setTraceIO",
    "setActiveTraceIO",
    "observationsV2",
    "/api/public/ingestion",
    "new Langfuse(",
  ];
  for (const file of files) {
    const source = readFileSync(join(hooksDir, "..", file), "utf8");
    for (const pattern of forbidden) {
      assert.equal(
        source.includes(pattern),
        false,
        `${file} still contains ${pattern}`
      );
    }
  }

  const packageJson = JSON.parse(
    readFileSync(join(hooksDir, "..", "package.json"), "utf8")
  );
  assert.equal(packageJson.dependencies.langfuse, undefined);
  assert.match(packageJson.dependencies["@langfuse/tracing"], /^\^5\./);
  assert.equal(
    readdirSync(join(hooksDir, "..")).includes("package-lock.json"),
    true
  );
});
