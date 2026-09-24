/**
 * Hook handlers. Each Cursor hook becomes one Langfuse observation.
 * Names stay stable so dashboards and evaluators can target them.
 * before/after pairs for the same tool call share a span key and update
 * one observation, with startTime set from the hook's duration.
 */

import {
  calculateEditStats,
  getFileExtension,
  determineLevel,
} from "./utils.js";
import { addCompletionScores } from "./langfuse-client.js";

const LEVEL_RANK = { DEFAULT: 0, WARNING: 1, ERROR: 2 };

const TOOL_SHAPES = {
  Shell: ["execute-shell", "tool", "shell"],
  Read: ["read-file", "retriever", "read"],
  Grep: ["grep", "retriever", "read"],
  Glob: ["glob", "retriever", "read"],
  Delete: ["delete-file", "tool", "edit"],
  Write: ["edit-file", "tool", "edit"],
  StrReplace: ["edit-file", "tool", "edit"],
  Edit: ["edit-file", "tool", "edit"],
  EditNotebook: ["edit-file", "tool", "edit"],
};

function defined(fields) {
  const clean = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { raw: value };
  } catch {
    return { raw: value };
  }
}

function filePathOf(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  return value.file_path || value.filePath || value.path || value.target_file;
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return attachments.map((attachment) => {
    const path = filePathOf(attachment);
    return defined({
      type: attachment.type,
      path,
      extension: path ? getFileExtension(path) : undefined,
    });
  });
}

function contentStats(content) {
  if (typeof content !== "string") return {};
  return {
    content_bytes: Buffer.byteLength(content),
    line_count: content === "" ? 0 : content.split("\n").length,
  };
}

function modelName(input) {
  return input.model_id || input.model;
}

