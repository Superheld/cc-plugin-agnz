// Minimal MCP stdio server: JSON-RPC 2.0 over newline-delimited JSON on
// stdin/stdout. The MCP protocol itself is just a small set of methods:
//
//   initialize            — handshake, returns server info + capabilities
//   notifications/initialized — client ack (no response)
//   tools/list            — enumerate tools
//   tools/call            — invoke a tool with validated args
//   ping                  — health check
//
// We implement exactly these. Tool definitions are supplied by the caller
// as { name, description, inputSchema, handler } objects.
//
// This replaces @modelcontextprotocol/sdk so the plugin can ship without
// any node_modules.

import { createInterface } from "node:readline";

/**
 * Protocol version we advertise. 2025-03-26 introduced the `instructions`
 * field on initialize and tool annotations (readOnlyHint etc.).
 */
const PROTOCOL_VERSION = "2025-03-26";

/**
 * Create and run an MCP server on stdio. Returns a promise that resolves
 * when stdin closes.
 *
 * @param {Object} opts
 * @param {string} opts.name           — server name
 * @param {string} opts.version        — server version
 * @param {string} [opts.instructions] — server-level guidance surfaced to
 *                                        the model via initialize result.
 *                                        Tell the agent what this server is
 *                                        for and how to use it.
 * @param {Array<ToolDef>} opts.tools  — tool definitions
 *
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {Object} inputSchema       — JSON Schema (draft-07)
 * @property {Object} [annotations]     — MCP tool annotations: title,
 *                                         readOnlyHint, destructiveHint,
 *                                         idempotentHint, openWorldHint
 * @property {(args: object) => Promise<ToolResult>} handler
 *
 * @typedef {Object} ToolResult
 * @property {Array<{type: "text", text: string}>} content
 * @property {boolean} [isError]
 */
export async function runStdioServer({ name, version, instructions, tools }) {
  const byName = new Map();
  for (const t of tools) {
    if (!t?.name) throw new Error("tool missing name");
    if (byName.has(t.name)) throw new Error(`duplicate tool: ${t.name}`);
    byName.set(t.name, t);
  }

  function write(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  function errorResponse(id, code, message, data) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  function okResponse(id, result) {
    write({ jsonrpc: "2.0", id, result });
  }

  async function handleRequest(msg) {
    const { id, method, params } = msg;

    if (method === "initialize") {
      return okResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: { name, version },
        ...(instructions ? { instructions } : {}),
      });
    }

    if (method === "ping") {
      return okResponse(id, {});
    }

    if (method === "tools/list") {
      const list = [...byName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      return okResponse(id, { tools: list });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const tool = byName.get(toolName);
      if (!tool) {
        return errorResponse(id, -32602, `unknown tool: ${toolName}`);
      }
      try {
        const result = await tool.handler(args);
        // Normalise: accept either a full MCP result or a plain string.
        if (typeof result === "string") {
          return okResponse(id, { content: [{ type: "text", text: result }] });
        }
        return okResponse(id, result);
      } catch (err) {
        return okResponse(id, {
          content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
          isError: true,
        });
      }
    }

    // Unknown method: per JSON-RPC, respond with method-not-found.
    return errorResponse(id, -32601, `method not found: ${method}`);
  }

  function handleNotification(msg) {
    // notifications/initialized: no-op ack.
    // Any other notification we silently ignore.
    if (msg.method === "notifications/initialized") return;
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Malformed line — per JSON-RPC we can't reply without an id.
        return;
      }
      if (msg && typeof msg === "object") {
        if (msg.id === undefined || msg.id === null) {
          // Notification (no id ⇒ no response expected).
          handleNotification(msg);
        } else {
          handleRequest(msg).catch((err) => {
            errorResponse(msg.id, -32603, `internal error: ${err?.message || err}`);
          });
        }
      }
    });
    rl.on("close", () => resolve());
  });
}
