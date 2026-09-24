#!/usr/bin/env node

/**
 * Cursor Hooks Langfuse Integration
 * 
 * CLI entry point. Cursor invokes this command from hooks.json.
 * 
 * Features:
 * - Agent, Tab, session, tool, subagent, and compaction hooks
 * - One trace per user turn, grouped into a session per conversation
 * - Generations, tools, retrievers, and subagents as typed observations
 * - Completion, tool failure, context, and session-end scores
 * - Edit statistics and real observation durations
 * 
 * @version 1.2.0
 * @see https://cursor.com/docs/agent/hooks
 * @see https://langfuse.com/docs
 */

import { applyUserConfig } from '../src/config.js';
import { runConfigure } from '../src/configure.js';
import { runInit } from '../src/init.js';
import { readStdin } from '../src/utils.js';
import { 
  traceHookEvent,
  shutdownLangfuse,
  HOOK_HANDLER_VERSION,
} from '../src/langfuse-client.js';
import { routeHookHandler } from '../src/handlers.js';

/**
 * Main handler function
 * Reads hook data from stdin, records the Langfuse observation, and routes to handler
 */
async function main() {
  let exitCode = 0;
  try {
    await applyUserConfig();
    const input = await readStdin();
    const response = await traceHookEvent(input, (trace, event) =>
      routeHookHandler(event.hook_event_name, trace, event)
    );

    if (response !== null && response !== undefined) {
      console.log(JSON.stringify(response));
    }
  } catch (error) {
    console.error(`[Langfuse Hook v${HOOK_HANDLER_VERSION}] Error: ${error.message}`);
    console.log(JSON.stringify({
      continue: true,
      permission: 'allow'
    }));
    exitCode = 1;
  } finally {
    try {
      await shutdownLangfuse();
    } catch (flushError) {
      console.error(`[Langfuse Hook v${HOOK_HANDLER_VERSION}] Flush error: ${flushError.message}`);
    }
  }

  process.exit(exitCode);
}

const command = process.argv[2];
if (command === "configure") {
  runConfigure(process.argv.slice(3))
    .then((path) => {
      console.log(`Saved Langfuse credentials to ${path}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
} else if (command === "init") {
  runInit({ argv: process.argv.slice(3) })
    .then(({ hooksPath, needsConfigure }) => {
      console.log(`Registered cursor-langfuse in ${hooksPath}`);
      if (needsConfigure) {
        console.log("Run cursor-langfuse configure to save your Langfuse keys.");
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
} else if (command) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
} else {
  main();
}
