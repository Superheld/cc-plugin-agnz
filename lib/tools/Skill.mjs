// Skill — list and load project, user, and plugin skills on demand. See ADR 0005.
//
//   Skill({ action: "list" })                  → name + description of each skill
//   Skill({ action: "load", name: "..." })     → that skill's SKILL.md body
//
// Discovery is SHARED with the loop's system-prompt catalog via lib/skills.mjs,
// so what the agent sees listed and what `load` resolves can never drift.
// Skills come from three roots (plugin-bundled, ~/.claude/skills,
// <cwd>/.claude/skills); project wins on name clash. Everything the parent
// can see is visible here unless the agent def's `skills:` list narrows it.
//
// Default policy: allow. Read-only, reads only from fixed paths.
//
// Discovery is cached per thread: the first call reads the dirs, later calls
// in the same thread reuse the catalog.

import { discoverSkills, skillAllowed } from "../skills.mjs";

const catalogCache = new Map(); // threadId → Map<name, entry>

export default {
  name: "Skill",
  description:
    "Load skills. action=list shows available skills; action=load returns a skill's content.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "load"],
        description: "list or load.",
      },
      name: {
        type: "string",
        description: "Skill name (required for load).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const { thread, pluginRoot } = ctx;
    const threadId = thread.id;
    const allowList = thread.agentDef?.skills ?? null; // null = no restriction

    let catalog = catalogCache.get(threadId);
    if (!catalog) {
      catalog = await discoverSkills(thread.cwd, pluginRoot);
      catalogCache.set(threadId, catalog);
    }

    const available = new Map(
      [...catalog].filter(([, entry]) => skillAllowed(allowList, entry)),
    );

    if (args.action === "list") {
      if (available.size === 0) {
        return { content: "No skills available." };
      }
      const lines = [...available.values()].map((s) =>
        s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`,
      );
      return { content: `Available skills:\n${lines.join("\n")}` };
    }

    if (args.action === "load") {
      const name = args.name;
      if (typeof name !== "string" || !name.trim()) {
        return { content: "Error: name is required when action=load", isError: true };
      }
      const skill = available.get(name);
      if (!skill) {
        const suggestions = [...available.keys()].join(", ") || "none";
        return {
          content: `Error: skill '${name}' not found. Available: ${suggestions}`,
          isError: true,
        };
      }
      return { content: skill.body };
    }

    return { content: `Error: unknown action '${args.action}' (expected list or load)`, isError: true };
  },
};
