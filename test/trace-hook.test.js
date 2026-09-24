import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createTraceId } from "@langfuse/tracing";
import { routeHookHandler } from "../src/handlers.js";
import { calculateEditStats } from "../src/utils.js";
import {
  HOOK_HANDLER_VERSION,
  configureLangfuseTesting,
  flushLangfuse,
  getRecordedScoresForTests,
  shutdownLangfuse,
  traceHookEvent,
} from "../src/langfuse-client.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
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
    attachments: [{ type: "file", file_path: "/work/demo-workspace/hook.js" }],
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

  const traceId = await createTraceId(`${conversationId}:gen-1`);
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

  const generation = spans.find(
    (span) =>
      span.name === "respond" &&
      span.attributes["langfuse.observation.output"] === responseText
  );
  assert.ok(generation);
  assert.equal(generation.parentSpanContext?.spanId, rootSpanId);
  assert.equal(generation.attributes["langfuse.observation.type"], "generation");
  assert.equal(generation.attributes["langfuse.observation.input"], prompt);
  assert.equal(generation.attributes["langfuse.observation.model.name"], "gpt-test");
  assert.equal(generation.attributes["session.id"], "cursor-demo-workspace-conv-session-1");
  assert.equal(generation.attributes["user.id"], "dev@example.com");
  assert.equal(generation.attributes["langfuse.version"], "1.2.3");
  assert.equal(generation.attributes["langfuse.trace.name"], "cursor-agent");
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
  assert.deepEqual(
    JSON.parse(generation.attributes["langfuse.observation.metadata.attachments"]),
    [{ type: "file", path: "/work/demo-workspace/hook.js", extension: "js" }]
  );
  assert.equal(
    spans.find((span) => span.name === "User Prompt"),
    undefined
  );

  const shell = spans.find((span) => span.name === "execute-shell");
  assert.ok(shell);
  assert.equal(shell.parentSpanContext?.spanId, rootSpanId);
  assert.equal(shell.attributes["langfuse.observation.type"], "tool");
  assert.equal(shell.attributes["langfuse.observation.level"], "WARNING");
  assert.equal(shell.attributes["session.id"], "cursor-demo-workspace-conv-session-1");
  const shellMs =
    (shell.endTime[0] - shell.startTime[0]) * 1000 +
    (shell.endTime[1] - shell.startTime[1]) / 1e6;
  assert.ok(shellMs >= 12 && shellMs < 1000, `shell duration ${shellMs}ms`);

  const stopped = spans.find((span) => span.name === "stop-agent");
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
    ]
  );
});

test("each generation is its own trace in the same session", async () => {
  const conversationId = "conv-turns";
  const base = {
    conversation_id: conversationId,
    workspace_roots: ["/work/demo-workspace"],
    user_email: "dev@example.com",
    model: "gpt-test",
  };
  await runHook({
    ...base,
    generation_id: "turn-a",
    hook_event_name: "beforeSubmitPrompt",
    prompt: "first",
  });
  await runHook({
    ...base,
    generation_id: "turn-b",
    hook_event_name: "beforeSubmitPrompt",
    prompt: "second",
  });

  const first = await createTraceId(`${conversationId}:turn-a`);
  const second = await createTraceId(`${conversationId}:turn-b`);
  assert.notEqual(first, second);
  for (const traceId of [first, second]) {
    const root = finishedSpans().find(
      (span) =>
        span.spanContext().traceId === traceId &&
        span.spanContext().spanId === traceId.slice(0, 16)
    );
    assert.ok(root);
    assert.equal(root.attributes["session.id"], "cursor-demo-workspace-conv-turns");
    assert.equal(root.attributes["langfuse.trace.name"], "cursor-agent");
  }
});

test("response generations omit usage when the hook has no token fields", async () => {
  const conversationId = "conv-no-usage";
  await runHook({
    conversation_id: conversationId,
    generation_id: "gen-usage",
    hook_event_name: "afterAgentResponse",
    text: "done",
    model: "gpt-test",
  });
  const traceId = await createTraceId(`${conversationId}:gen-usage`);
  const generation = finishedSpans().find(
    (span) =>
      span.spanContext().traceId === traceId && span.name === "respond"
  );
  assert.ok(generation);
  assert.equal(generation.attributes["langfuse.observation.usage_details"], undefined);
});

test("edit stats count replacements and empty insertions", () => {
  assert.deepEqual(
    calculateEditStats([
      { old_string: "alpha", new_string: "beta" },
      { old_string: "", new_string: "inserted" },
    ]),
    { editCount: 2, linesAdded: 2, linesRemoved: 1, netChange: 1 }
  );
});

