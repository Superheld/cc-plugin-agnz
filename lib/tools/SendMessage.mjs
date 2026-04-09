// send_message — the only way for agents to publish messages.
//
// Reading is automatic: new mail is injected into the agent's turn context
// at the top of each loop iteration. There is no read tool.

import { publish } from "../event-bus.mjs";

const KIND_ENUM = ["say", "question", "answer", "handoff", "status", "error", "directive"];

export default {
  name: "SendMessage",
  description:
    "Publish a message to other agents or the parent. This is the only way to communicate outside your own context window. Reading is automatic: new mail appears at the top of each turn, so there is no read tool.",
  parameters: {
    type: "object",
    properties: {
      to: {
        oneOf: [
          { type: "string", minLength: 1 },
          {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
          },
        ],
        description:
          "Recipient(s): agent name, 'parent', '*', or an array of the above.",
      },
      kind: {
        type: "string",
        enum: KIND_ENUM,
        description:"Message kind (fixed vocabulary).",
      },
      text: { type: "string", minLength: 1, description: "Message body (non-empty)." },
      item_id: { type: "string", description: "Optional board item reference." },
      ref: { type: "string", description: "Optional message id this answers." },
      urgent: { type: "boolean", default: false, description: "Trigger OS notification if to includes parent." },
    },
    required: ["to", "kind", "text"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // Validate kind
    if (!KIND_ENUM.includes(args.kind)) {
      throw new Error(`send_message: kind must be one of ${KIND_ENUM.join(", ")}`);
    }

    // Validate text
    if (typeof args.text !== "string" || args.text.length === 0) {
      throw new Error("send_message: text must be a non-empty string");
    }

    // Validate to
    if (typeof args.to === "string") {
      if (!args.to || typeof args.to !== "string" || args.to.length === 0) {
        throw new Error("send_message: to must be a non-empty string");
      }
    } else if (Array.isArray(args.to)) {
      for (const r of args.to) {
        if (!r || typeof r !== "string" || r.length === 0) {
          throw new Error("send_message: to array must contain non-empty strings");
        }
      }
    } else {
      throw new Error("send_message: to must be a string or array of strings");
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
