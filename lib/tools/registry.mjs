// Tool registry: exposes a set of tools to the agent loop with a uniform
// shape. Each tool module default-exports a descriptor:
//
//   {
//     name: "Read",
//     description: "...",
//     parameters: { /* JSON schema */ },
//     async run(args, ctx) { ... } // ctx = { sandbox, memory, thread }
//   }
//
// The registry knows nothing about permissions — the agent loop consults
// sandbox.checkPermission(tool.name) before calling run().

import LS from "./LS.mjs";
import Read from "./Read.mjs";
import Edit from "./Edit.mjs";
import Write from "./Write.mjs";
import Close from "./Close.mjs";
import Grep from "./Grep.mjs";
import AskUser from "./AskUser.mjs";
import Bash from "./Bash.mjs";
import SendMessage from "./SendMessage.mjs";
import Skill from "./Skill.mjs";

const BUILTIN = [LS, Read, Edit, Write, Close, Grep, AskUser, Bash, SendMessage, Skill];

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