test("tool failure, context compaction, and subagent stop are scored observations", async () => {
  const conversationId = "conv-signals";
  const base = {
    conversation_id: conversationId,
    generation_id: "gen-signals",
    workspace_roots: ["/work/demo-workspace"],
    model_id: "claude-opus-4-7",
    model: "claude-opus-4-7-thinking-max",
  };

  await runHook({
    ...base,
    hook_event_name: "postToolUseFailure",
    tool_name: "Shell",
    tool_input: { command: "npm test" },
    tool_use_id: "tool-1",
    error_message: "Command timed out",
    failure_type: "timeout",
    duration: 5000,
    is_interrupt: false,
  });
  await runHook({
    ...base,
    hook_event_name: "preCompact",
    trigger: "auto",
    context_usage_percent: 85,
    context_tokens: 120000,
    context_window_size: 128000,
    message_count: 45,
    messages_to_compact: 30,
    is_first_compaction: true,
  });
  await runHook({
    ...base,
    hook_event_name: "subagentStart",
    subagent_id: "sub-1",
    subagent_type: "explore",
    task: "Find the auth flow",
    subagent_model: "claude-sonnet",
  });
  await runHook({
    ...base,
    hook_event_name: "subagentStop",
    subagent_type: "explore",
    task: "Find the auth flow",
    status: "completed",
    summary: "Auth starts in src/auth.ts",
    duration_ms: 45000,
    message_count: 12,
    tool_call_count: 8,
  });

  const traceId = await createTraceId(`${conversationId}:gen-signals`);
  const spans = finishedSpans().filter(
    (span) => span.spanContext().traceId === traceId
  );
  const shell = spans.find((span) => span.name === "execute-shell");
  assert.ok(shell);
  assert.equal(shell.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(shell.attributes["langfuse.observation.model.name"], undefined);
  const shellMs =
    (shell.endTime[0] - shell.startTime[0]) * 1000 +
    (shell.endTime[1] - shell.startTime[1]) / 1e6;
  assert.ok(shellMs >= 5000 && shellMs < 6000, `failure duration ${shellMs}ms`);

  const compact = spans.find((span) => span.name === "compact-context");
  assert.equal(compact.attributes["langfuse.observation.type"], "event");

  const subagent = spans.find(
    (span) =>
      span.name === "subagent-explore" &&
      span.attributes["langfuse.observation.output"] === "Auth starts in src/auth.ts"
  );
  assert.ok(subagent);
  assert.equal(subagent.attributes["langfuse.observation.type"], "agent");
  assert.equal(subagent.attributes["langfuse.observation.model.name"], "claude-sonnet");

  const scores = getRecordedScoresForTests().filter((score) => score.traceId === traceId);
  assert.deepEqual(
    scores.map((score) => ({ name: score.name, value: score.value })),
    [
      { name: "tool_failure", value: 1 },
      { name: "context_usage_percent", value: 85 },
    ]
  );
});

test("thinking duration is its own span and a subagent stop keeps the matching child", async () => {
  const conversationId = "conv-think-sub";
  const base = {
    conversation_id: conversationId,
    generation_id: "gen-think",
    workspace_roots: ["/work/demo-workspace"],
  };

  await runHook({
    ...base,
    hook_event_name: "afterAgentThought",
    text: "Check the auth module first",
    duration_ms: 2500,
  });
  await runHook({
    ...base,
    hook_event_name: "subagentStart",
    subagent_id: "sub-auth",
    subagent_type: "explore",
    task: "Find auth",
  });
  await runHook({
    ...base,
    hook_event_name: "subagentStart",
    subagent_id: "sub-billing",
    subagent_type: "explore",
    task: "Find billing",
  });
  await runHook({
    ...base,
    hook_event_name: "subagentStop",
    subagent_type: "explore",
    task: "unrelated task",
    summary: "should not attach",
    status: "completed",
    duration_ms: 1000,
  });
  await runHook({
    ...base,
    hook_event_name: "subagentStop",
    subagent_id: "sub-billing",
    subagent_type: "explore",
    task: "different wording",
    summary: "Billing lives in src/billing.ts",
    status: "completed",
    duration_ms: 8000,
  });

  const traceId = await createTraceId(`${conversationId}:gen-think`);
  const spans = finishedSpans().filter((span) => span.spanContext().traceId === traceId);

  const thinking = spans.find((span) => span.name === "think");
  assert.ok(thinking);
  assert.equal(thinking.attributes["langfuse.observation.output"], "Check the auth module first");
  const thinkingMs =
    (thinking.endTime[0] - thinking.startTime[0]) * 1000 +
    (thinking.endTime[1] - thinking.startTime[1]) / 1e6;
  assert.ok(thinkingMs >= 2500 && thinkingMs < 3500, `thinking duration ${thinkingMs}ms`);

  const billing = spans.find(
    (span) =>
      span.attributes["langfuse.observation.output"] === "Billing lives in src/billing.ts"
  );
  assert.equal(billing.attributes["langfuse.observation.metadata.subagent_id"], "sub-billing");

  const stolen = spans.find(
    (span) =>
      span.attributes["langfuse.observation.metadata.subagent_id"] === "sub-auth" &&
      span.attributes["langfuse.observation.output"] === "should not attach"
  );
  assert.equal(stolen, undefined);
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
  const files = ["bin/cursor-langfuse.js", "src/langfuse-client.js", "src/handlers.js"];
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
    const source = readFileSync(join(packageRoot, file), "utf8");
    for (const pattern of forbidden) {
      assert.equal(
        source.includes(pattern),
        false,
        `${file} still contains ${pattern}`
      );
    }
  }

  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8")
  );
  assert.equal(packageJson.dependencies.langfuse, undefined);
  assert.equal(packageJson.dependencies.dotenv, undefined);
  assert.equal(packageJson.bin["cursor-langfuse"], "./bin/cursor-langfuse.js");
  assert.match(packageJson.dependencies["@langfuse/tracing"], /^\^5\./);
  assert.equal(readdirSync(packageRoot).includes("package-lock.json"), true);
});
