# Cursor Langfuse

A CLI that records Cursor hook events as Langfuse traces.

## Overview

Install `cursor-langfuse`, then point the hooks you care about at that command. Each prompt, response, file edit, shell command, and MCP tool call you wire up is captured and sent to Langfuse.

## Features

- **Full Hook Coverage**: Supports all 12 Cursor hooks (Agent and Tab modes)
- **Conversation Tracing**: Traces grouped by `conversation_id` for complete session visibility
- **Workspace Sessions**: Sessions grouped by workspace and conversation id for easy filtering
- **Dynamic Tags**: Automatic tagging based on activity type (shell, mcp, file-ops, thinking, etc.)
- **Completion Scores**: Tracks agent completion status and efficiency metrics
- **Rich Metadata**: Captures edit statistics, durations, file types, and more
- **Non-blocking**: Errors are logged but don't interrupt Cursor operations

## Supported Hooks

| Hook                   | Description                                   |
| ---------------------- | --------------------------------------------- |
| `beforeSubmitPrompt`   | Captures user prompts and attachments         |
| `afterAgentResponse`   | Records agent responses                       |
| `afterAgentThought`    | Logs agent thinking/reasoning                 |
| `beforeShellExecution` | Tracks shell commands before execution        |
| `afterShellExecution`  | Captures shell command output                 |
| `beforeMCPExecution`   | Logs MCP tool calls                           |
| `afterMCPExecution`    | Records MCP tool results                      |
| `beforeReadFile`       | Tracks file read operations                   |
| `afterFileEdit`        | Captures file edits with line statistics      |
| `stop`                 | Records session completion with status scores |
| `beforeTabFileRead`    | Tab mode file reads                           |
| `afterTabFileEdit`     | Tab mode file edits                           |

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

Register the command in your user hooks file, `~/.cursor/hooks.json`. User hooks run for every project. A full example is in [`examples/hooks.json`](examples/hooks.json). Omit any event you do not want to record:

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "cursor-langfuse" }],
    "afterAgentResponse": [{ "command": "cursor-langfuse" }],
    "stop": [{ "command": "cursor-langfuse" }]
  }
}
```

Cursor resolves the command like a shell. If the hook reports that `cursor-langfuse` cannot be found, use the absolute path from `command -v cursor-langfuse`.

The CLI reads the hook payload from stdin and prints the hook response on stdout. It fails open: errors are logged to stderr and Cursor is allowed to continue.

This repository still contains `.cursor/hooks.json` wired to the previous in-tree handler, so tracing keeps running here. That file is local configuration, not part of the package you install.

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
3. The `conversation_id` is hashed into a deterministic Langfuse trace id, and the event is recorded on that conversation's root observation
4. Session, user, version, tags, and metadata are propagated before any observation is created, so they are present on the root and on every child, including generations that carry token usage
5. The appropriate handler records spans, generations, and events under that root. Overall prompt and response text are stored on the root observation
6. Scores are attached to the root observation
7. The process flushes the OpenTelemetry exporter and the score queue, then shuts them down before exiting

The handler uses the Langfuse JS SDK v5 (`@langfuse/tracing`, `@langfuse/otel`, and `@langfuse/client`) and exports traces with OTLP to `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces`. That path requires Langfuse Cloud or a self-hosted Langfuse v4 server.

### Trace Structure

- **Trace**: One per conversation. The trace id is a deterministic hash of `conversation_id`
- **Root observation**: Holds the conversation input and output. Later hook processes reuse the same root span id
- **Session**: Grouped by workspace folder name and conversation id, and copied onto every observation
- **Generations**: User prompts and agent responses. Response generations include token usage
- **Spans**: File operations, shell commands, MCP calls, thinking
- **Events**: Session completion markers
- **Scores**: Completion status (0-1) and efficiency metrics, attached to the root observation

Between hook processes, the latest root input and output are stored under `$TMPDIR/cursor-langfuse-hooks` (override with `CURSOR_LANGFUSE_STATE_DIR`) so a later event can keep both on the root observation. Those files are written with user-only permissions.

### Automatic Tagging

Traces are automatically tagged based on activity:

- `cursor` - All traces
- `agent` or `tab` - Based on hook source
- `shell` - Shell command activity
- `mcp` - MCP tool usage
- `file-ops` - File read/write operations
- `thinking` - Agent reasoning captured
- Model name (e.g., `claude-3-5-sonnet`)
- `status-completed`, `status-aborted`, `status-error`

## Project Structure

```
bin/cursor-langfuse.js    # CLI entry point
src/
  langfuse-client.js      # Langfuse SDK wrapper
  handlers.js             # Hook-specific handlers
  utils.js                # Utility functions
examples/hooks.json       # Sample user hooks file (~/.cursor/hooks.json)
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
