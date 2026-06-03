// Shared fake LLM for loop tests (ADR 0011 §4). Lets node:test drive the
// real agent loop with scripted assistant turns and no live endpoint.
//
// A script is an array of steps replayed one per chat() call. A step is:
//   { message, finishReason?, usage? }  — a normal assistant turn
//   { error: "msg" }                    — throw, to exercise the error path
// The last step is repeated if the loop calls more times than scripted.

export function fakeChat(script) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.error) throw new Error(step.error);
    return {
      message: step.message,
      finishReason: step.finishReason ?? "stop",
      usage: step.usage ?? null,
      raw: {},
    };
  };
}

// The builders below return *script steps* ({ message }), so they can be
// dropped straight into a fakeChat([...]) script. Attach usage/finishReason
// by spreading, e.g. { ...finalMessage("ok"), usage: {...} }.

/** A turn that calls one tool. */
export function toolCall(id, name, args) {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}

/** A turn that calls several tools in one assistant message. */
export function toolCalls(calls) {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    },
  };
}

/** A final turn: plain assistant message, no tool calls. */
export function finalMessage(content) {
  return { message: { role: "assistant", content } };
}
