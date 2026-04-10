// Close — remove a file from the agent's workspace.
// The workspace injects open-file content into the system prompt each turn
// (ADR 0010). Closing a file stops injecting it, freeing working memory for
// other files. The file is NOT deleted from disk.

import { appendTrace } from "../trace.mjs";

export default {
  name: "Close",
  description:
    "Close an open workspace file, removing its message from the conversation context. The file is not deleted from disk. Use this when you are done with a file to free working memory for other files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to close (same path you passed to Read).",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { thread, threadMgr } = ctx;
    const openFiles = { ...(thread.openFiles || {}) };
    if (!openFiles[args.path]) {
      return { content: `[${args.path} is not open]` };
    }
    delete openFiles[args.path];
    await threadMgr.updateThread(thread.id, { openFiles });
    // Keep the in-memory ref current so subsequent tool calls in the same
    // turn (rare, but possible) see the updated workspace state.
    Object.assign(thread, { openFiles });
    appendTrace(thread, {
      type: "file_closed",
      path: args.path,
      openFiles: Object.keys(openFiles),
    });
    return { content: `[${args.path} closed — removed from workspace]` };
  },
};
