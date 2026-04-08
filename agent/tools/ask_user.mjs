// ask_user — sub-agent's escape hatch when it genuinely needs a human
// (or the parent Claude session) to disambiguate. This tool is special:
// the loop never actually invokes its `run` function. Instead the loop
// recognises the tool name in dispatchToolCall, suspends with a pending
// "question" record, and waits to be resumed via agent_answer.
//
// We still ship a real descriptor so it appears in the OpenAI tools[]
// payload — that's how the model learns it can call this.

export default {
  name: "ask_user",
  description:
    "Ask the user (or the orchestrating agent) a clarifying question and wait for an answer. Use this ONLY when you cannot reasonably decide on your own — do not narrate progress or ask for confirmation of obvious actions. The tool's result will be the user's answer as plain text.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The clarification question. Be specific and short.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of suggested answers. The user is not constrained to these.",
      },
      context: {
        type: "string",
        description:
          "Optional one-paragraph context explaining why the question matters and what hinges on it.",
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
