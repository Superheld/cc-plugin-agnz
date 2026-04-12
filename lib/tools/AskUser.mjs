// ask_user — sub-agent's escape hatch when it genuinely needs a human
// (or the parent Claude session) to disambiguate. This tool is special:
// the loop never actually invokes its `run` function. Instead the loop
// recognises the tool name in dispatchToolCall, suspends with a pending
// "question" record, and waits to be resumed via agent_answer.
//
// We still ship a real descriptor so it appears in the OpenAI tools[]
// payload — that's how the model learns it can call this.

export default {
  name: "AskUser",
  description:
    "Pause and ask the parent for a clarifying answer. Use ONLY when you genuinely cannot decide — not for progress updates.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Suggested answers (optional).",
      },
      context: {
        type: "string",
        description: "Why this matters (optional).",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  run() {
    // The agent loop intercepts ask_user before reaching here. If we ever
    // get called it means the loop's special-case path is broken.
    throw new Error("ask_user.run() should never be invoked — loop must intercept");
  },
};
