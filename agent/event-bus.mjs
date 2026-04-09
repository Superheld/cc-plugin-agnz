// In-process event bus for agent-to-agent and agent-to-parent communication.
//
// This module provides a pub/sub primitive inside the MCP server process.
// It delegates durability to messages-log.mjs, ensuring that every published
// message is appended to the durable log before being delivered to subscribers.
//
import { appendMessage } from "./messages-log.mjs";
import { notify } from "./notifier.mjs";

// In-memory map of recipients to arrays of handlers.
// Recipients can be agent names, "parent", or "*" (broadcast).
const subscribers = new Map(); // recipient -> Set<handler>

/**
 * Register a subscriber under the specified recipient name.
 * @param {string} recipient - agent name, "parent", or "*"
 * @param {Function} handler - function(message) called on publish
 */
export function subscribe(recipient, handler) {
  if (!recipient || !handler || typeof handler !== "function") {
    throw new Error("subscribe: recipient and handler are required");
  }

  if (!subscribers.has(recipient)) {
    subscribers.set(recipient, new Set());
  }
  subscribers.get(recipient).add(handler);
}

/**
 * Remove a subscriber registration.
 * @param {string} recipient - agent name, "parent", or "*"
 * @param {Function} handler - function(message) to remove
 */
export function unsubscribe(recipient, handler) {
  if (!recipient || !handler || typeof handler !== "function") return;

  const handlers = subscribers.get(recipient);
  if (handlers) {
    handlers.delete(handler);
    if (handlers.size === 0) {
      subscribers.delete(recipient);
    }
  }
}

/**
 * Publish a message to the event bus.
 * First appends the message to the durable log, then fans out to all matching
 * subscribers (direct and wildcard). This ensures durability before delivery.
 * @param {string} cwd - absolute path to the project root
 * @param {Object} message - partial message without id and at
 */
export async function publish(cwd, message) {
  if (!cwd || !message) throw new Error("publish: cwd and message are required");

  // Append to durable log first (invariants: append-to-file-before-fanout)
  const fullMessage = await appendMessage(cwd, message);

  // Fire an OS notification if this is an urgent message addressed to
  // the parent. Fire-and-forget: notify() itself never throws, but we
  // still defensively swallow a rejected promise so a misbehaving
  // notifier cannot ever break publish().
  const toField = fullMessage.to;
  const addressesParent =
    typeof toField === "string"
      ? toField === "parent"
      : Array.isArray(toField) && toField.includes("parent");
  if (fullMessage.urgent === true && addressesParent) {
    notify({
      title: `agnz: ${fullMessage.kind} from ${fullMessage.from}`,
      body: fullMessage.text,
    }).catch(() => {});
  }

  // Normalize recipients: string -> single entry; array -> all entries
  const recipients = new Set();
  if (typeof fullMessage.to === "string") {
    recipients.add(fullMessage.to);
  } else if (Array.isArray(fullMessage.to)) {
    for (const r of fullMessage.to) recipients.add(r);
  }

  // Fan out to matching subscribers (direct and wildcard)
  for (const recipient of recipients) {
    const handlers = subscribers.get(recipient);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(fullMessage);
        } catch (err) {
          process.stderr.write(`event-bus: handler error for ${recipient}: ${err.message}\n`);
        }
      }
    }
  }

  // Broadcast to all "*" subscribers exactly once
  const broadcastHandlers = subscribers.get("*");
  if (broadcastHandlers) {
    for (const handler of broadcastHandlers) {
      try {
        handler(fullMessage);
      } catch (err) {
        process.stderr.write(`event-bus: broadcast handler error: ${err.message}\n`);
      }
    }
  }
}
