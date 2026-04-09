// Tool registry: exposes a set of tools to the agent loop with a uniform
// shape. Each tool module default-exports a descriptor:
//
//   {
//     name: "read_file",
//     description: "...",
//     parameters: { /* JSON schema */ },
//     async run(args, ctx) { ... } // ctx = { sandbox, memory, thread }
//   }
//
// The registry knows nothing about permissions — the agent loop consults
// sandbox.checkPermission(tool.name) before calling run().

import listDir from "./list_dir.mjs";
import readFile from "./read_file.mjs";
import editFile from "./edit_file.mjs";
import writeFile from "./write_file.mjs";
import grep from "./grep.mjs";
import askUser from "./ask_user.mjs";
import bash from "./bash.mjs";
import sendMessage from "./send_message.mjs";
import useSkill from "./use_skill.mjs";

const BUILTIN = [listDir, readFile, editFile, writeFile, grep, askUser, bash, sendMessage, useSkill];

export function createRegistry(extra = []) {
  const tools = new Map();
  for (const t of [...BUILTIN, ...extra]) {
    if (!t?.name) throw new Error(`registry: tool missing name: ${JSON.stringify(t)}`);
    if (tools.has(t.name)) throw new Error(`registry: duplicate tool: ${t.name}`);
    tools.set(t.name, t);
  }

  return {
    get(name) {
      return tools.get(name);
    },
    has(name) {
      return tools.has(name);
    },
    list() {
      return [...tools.values()];
    },
    /**
     * Serialise tools into the OpenAI "tools" array format used by chat
     * completion endpoints that support function calling.
     */
    toOpenAISchema() {
      return [...tools.values()].map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    },
  };
}
