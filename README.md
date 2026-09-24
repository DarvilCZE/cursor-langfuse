# Cursor Langfuse

A CLI that records Cursor hook events as Langfuse traces.

## Overview

Install `cursor-langfuse`, then point the hooks you care about at that command. Each prompt, response, file edit, shell command, and MCP tool call you wire up is captured and sent to Langfuse.

## Features

- **Hook coverage**: Agent, Tab, session, tool, subagent, and context-compaction hooks
- **One trace per turn**: A user message and the tool calls that follow it share a trace. The conversation is the Langfuse session
- **Typed observations**: Model output is a `generation`, shell and edits are `tool`s, file reads are `retriever`s, and subagents are `agent`s
- **Scores**: Completion status, tool failures, context-window usage, and how the session ended
- **Durations**: Thinking, shell, MCP, tool, subagent, and session spans use the hook's duration as their start and end
- **Stable names**: Observation names stay fixed (`respond`, `execute-shell`, `edit-file`) so dashboards and evaluators keep matching
- **Non-blocking**: Errors are logged but don't interrupt Cursor operations

## Supported Hooks

| Hook                   | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `sessionStart`         | Records composer mode and background vs interactive      |
| `sessionEnd`           | Records why the session ended and how long it ran       |
| `beforeSubmitPrompt`   | Stores the user prompt and attachment paths             |
| `afterAgentResponse`   | Records the assistant message as a generation           |
| `afterAgentThought`    | Attaches thinking text to the generation, and a `think` span with its duration |
| `beforeShellExecution` | Allows the command and remembers sandbox state          |
| `afterShellExecution`  | Records the shell command, output, and duration         |
| `beforeMCPExecution`   | Allows the call and remembers the MCP server            |
| `afterMCPExecution`    | Records the MCP tool result and duration                |
| `beforeReadFile`       | Records the file path and size, not the file body       |
| `afterFileEdit`        | Records the edit and line statistics                    |
| `postToolUse`          | Records tools that do not have a dedicated hook         |
| `postToolUseFailure`   | Records tool failures and scores `tool_failure`         |
| `subagentStart`        | Opens a subagent observation                            |
| `subagentStop`         | Closes that subagent with its summary and duration      |
| `preCompact`           | Records context-window usage before compaction          |
| `stop`                 | Scores whether the turn completed, aborted, or errored  |
| `beforeTabFileRead`    | Tab file reads                                          |
| `afterTabFileEdit`     | Tab file edits                                          |

## Installation

Install the CLI globally:

```bash
npm install -g github:DarvilCZE/cursor-langfuse
```

After the package is published, `npm install -g cursor-langfuse` is the same install.

Save your Langfuse keys once. This writes `~/.config/cursor-langfuse/config.json` with permissions limited to your user:

```bash
cursor-langfuse configure --secret-key sk-lf-... --public-key pk-lf-...
```

Omit the flags to be prompted. Add `--base-url https://your-host` for a self-hosted Langfuse. Pressing Enter for the base URL uses `https://cloud.langfuse.com`.

Register the CLI once in your user hooks:

```bash
cursor-langfuse init
```

`init` writes `~/.cursor/hooks.json` and points each supported event at this install of the CLI. That file is user-level configuration, so Cursor applies the same hooks in every project you open. Hooks you already configured are left in place. Running it again adds any supported events that are missing and updates the existing `cursor-langfuse` command instead of adding a second one. The event list is the same as [`examples/hooks.json`](examples/hooks.json).

The CLI reads the hook payload from stdin and prints the hook response on stdout. It fails open: errors are logged to stderr and Cursor is allowed to continue.

## Configuration

Credentials live in `~/.config/cursor-langfuse/config.json`:

```json
{
  "secretKey": "sk-lf-...",
  "publicKey": "pk-lf-...",
  "baseUrl": "https://cloud.langfuse.com"
}
```

`baseUrl` is optional. Set `XDG_CONFIG_HOME` to move the config root, or `CURSOR_LANGFUSE_CONFIG` to point at a different file. Environment variables override the file when they are already set.

One config file sends every workspace to the same Langfuse project. Sessions stay separate because each one includes the workspace name and the conversation id.

### Environment Variables

