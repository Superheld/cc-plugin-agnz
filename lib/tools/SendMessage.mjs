// send_message — the only way for agents to publish messages.
//
// Reading is automatic: new mail is injected into the agent's turn context
// at the top of each loop iteration. There is no read tool.

import { publish } from "../event-bus.mjs";

const KIND_ENUM = ["say", "question", "answer", "handoff", "status", "error", "directive"];

export default {
  name: "SendMessage",
  description:
    "Send a message to another agent or 'parent'. Inbound messages arrive automatically at turn start.",
  parameters: {
    type: "object",
    properties: {
      to: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "Recipient: agent name, 'parent', '*', or array.",
      },
      kind: {
        type: "string",
        enum: KIND_ENUM,
        description: "Message type: say|question|answer|handoff|status|error|directive.",
      },
      text: { type: "string", description: "Message body." },
      item_id: { type: "string", description: "Board item reference (optional)." },
      ref: { type: "string", description: "Message id being replied to (optional)." },
      urgent: { type: "boolean", default: false, description: "Trigger OS notification (optional)." },
    },
    required: ["to", "kind", "text"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // Return clean tool errors (isError) instead of throwing, so the loop
    // does not have to wrap them into a double-prefixed message.
    const fail = (m) => ({ content: `Error: ${m}`, isError: true });

    if (!KIND_ENUM.includes(args.kind)) {
      return fail(`kind must be one of ${KIND_ENUM.join(", ")}`);
    }
    if (typeof args.text !== "string" || args.text.length === 0) {
      return fail("text must be a non-empty string");
    }
    if (typeof args.to === "string") {
      if (args.to.length === 0) return fail("to must be a non-empty string");
    } else if (Array.isArray(args.to)) {
      if (args.to.length === 0 || args.to.some((r) => typeof r !== "string" || r.length === 0)) {
        return fail("to must be a non-empty string or array of non-empty strings");
      }
    } else {
      return fail("to must be a string or array of strings");
    }

    // Resolve sender and cwd
    const from = ctx.agentName || "agent";
    const cwd = ctx.sandbox.getRoot();

    // Publish and return the message id
    const full = await publish(cwd, {
      from,
      to: args.to,
      kind: args.kind,
      text: args.text,
      item_id: args.item_id,
      ref: args.ref,
      urgent: args.urgent === true,
    });

    return { content: `sent ${full.id}` };
  },
};