function modelParameters(input) {
  if (!Array.isArray(input.model_params)) return undefined;
  const params = {};
  for (const item of input.model_params) {
    if (!item || item.id == null) continue;
    if (typeof item.value === "string" || typeof item.value === "number") {
      params[item.id] = item.value;
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function usageFrom(input) {
  const usage = {};
  if (typeof input.input_tokens === "number") usage.input = input.input_tokens;
  if (typeof input.output_tokens === "number") usage.output = input.output_tokens;
  if (typeof input.cache_read_tokens === "number") {
    usage.cache_read_input_tokens = input.cache_read_tokens;
  }
  if (typeof input.cache_write_tokens === "number") {
    usage.cache_creation_input_tokens = input.cache_write_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function slug(value, max = 40) {
  const text = String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max);
  return text || "unknown";
}

function mergeLevel(previous, next) {
  const left = previous || "DEFAULT";
  const right = next || "DEFAULT";
  return (LEVEL_RANK[right] || 0) >= (LEVEL_RANK[left] || 0) ? right : left;
}

function shellMightHaveFailed(output) {
  const text = String(output || "").toLowerCase();
  return text.includes("error") || text.includes("failed") || text.includes("not found");
}

function shellExitCode(toolOutput) {
  const parsed = asObject(toolOutput);
  if (typeof parsed.exitCode === "number") return parsed.exitCode;
  if (typeof parsed.exit_code === "number") return parsed.exit_code;
  return undefined;
}

function toolShape(toolName = "") {
  if (toolName === "Task") return null;
  if (toolName.startsWith("MCP:")) {
    return {
      name: `mcp-${slug(toolName.slice(4))}`,
      asType: "tool",
      kind: "mcp",
      mcpTool: toolName.slice(4),
    };
  }
  const known = TOOL_SHAPES[toolName];
  if (known) {
    return { name: known[0], asType: known[1], kind: known[2] };
  }
  return { name: slug(toolName), asType: "tool", kind: "other" };
}

function bareToolName(toolName = "") {
  return String(toolName).replace(/^MCP:/, "");
}

function toolKey(trace, input, kind) {
  const generationId = input.generation_id || "turn";
  if (kind === "shell") {
    const command = asObject(input.tool_input).command || input.command || "";
    return `shell:${generationId}:${command}`;
  }
  if (kind === "read" || kind === "edit") {
    const path = filePathOf(asObject(input.tool_input)) || input.file_path || "";
    return `${kind}:${generationId}:${path}`;
  }
  if (kind === "mcp") {
    const bare = bareToolName(input.tool_name);
    const prior = trace.state.mcpServers[bare] || trace.state.mcpServers[input.tool_name] || {};
    const server = input.mcp_server_name || prior.mcp_server_name || "";
    return `mcp:${generationId}:${server}:${bare}`;
  }
  if (input.tool_use_id) return `tool:${input.tool_use_id}`;
  return `tool:${generationId}:${input.tool_name || "tool"}`;
}

function upsertObservation(trace, key, spec) {
  const previous = trace.state.observations[key] || {};
  const level = mergeLevel(previous.level, spec.level);
  let startedAt = previous.startedAt;
  if (typeof spec.durationMs === "number" && spec.durationMs > 0) {
    startedAt = new Date(Date.now() - spec.durationMs).toISOString();
  }
  const next = {
    ...previous,
    name: spec.name || previous.name,
    asType: spec.asType || previous.asType || "span",
    input: spec.input !== undefined ? spec.input : previous.input,
    output: spec.output !== undefined ? spec.output : previous.output,
    model: spec.model || previous.model,
    modelParameters: spec.modelParameters || previous.modelParameters,
    usageDetails: spec.usageDetails || previous.usageDetails,
    level: level === "DEFAULT" ? undefined : level,
    metadata: { ...previous.metadata, ...spec.metadata },
    startedAt,
    failureScored: previous.failureScored === true,
  };
  if (spec.failureComment && !next.failureScored) {
    trace.score("tool_failure", 1, spec.failureComment);
    next.failureScored = true;
  }
  trace.state.observations[key] = next;
  trace
    .observation({
      name: next.name,
      asType: next.asType,
      spanKey: key,
      startTime: next.startedAt ? new Date(next.startedAt) : undefined,
      input: next.input,
      output: next.output,
      level: next.level,
      metadata: next.metadata,
      model: next.model,
      modelParameters: next.modelParameters,
      usageDetails: next.usageDetails,
    })
    .end();
}

function upsertGeneration(trace, input, patch) {
  const generationId = input.generation_id || "turn";
  upsertObservation(trace, `generation:${generationId}`, {
    name: "respond",
    asType: "generation",
    input: patch.input,
    output: patch.output,
    model: patch.model,
    modelParameters: patch.modelParameters,
    usageDetails: patch.usageDetails,
    metadata: defined({
      generation_id: input.generation_id,
      thinking: patch.thinking,
      thinking_duration_ms: patch.thinkingDurationMs,
      attachments: patch.attachments,
      response_length: patch.responseLength,
      line_count: patch.lineCount,
    }),
  });
}

export function handleBeforeSubmitPrompt(trace, input) {
  trace.update({ input: input.prompt });
  const attachments = normalizeAttachments(input.attachments);
  if (attachments) trace.state.attachments = attachments;
  return { continue: true };
}

export function handleAfterAgentResponse(trace, input) {
  const text = input.text || "";
  trace.update({ output: text });
  upsertGeneration(trace, input, {
    input: trace.state.input,
    output: text,
    model: modelName(input),
    modelParameters: modelParameters(input),
    usageDetails: usageFrom(input),
    attachments: trace.state.attachments,
    responseLength: text.length,
    lineCount: text ? text.split("\n").length : 0,
  });
  return null;
}

export function handleAfterAgentThought(trace, input) {
  upsertGeneration(trace, input, {
    input: trace.state.input,
    model: modelName(input),
    modelParameters: modelParameters(input),
    thinking: input.text,
    thinkingDurationMs: input.duration_ms,
    attachments: trace.state.attachments,
  });
  if (typeof input.duration_ms === "number" && input.duration_ms > 0) {
    const generationId = input.generation_id || "turn";
    const prefix = `think:${generationId}:`;
    const index =
      Object.keys(trace.state.observations).filter((key) => key.startsWith(prefix)).length + 1;
    upsertObservation(trace, `${prefix}${index}`, {
      name: "think",
      asType: "span",
      durationMs: input.duration_ms,
      output: input.text,
      metadata: defined({
        generation_id: input.generation_id,
        thinking_length: input.text?.length || 0,
      }),
    });
  }
  return null;
}

export function handleBeforeShellExecution(trace, input) {
  if (input.command) {
    trace.state.sandboxByCommand[input.command] = defined({
      sandbox: input.sandbox,
      cwd: input.cwd,
    });
  }
  return { permission: "allow" };
}

export function handleAfterShellExecution(trace, input) {
  const prior = trace.state.sandboxByCommand[input.command] || {};
  const failed = shellMightHaveFailed(input.output);
  upsertObservation(trace, toolKey(trace, input, "shell"), {
    name: "execute-shell",
    asType: "tool",
    durationMs: input.duration,
    input: defined({ command: input.command, cwd: prior.cwd || input.cwd }),
    output: input.output,
    level: failed ? "WARNING" : undefined,
    metadata: defined({
      generation_id: input.generation_id,
      duration_ms: input.duration,
      sandbox: input.sandbox ?? prior.sandbox,
      output_length: input.output?.length || 0,
      might_have_failed: failed || undefined,
    }),
  });
  return null;
}

export function handleBeforeMCPExecution(trace, input) {
  if (input.tool_name) {
    trace.state.mcpServers[input.tool_name] = defined({
      mcp_server_name: input.mcp_server_name,
      url: input.url || input.mcp_server_url,
    });
  }
  return { permission: "allow" };
}

export function handleAfterMCPExecution(trace, input) {
  const bare = bareToolName(input.tool_name);
  const prior = trace.state.mcpServers[bare] || trace.state.mcpServers[input.tool_name] || {};
  const shape = toolShape(`MCP:${bare || "tool"}`);
  upsertObservation(trace, toolKey(trace, input, "mcp"), {
    name: shape.name,
    asType: "tool",
    durationMs: input.duration,
    input: defined({
      tool_name: input.tool_name,
      tool_input: input.tool_input,
    }),
    output: input.result_json,
    metadata: defined({
      generation_id: input.generation_id,
      duration_ms: input.duration,
      mcp_server_name: input.mcp_server_name || prior.mcp_server_name,
      mcp_server_url: input.mcp_server_url || prior.url,
    }),
  });
  return null;
}

export function handleBeforeReadFile(trace, input) {
  const path = input.file_path;
  upsertObservation(trace, toolKey(trace, { ...input, file_path: path }, "read"), {
    name: "read-file",
    asType: "retriever",
    input: defined({
      file_path: path,
      extension: getFileExtension(path),
    }),
    metadata: defined({
      generation_id: input.generation_id,
      file_extension: getFileExtension(path),
      ...contentStats(input.content),
      attachments: normalizeAttachments(input.attachments),
    }),
  });
  return { permission: "allow" };
}

export function handleAfterFileEdit(trace, input) {
  const path = input.file_path;
  const editStats = calculateEditStats(input.edits);
  upsertObservation(trace, toolKey(trace, { ...input, file_path: path }, "edit"), {
    name: "edit-file",
    asType: "tool",
    input: defined({
      file_path: path,
      extension: getFileExtension(path),
    }),
    output: {
      edit_count: editStats.editCount,
      lines_added: editStats.linesAdded,
      lines_removed: editStats.linesRemoved,
      net_change: editStats.netChange,
      edits: input.edits,
    },
    metadata: defined({
      generation_id: input.generation_id,
      file_extension: getFileExtension(path),
      ...editStats,
    }),
  });
  return null;
}

export function handleStop(trace, input) {
  const level = determineLevel(input.status);
  trace.event({
    name: "stop-agent",
    level,
    metadata: defined({
      status: input.status,
      loop_count: input.loop_count,
      generation_id: input.generation_id,
    }),
  });
  addCompletionScores(trace, input);
  return {};
}

export function handleBeforeTabFileRead(trace, input) {
  const path = input.file_path;
  upsertObservation(trace, `tab-read:${input.generation_id || "turn"}:${path || ""}`, {
    name: "tab-read-file",
    asType: "retriever",
    input: defined({ file_path: path, extension: getFileExtension(path) }),
    metadata: defined({
      generation_id: input.generation_id,
      file_extension: getFileExtension(path),
      source: "tab",
      ...contentStats(input.content),
    }),
  });
  return { permission: "allow" };
}

export function handleAfterTabFileEdit(trace, input) {
  const path = input.file_path;
  const editStats = calculateEditStats(input.edits);
  upsertObservation(trace, `tab-edit:${input.generation_id || "turn"}:${path || ""}`, {
    name: "tab-edit-file",
    asType: "tool",
    input: defined({ file_path: path, extension: getFileExtension(path) }),
    output: {
      edit_count: editStats.editCount,
      lines_added: editStats.linesAdded,
      lines_removed: editStats.linesRemoved,
      edits: input.edits,
    },
    metadata: defined({
      generation_id: input.generation_id,
      file_extension: getFileExtension(path),
      source: "tab",
      ...editStats,
    }),
  });
  return null;
}

function recordGenericTool(trace, input, { failed = false } = {}) {
  const shape = toolShape(input.tool_name);
  if (!shape) return null;
  const toolInput = asObject(input.tool_input);
  const exitCode = shape.kind === "shell" ? shellExitCode(input.tool_output) : undefined;
  const priorShell = trace.state.sandboxByCommand[toolInput.command || ""] || {};
  const priorMcp =
    trace.state.mcpServers[shape.mcpTool || bareToolName(input.tool_name)] ||
    trace.state.mcpServers[input.tool_name] ||
    {};
  const level = failed
    ? input.is_interrupt
      ? "WARNING"
      : "ERROR"
    : typeof exitCode === "number" && exitCode !== 0
      ? "ERROR"
      : undefined;
  const failureComment = failed
    ? [input.failure_type, input.tool_name, input.error_message].filter(Boolean).join(": ")
    : typeof exitCode === "number" && exitCode !== 0
      ? `exit ${exitCode}: ${input.tool_name || "shell"}`
      : undefined;
  upsertObservation(trace, toolKey(trace, input, shape.kind), {
    name: shape.name,
    asType: shape.asType,
    durationMs: input.duration,
    input: defined({
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      cwd: input.cwd || priorShell.cwd,
    }),
    output: failed ? input.error_message : input.tool_output,
    level,
    failureComment: input.is_interrupt ? undefined : failureComment,
    metadata: defined({
      generation_id: input.generation_id,
      tool_use_id: input.tool_use_id,
      duration_ms: input.duration,
      cwd: input.cwd,
      exit_code: exitCode,
      sandbox: priorShell.sandbox,
      mcp_server_name: priorMcp.mcp_server_name,
      failure_type: input.failure_type,
      is_interrupt: input.is_interrupt,
    }),
  });
  return null;
}

export function handlePostToolUse(trace, input) {
  return recordGenericTool(trace, input);
}

export function handlePostToolUseFailure(trace, input) {
  return recordGenericTool(trace, input, { failed: true });
}

function subagentName(type) {
  return `subagent-${slug(type)}`;
}

export function handleSubagentStart(trace, input) {
  const id = input.subagent_id || `${input.subagent_type}:${input.task}`;
  trace.state.pendingSubagents[id] = {
    subagent_type: input.subagent_type,
    task: input.task,
    subagent_model: input.subagent_model,
    parent_conversation_id: input.parent_conversation_id,
    tool_call_id: input.tool_call_id,
    is_parallel_worker: input.is_parallel_worker,
    git_branch: input.git_branch,
  };
  upsertObservation(trace, `subagent:${id}`, {
    name: subagentName(input.subagent_type),
    asType: "agent",
    input: defined({ task: input.task, description: input.description }),
    model: input.subagent_model,
    metadata: defined({
      generation_id: input.generation_id,
      subagent_id: input.subagent_id,
      subagent_type: input.subagent_type,
      parent_conversation_id: input.parent_conversation_id,
      tool_call_id: input.tool_call_id,
      is_parallel_worker: input.is_parallel_worker,
      git_branch: input.git_branch,
    }),
  });
  return { permission: "allow" };
}

function takePendingSubagent(pending, input) {
  if (input.subagent_id && pending[input.subagent_id]) {
    const start = pending[input.subagent_id];
    delete pending[input.subagent_id];
    return { id: input.subagent_id, start };
  }
  const exact = Object.entries(pending).filter(
    ([, value]) => value.subagent_type === input.subagent_type && value.task === input.task
  );
  if (exact.length > 0) {
    const [id, start] = exact[0];
    delete pending[id];
    return { id, start };
  }
  return {
    id: input.subagent_id || `${input.subagent_type || "subagent"}:${input.task || "task"}`,
    start: {},
  };
}

export function handleSubagentStop(trace, input) {
  const pending = trace.state.pendingSubagents || {};
  const { id, start } = takePendingSubagent(pending, input);
  upsertObservation(trace, `subagent:${id}`, {
    name: subagentName(input.subagent_type),
    asType: "agent",
    durationMs: input.duration_ms,
    input: defined({ task: input.task || start.task, description: input.description }),
    output: input.summary,
    model: start.subagent_model,
    level: input.status && input.status !== "completed" ? determineLevel(input.status) : undefined,
    metadata: defined({
      generation_id: input.generation_id,
      subagent_id: id,
      subagent_type: input.subagent_type,
      status: input.status,
      duration_ms: input.duration_ms,
      message_count: input.message_count,
      tool_call_count: input.tool_call_count,
      loop_count: input.loop_count,
      modified_files: input.modified_files,
      parent_conversation_id: start.parent_conversation_id,
      git_branch: start.git_branch,
    }),
  });
  return null;
}

export function handlePreCompact(trace, input) {
  trace.event({
    name: "compact-context",
    metadata: defined({
      generation_id: input.generation_id,
      trigger: input.trigger,
      context_usage_percent: input.context_usage_percent,
      context_tokens: input.context_tokens,
      context_window_size: input.context_window_size,
      message_count: input.message_count,
      messages_to_compact: input.messages_to_compact,
      is_first_compaction: input.is_first_compaction,
    }),
  });
  if (typeof input.context_usage_percent === "number") {
    const comment =
      typeof input.context_tokens === "number" && typeof input.context_window_size === "number"
        ? `${input.context_tokens}/${input.context_window_size} tokens`
        : undefined;
    trace.score("context_usage_percent", input.context_usage_percent, comment);
  }
  return null;
}

export function handleSessionStart(trace, input) {
  trace.event({
    name: "start-session",
    metadata: defined({
      session_id: input.session_id,
      composer_mode: input.composer_mode,
      is_background_agent: input.is_background_agent,
    }),
  });
  return null;
}

export function handleSessionEnd(trace, input) {
  const reason = input.reason || input.final_status;
  upsertObservation(trace, `session-end:${input.session_id || input.conversation_id || "session"}`, {
    name: "end-session",
    asType: "span",
    durationMs: input.duration_ms,
    output: reason,
    level: reason === "error" ? "ERROR" : reason && reason !== "completed" ? "WARNING" : undefined,
    metadata: defined({
      session_id: input.session_id,
      reason: input.reason,
      final_status: input.final_status,
      duration_ms: input.duration_ms,
      is_background_agent: input.is_background_agent,
      error_message: input.error_message,
    }),
  });
  const score = reason === "completed" ? 1 : reason === "error" ? 0 : 0.5;
  trace.score("session_end", score, reason);
  return null;
}

const handlers = {
  sessionStart: handleSessionStart,
  sessionEnd: handleSessionEnd,
  beforeSubmitPrompt: handleBeforeSubmitPrompt,
  afterAgentResponse: handleAfterAgentResponse,
  afterAgentThought: handleAfterAgentThought,
  beforeShellExecution: handleBeforeShellExecution,
  afterShellExecution: handleAfterShellExecution,
  beforeMCPExecution: handleBeforeMCPExecution,
  afterMCPExecution: handleAfterMCPExecution,
  beforeReadFile: handleBeforeReadFile,
  afterFileEdit: handleAfterFileEdit,
  postToolUse: handlePostToolUse,
  postToolUseFailure: handlePostToolUseFailure,
  subagentStart: handleSubagentStart,
  subagentStop: handleSubagentStop,
  preCompact: handlePreCompact,
  stop: handleStop,
  beforeTabFileRead: handleBeforeTabFileRead,
  afterTabFileEdit: handleAfterTabFileEdit,
};

export const HOOK_EVENT_NAMES = Object.keys(handlers);

export function routeHookHandler(hookName, trace, input) {
  const handler = handlers[hookName];
  if (!handler) {
    console.error(`Unknown hook type: ${hookName}`);
    return null;
  }
  return handler(trace, input);
}
