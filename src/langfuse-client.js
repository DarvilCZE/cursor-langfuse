/**
 * Langfuse client for Cursor hooks.
 *
 * Uses the JS/TS SDK v5 observations model. Each hook invocation is a
 * separate short-lived process, so a conversation shares a deterministic
 * trace id and root span id. propagateAttributes runs before any observation
 * is created, so the root and every child (including cost-bearing generations)
 * receive the session id and the other correlating attributes.
 *
 * Overall input and output live on that root observation. Later processes
 * reload the latest input and output from a local state file so a response
 * event does not replace the prompt captured by an earlier event.
 *
 * Flush waits until the OpenTelemetry exporter and the score queue finish
 * their current send. This does not reproduce the legacy ingestion client's
 * retry policy.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";
import {
  createTraceId,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import { generateSessionId, generateTags, generateTraceName } from "./utils.js";

config({ path: resolve(process.cwd(), ".env") });

export const HOOK_HANDLER_VERSION = "1.2.0";

const PROPAGATED_VALUE_LIMIT = 200;

let sdk = null;
let spanProcessor = null;
let langfuseClient = null;
let tracingStarted = false;
let activeTraceId = "0123456789abcdef0123456789abcdef";
let issueRootSpanId = false;

let testing = {
  exporter: null,
  captureScores: false,
  scores: [],
};

export function configureLangfuseTesting({ exporter, captureScores = false } = {}) {
  if (tracingStarted) {
    throw new Error("Langfuse tracing is already started");
  }
  testing = {
    exporter: exporter ?? null,
    captureScores,
    scores: [],
  };
  return testing.scores;
}

export function getRecordedScoresForTests() {
  return testing.scores;
}

function truncatePropagated(value) {
  if (value == null || value === "") return undefined;
  const text = String(value);
  return text.length > PROPAGATED_VALUE_LIMIT
    ? text.slice(0, PROPAGATED_VALUE_LIMIT)
    : text;
}

function randomSpanId() {
  let spanId = "";
  do {
    spanId = randomBytes(8).toString("hex");
  } while (spanId === "0000000000000000");
  return spanId;
}

function rootSpanIdForTrace(traceId) {
  const first = traceId.slice(0, 16);
  if (first !== "0000000000000000") return first;
  return traceId.slice(16, 32);
}

function stateDirectory() {
  return (
    process.env.CURSOR_LANGFUSE_STATE_DIR ||
    join(tmpdir(), "cursor-langfuse-hooks")
  );
}

function baseUrl() {
  return process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
}

function ensureTracing() {
  if (tracingStarted) return;

  spanProcessor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: baseUrl(),
    release: process.env.LANGFUSE_RELEASE || HOOK_HANDLER_VERSION,
    exportMode: "immediate",
    // Hook payloads are text and file paths, so skip media uploads in this short-lived process.
    mediaUploadEnabled: false,
    ...(testing.exporter ? { exporter: testing.exporter } : {}),
  });

  sdk = new NodeSDK({
    instrumentations: [],
    idGenerator: {
      generateTraceId() {
        return activeTraceId;
      },
      generateSpanId() {
        if (issueRootSpanId) {
          issueRootSpanId = false;
          return rootSpanIdForTrace(activeTraceId);
        }
        return randomSpanId();
      },
    },
    spanProcessors: [spanProcessor],
  });
  sdk.start();
  tracingStarted = true;
}

function getLangfuseClient() {
  if (!langfuseClient) {
    langfuseClient = new LangfuseClient({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: baseUrl(),
    });
  }
  return langfuseClient;
}

function recordScore(score) {
  if (testing.captureScores) {
    testing.scores.push(score);
    return;
  }
  getLangfuseClient().score.create(score);
}

function resolveTraceName(input) {
  if (input.hook_event_name === "beforeSubmitPrompt" && input.prompt) {
    return String(input.prompt).substring(0, 100);
  }
  return (
    generateTraceName(input.prompt, input.model) ||
    `${input.hook_event_name || "Cursor"} - ${input.model || "Agent"}`
  );
}

function propagatedMetadata(input) {
  const metadata = {};
  const cursorVersion = truncatePropagated(input.cursor_version);
  const model = truncatePropagated(input.model);
  const generationId = truncatePropagated(input.generation_id);
  if (cursorVersion) metadata.cursor_version = cursorVersion;
  if (model) metadata.model = model;
  if (generationId) metadata.generation_id = generationId;
  if (Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const roots = truncatePropagated(input.workspace_roots.join(","));
    if (roots) metadata.workspace_roots = roots;
  }
  return metadata;
}

function propagationTags(input) {
  const tags = generateTags(input.hook_event_name || "", input)
    .map((tag) => truncatePropagated(tag))
    .filter(Boolean);
  if (input.hook_event_name === "stop" && input.status) {
    const statusTag = truncatePropagated(`status-${input.status}`);
    if (statusTag && !tags.includes(statusTag)) tags.push(statusTag);
  }
  return tags;
}

async function withStateLock(traceId, fn) {
  const directory = stateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, `${traceId}.lock`);
  const deadline = Date.now() + 2000;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        return await fn(directory);
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }

  return fn(directory);
}

async function readRootState(directory, traceId) {
  try {
    const raw = await readFile(join(directory, `${traceId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    return {};
  }
}

async function writeRootState(directory, traceId, state) {
  const payload = { startedAt: state.startedAt };
  if (state.input !== undefined) payload.input = state.input;
  if (state.output !== undefined) payload.output = state.output;
  const target = join(directory, `${traceId}.json`);
  const temporary = join(directory, `${traceId}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(payload), { mode: 0o600 });
  await rename(temporary, target);
}

function createFacade(root, io, openObservations) {
  const track = (observation) => {
    openObservations.push(observation);
    return observation;
  };

  return {
    traceId: root.traceId,
    observationId: root.id,
    update(fields = {}) {
      if (fields.name) {
        const name = String(fields.name);
        root.otelSpan.updateName(name);
        const propagatedName = truncatePropagated(name);
        if (propagatedName) {
          root.otelSpan.setAttribute("langfuse.trace.name", propagatedName);
        }
      }
      const patch = {};
      if (fields.input !== undefined) {
        io.input = fields.input;
        patch.input = fields.input;
      }
      if (fields.output !== undefined) {
        io.output = fields.output;
        patch.output = fields.output;
      }
      if (Object.keys(patch).length > 0) root.update(patch);
    },
    generation(fields) {
      const { name, ...attributes } = fields;
      const generation = track(
        root.startObservation(name, attributes, { asType: "generation" })
      );
      return {
        span(childFields) {
          const { name: childName, ...childAttributes } = childFields;
          const child = track(
            generation.startObservation(childName, childAttributes, {
              asType: "span",
            })
          );
          return {
            end() {
              child.end();
            },
          };
        },
        end() {
          generation.end();
        },
      };
    },
    span(fields) {
      const { name, ...attributes } = fields;
      const span = track(
        root.startObservation(name, attributes, { asType: "span" })
      );
      return {
        end() {
          span.end();
        },
      };
    },
    event(fields) {
      const { name, ...attributes } = fields;
      track(root.startObservation(name, attributes, { asType: "event" }));
    },
    score(name, value, comment = undefined, dataType = "NUMERIC") {
      recordScore({
        traceId: root.traceId,
        observationId: root.id,
        name,
        value,
        ...(comment != null ? { comment } : {}),
        dataType,
      });
    },
  };
}

export function addCompletionScores(trace, input) {
  let statusScore = 0;
  let statusComment = "";

  switch (input.status) {
    case "completed":
      statusScore = 1;
      statusComment = "Agent completed successfully";
      break;
    case "aborted":
      statusScore = 0.5;
      statusComment = "Agent was aborted by user";
      break;
    case "error":
      statusScore = 0;
      statusComment = "Agent encountered an error";
      break;
    default:
      statusScore = 0.5;
      statusComment = `Unknown status: ${input.status}`;
  }

  trace.score("completion_status", statusScore, statusComment);

  if (typeof input.loop_count === "number") {
    const efficiencyScore = Math.max(0, 1 - input.loop_count / 10);
    trace.score(
      "efficiency",
      efficiencyScore,
      `Completed in ${input.loop_count} loops`
    );
  }
}

export async function traceHookEvent(input, handleEvent) {
  ensureTracing();

  const traceId = input.conversation_id
    ? await createTraceId(String(input.conversation_id))
    : await createTraceId();
  activeTraceId = traceId;

  return withStateLock(traceId, async (directory) => {
    const stored = await readRootState(directory, traceId);
    const startedAt = stored.startedAt ? new Date(stored.startedAt) : new Date();
    const io = {
      input: stored.input,
      output: stored.output,
    };
    const traceName = truncatePropagated(resolveTraceName(input)) || "Cursor";
    const sessionId = truncatePropagated(
      generateSessionId(input.workspace_roots, input.conversation_id)
    );
    const userId = truncatePropagated(input.user_email);
    const version = truncatePropagated(input.cursor_version);
    const metadata = propagatedMetadata(input);
    const tags = propagationTags(input);
    const openObservations = [];

    issueRootSpanId = true;
    try {
      return await propagateAttributes(
        {
          traceName,
          ...(sessionId ? { sessionId } : {}),
          ...(userId ? { userId } : {}),
          ...(version ? { version } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        },
        async () =>
          startActiveObservation(
            traceName,
            async (root) => {
              const restored = {};
              if (io.input !== undefined) restored.input = io.input;
              if (io.output !== undefined) restored.output = io.output;
              if (Object.keys(restored).length > 0) root.update(restored);

              const facade = createFacade(root, io, openObservations);
              try {
                return handleEvent ? handleEvent(facade, input) : null;
              } finally {
                for (const observation of openObservations) {
                  observation.end();
                }
                await writeRootState(directory, traceId, {
                  input: io.input,
                  output: io.output,
                  startedAt: startedAt.toISOString(),
                });
              }
            },
            { startTime: startedAt }
          )
      );
    } finally {
      issueRootSpanId = false;
    }
  });
}

export async function flushLangfuse() {
  if (spanProcessor) await spanProcessor.forceFlush();
  if (langfuseClient && !testing.captureScores) await langfuseClient.flush();
}

export async function shutdownLangfuse() {
  await flushLangfuse();
  if (langfuseClient && !testing.captureScores) {
    await langfuseClient.shutdown();
    langfuseClient = null;
  }
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    spanProcessor = null;
    tracingStarted = false;
  }
}