| Variable              | Required | Description                                                 |
| --------------------- | -------- | ----------------------------------------------------------- |
| `LANGFUSE_SECRET_KEY`           | No       | Overrides `secretKey` from the config file                  |
| `LANGFUSE_PUBLIC_KEY`           | No       | Overrides `publicKey` from the config file                  |
| `LANGFUSE_BASE_URL`             | No       | Overrides `baseUrl` from the config file                    |
| `LANGFUSE_RELEASE`              | No       | Release stamped on observations (defaults to the hook handler version) |
| `LANGFUSE_TRACING_ENVIRONMENT`  | No       | Langfuse environment, when you want one                     |
| `CURSOR_LANGFUSE_STATE_DIR`     | No       | Directory for the local root input/output cache             |
| `CURSOR_LANGFUSE_CONFIG`        | No       | Path to the credentials file (defaults to `~/.config/cursor-langfuse/config.json`) |

## How It Works

1. Cursor triggers a hook event and passes JSON data via stdin to `cursor-langfuse`
2. The CLI loads credentials from the user config file, then reads and parses the input
3. `conversation_id` and `generation_id` are hashed into a deterministic Langfuse trace id, so each user turn is its own trace. The session id stays on the conversation
4. Session, user, version, tags, and metadata are propagated before any observation is created, so they are present on the root and on every child, including generations that carry token usage
5. The appropriate handler records spans, generations, and events under that root. Overall prompt and response text are stored on the root observation
6. Scores are attached to the root observation
7. The process flushes the OpenTelemetry exporter and the score queue, then shuts them down before exiting

The handler uses the Langfuse JS SDK v5 (`@langfuse/tracing`, `@langfuse/otel`, and `@langfuse/client`) and exports traces with OTLP to `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces`. That path requires Langfuse Cloud or a self-hosted Langfuse v4 server.

### Trace Structure

- **Trace**: One per user turn. The trace id is a deterministic hash of `conversation_id` and `generation_id`. The trace name is `cursor-agent` or `cursor-tab`
- **Root observation**: Holds that turn's prompt and assistant text. Later hook processes in the same turn reuse the same root span id
- **Session**: One Cursor conversation, named from the workspace folder and `conversation_id`
- **Generation** `respond`: The assistant message. Thinking text is metadata on this generation, and a `think` span carries the thinking duration. Token usage is sent only when the hook payload includes it. The model is `model_id` when Cursor sends one
- **Tool / retriever**: `execute-shell`, `edit-file`, `read-file`, MCP tools, and other tool calls. Duration comes from the hook, so the waterfall shows how long the call took
- **Agent**: One observation per subagent, updated when the subagent finishes
- **Events**: `stop-agent`, `compact-context`, `start-session`
- **Scores**: `completion_status` (0–1), `tool_failure`, `context_usage_percent`, and `session_end`, attached to the root observation

Between hook processes, the latest root input and output are stored under `$TMPDIR/cursor-langfuse-hooks` (override with `CURSOR_LANGFUSE_STATE_DIR`) so a later event can keep both on the root observation. Those files are written with user-only permissions.

### Automatic Tagging

Traces are automatically tagged based on activity:

- `cursor` — all traces
- `agent` or `tab` — based on hook source
- `shell`, `mcp`, `file-ops`, `tool`, `subagent`, `thinking`, `compact`, `session` — activity on that turn
- `agent`, `ask`, or `edit`, plus `background` or `interactive`, when a session hook reports them
- Model name (for example `claude-opus-4-7`)
- `status-completed`, `status-aborted`, `status-error`

## Project Structure

```
bin/cursor-langfuse.js    # CLI entry point
src/
  langfuse-client.js      # Langfuse SDK wrapper
  handlers.js             # Hook-specific handlers
  utils.js                # Utility functions
examples/hooks.json       # Events that `cursor-langfuse init` registers
```

## Viewing Traces

1. Log in to your Langfuse dashboard
2. Navigate to Traces
3. Filter by session (workspace name and conversation id) or tags
4. Click on a trace to see the full conversation with all spans

## Troubleshooting

### Traces not appearing in Langfuse

- Run `cursor-langfuse configure` and confirm `~/.config/cursor-langfuse/config.json` exists
- Check that the file contains `secretKey` and `publicKey`, or that `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` are set in the environment Cursor gives the hook
- Look for error messages in Cursor's developer console or the hook's stderr (`Flush error`)

### Hook errors in Cursor

The handler is designed to fail gracefully. If an error occurs:

- The error is logged to stderr
- A permissive response (`{ "continue": true, "permission": "allow" }`) is returned
- Cursor operations are not blocked

## License

MIT
