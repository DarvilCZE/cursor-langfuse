# Cursor Langfuse Integration

A Cursor hooks integration that sends traces to Langfuse for observability and debugging of AI coding sessions.

## Overview

This project enables automatic tracing of Cursor AI agent activity to Langfuse. Every prompt, response, file edit, shell command, and MCP tool call is captured and sent to Langfuse for analysis.

## Features

- **Full Hook Coverage**: Supports all 12 Cursor hooks (Agent and Tab modes)
- **Conversation Tracing**: Traces grouped by `conversation_id` for complete session visibility
- **Workspace Sessions**: Sessions grouped by workspace for easy filtering
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

1. Clone or copy this repository to your project directory.

2. Install dependencies:

```bash
cd .cursor/hooks
npm install
```

3. Create a `.env` file in your project root with your Langfuse credentials:

```env
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

4. The hooks configuration (`.cursor/hooks.json`) is already set up to route all hooks through the handler.

## Configuration

### Environment Variables

| Variable              | Required | Description                                                 |
| --------------------- | -------- | ----------------------------------------------------------- |
| `LANGFUSE_SECRET_KEY` | Yes      | Your Langfuse secret key                                    |
| `LANGFUSE_PUBLIC_KEY` | Yes      | Your Langfuse public key                                    |
| `LANGFUSE_BASE_URL`   | No       | Langfuse API URL (defaults to `https://cloud.langfuse.com`) |

### Hooks Configuration

The `.cursor/hooks.json` file registers the hook handler for all supported events:

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "node .cursor/hooks/hook-handler.js" }],
    "afterAgentResponse": [{ "command": "node .cursor/hooks/hook-handler.js" }],
    ...
  }
}
```

## How It Works

1. Cursor triggers a hook event and passes JSON data via stdin
2. The hook handler reads and parses the input
3. A Langfuse trace is created or updated using the `conversation_id`
4. The appropriate handler processes the event and creates spans/generations
5. Scores and tags are applied based on activity
6. Events are flushed to Langfuse before the handler exits

### Trace Structure

- **Trace**: One per conversation, identified by `conversation_id`
- **Session**: Grouped by workspace folder name
- **Generations**: User prompts and agent responses
- **Spans**: File operations, shell commands, MCP calls, thinking
- **Events**: Session completion markers
- **Scores**: Completion status (0-1) and efficiency metrics

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
.cursor/
  hooks.json              # Cursor hooks configuration
  hooks/
    hook-handler.js       # Main entry point
    package.json          # Dependencies
    lib/
      langfuse-client.js  # Langfuse SDK wrapper
      handlers.js         # Hook-specific handlers
      utils.js            # Utility functions
```

## Viewing Traces

1. Log in to your Langfuse dashboard
2. Navigate to Traces
3. Filter by session (workspace name) or tags
4. Click on a trace to see the full conversation with all spans

## Troubleshooting

### Traces not appearing in Langfuse

- Verify your `.env` file exists in the project root
- Check that `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` are set correctly
- Look for error messages in Cursor's developer console

### Hook errors in Cursor

The handler is designed to fail gracefully. If an error occurs:

- The error is logged to stderr
- A permissive response (`{ "continue": true, "permission": "allow" }`) is returned
- Cursor operations are not blocked

## License

MIT
