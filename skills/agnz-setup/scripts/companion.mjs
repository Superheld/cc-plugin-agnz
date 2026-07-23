#!/usr/bin/env node
// Slash-command dispatcher. Keeps slash-command markdown files simple:
// they shell out here with `node companion.mjs <group> <subcommand> ...`
// and print whatever we write to stdout.
//
// Config commands operate on the unified two-layer config (ADR 0017):
// ~/.claude/agnz/config.json (user defaults) and
// <cwd>/.claude/agnz/config.json (project overrides). All write commands
// target the user layer by default; pass --project to write the project
// override file instead.

import { loadConfig, updateConfigLayer, normaliseProfile } from "../../../lib/config.mjs";
import { resolveUserDir, resolveProjectDir } from "../../../lib/data-dir.mjs";
import { createWorkspaceStore } from "../../../lib/workspace-store.mjs";
import { listModels } from "../../../lib/llm/openai-compatible.mjs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);

function print(obj) {
  if (typeof obj === "string") {
    process.stdout.write(obj + "\n");
  } else {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  }
}

// Exit code convention:
//   0 — success
//   1 — unexpected error (thrown from somewhere inside the dispatcher)
//   2 — usage error (wrong args, unknown sub-command, bad input)
function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}
function usage(message) {
  return fail(message, 2);
}

/** Strip a --project flag out of the args; returns [scope, remainingArgs]. */
function scopeOf(args) {
  const rest = args.filter((a) => a !== "--project");
  return [rest.length === args.length ? "user" : "project", rest];
}

async function main() {
  const [group, ...rest] = argv;
  if (!group) return usage("usage: companion.mjs <group> <subcommand> [args...]");

  if (group === "setup") return runSetup(rest);
  if (group === "threads") return runThreads(rest);
  if (group === "info") return runInfo(rest);

  return usage(`unknown command group: ${group}`);
}

async function runSetup(rawArgs) {
  const [scope, args] = scopeOf(rawArgs);
  const cwd = process.cwd();
  const sub = args[0] || "list";

  if (sub === "list") {
    const { profiles, mappings } = await loadConfig(cwd);
    return print({
      profiles: Object.values(profiles),
      mappings: Object.fromEntries(
        Object.entries(mappings).map(([m, v]) => [m, `${v.profile} (${v.origin})`]),
      ),
    });
  }

  if (sub === "add") {
    // add <name> <baseUrl> <model> [apiKey] [--project]
    const [, name, baseUrl, model, apiKey] = args;
    if (!name || !baseUrl || !model) {
      return usage("setup add <name> <baseUrl> <model> [apiKey] [--project]");
    }
    const profile = normaliseProfile(name, { baseUrl, model, apiKey: apiKey || null });
    const { file } = await updateConfigLayer(scope, cwd, (layer) => {
      const next = { ...layer, profiles: { ...layer.profiles, [name]: profile } };
      // The first profile of a fresh layer becomes the fallback mapping, so
      // a new setup works without a separate `mapping set _default` step.
      const isFirstProfile = Object.keys(layer.profiles).length === 0;
      if (isFirstProfile && !layer.mappings._default) {
        next.mappings = { ...layer.mappings, _default: name };
      }
      return next;
    });
    return print({ added: name, scope, file, ...profile });
  }

  if (sub === "set") {
    // set <name> <field> <value>: update one optional field on an existing
    // profile — the only path (besides hand-editing config.json) to fields
    // `add` doesn't take, e.g. llmTimeoutMs or contextWindow.
    const NUMERIC = ["temperature", "maxTokens", "maxTurns", "llmTimeoutMs", "contextWindow", "compactThreshold"];
    const STRINGY = ["baseUrl", "model", "apiKey"];
    const [, name, field, value] = args;
    if (!name || !field || value === undefined) {
      return usage("setup set <name> <field> <value> [--project]");
    }
    if (!NUMERIC.includes(field) && !STRINGY.includes(field)) {
      return usage(`unknown profile field '${field}' (known: ${[...STRINGY, ...NUMERIC].join(", ")})`);
    }
    const parsed = NUMERIC.includes(field) ? Number(value) : value;
    if (NUMERIC.includes(field) && !Number.isFinite(parsed)) {
      return usage(`field '${field}' expects a number, got '${value}'`);
    }
    const { file } = await updateConfigLayer(scope, cwd, (layer) => {
      const cur = layer.profiles[name];
      if (!cur) throw new Error(`no profile '${name}' in the ${scope} layer (a 'set' edits one layer — pass --project for the project override)`);
      const profile = normaliseProfile(name, { ...cur, [field]: parsed });
      return { ...layer, profiles: { ...layer.profiles, [name]: profile } };
    });
    return print({ updated: name, [field]: parsed, scope, file });
  }

  if (sub === "remove") {
    const [, name] = args;
    if (!name) return usage("setup remove <name> [--project]");
    const { file } = await updateConfigLayer(scope, cwd, (layer) => {
      if (!layer.profiles[name]) throw new Error(`no profile '${name}' in the ${scope} layer`);
      const profiles = { ...layer.profiles };
      delete profiles[name];
      return { ...layer, profiles };
    });
    return print({ removed: name, scope, file });
  }

  if (sub === "use") {
    // use <name>: point the fallback mapping (_default) at a profile.
    const [, name] = args;
    if (!name) return usage("setup use <name> [--project]");
    const { profiles } = await loadConfig(cwd);
    if (!profiles[name]) return fail(`no such profile '${name}' in the effective config`);
    await updateConfigLayer(scope, cwd, (layer) => ({
      ...layer,
      mappings: { ...layer.mappings, _default: name },
    }));
    return print({ _default: name, scope });
  }

  if (sub === "test") {
    const [, name] = args;
    try {
      const { profiles, mappings } = await loadConfig(cwd);
      const target = name || mappings._default?.profile;
      const p = target ? profiles[target] : null;
      if (!p) throw new Error(`no such profile '${target || "(default)"}'`);
      const models = await listModels({ baseUrl: p.baseUrl, apiKey: p.apiKey });
      return print({
        ok: true,
        name: p.name,
        baseUrl: p.baseUrl,
        models,
        seesConfiguredModel: Boolean(p.model && models.includes(p.model)),
      });
    } catch (err) {
      return fail(err.message, 1);
    }
  }

  if (sub === "mapping") {
    const msub = args[1] || "list";

    if (msub === "list") {
      const { mappings } = await loadConfig(cwd);
      const entries = Object.entries(mappings);
      if (entries.length === 0) {
        return print("(no mappings — model identifiers fall through to profile name lookup)");
      }
      for (const [model, v] of entries) {
        const label = model === "_default" ? "_default (fallback)" : model;
        print(`  ${label} → ${v.profile}  [${v.origin}]`);
      }
      return;
    }

    if (msub === "set") {
      const [, , model, profile] = args;
      if (!model || !profile) return usage("setup mapping set <model> <profile> [--project]");
      await updateConfigLayer(scope, cwd, (layer) => ({
        ...layer,
        mappings: { ...layer.mappings, [model]: profile },
      }));
      return print(`mapped ${model} → ${profile} (${scope})`);
    }

    if (msub === "remove") {
      const [, , model] = args;
      if (!model) return usage("setup mapping remove <model> [--project]");
      await updateConfigLayer(scope, cwd, (layer) => {
        const mappings = { ...layer.mappings };
        delete mappings[model];
        return { ...layer, mappings };
      });
      return print(`removed mapping for ${model} (${scope})`);
    }

    return usage(`unknown mapping sub-command: ${msub}. Use list, set, or remove.`);
  }

  return usage(`unknown setup sub-command: ${sub}`);
}

// ---- threads ---------------------------------------------------------------
//
// Per-project thread inspection. Reads <cwd>/.claude/agnz/threads/ via
// workspace-store — a plain file read so the parent context isn't consumed
// by a thread-list pull.
async function runThreads(args) {
  const sub = args[0] || "list";

  if (sub === "list") {
    const store = createWorkspaceStore(process.cwd());
    const threads = await store.listThreads();
    const summary = threads.map((t) => ({
      id: t.id,
      name: t.name || null,
      description: t.description || null,
      status: t.status,
      agent: t.agentDef?.name || null,
      pending: t.pending?.kind || null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    return print({ cwd: process.cwd(), count: summary.length, threads: summary });
  }

  return usage(`unknown threads sub-command: ${sub}`);
}

// ---- info ------------------------------------------------------------------
//
// The effective-config view (ADR 0017): the merged two-layer config with
// per-value origin, plus the per-project layout. This is the one place
// that renders the whole model-resolution picture — no more chasing the
// chain across files by hand.

async function runInfo(args) {
  const cwd = args[0] || process.cwd();

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pluginJsonPath = resolvePath(scriptDir, "..", "..", "..", ".claude-plugin", "plugin.json");
  let version = "unknown";
  try {
    version = JSON.parse(await readFile(pluginJsonPath, "utf8")).version || "unknown";
  } catch {}

  let configBlock;
  try {
    const { profiles, mappings } = await loadConfig(cwd);
    const profileLines = Object.values(profiles).map(
      (p) => `  ${p.name} → ${p.baseUrl} · ${p.model}  [${p.origin}]`,
    );
    const mappingLines = Object.entries(mappings).map(
      ([m, v]) => `  ${m === "_default" ? "_default (fallback)" : m} → ${v.profile}  [${v.origin}]`,
    );
    configBlock = [
      "Profiles (effective, project overrides user):",
      ...(profileLines.length ? profileLines : ["  (none — run /agnz:setup add)"]),
      "Model → profile mappings:",
      ...(mappingLines.length ? mappingLines : ["  (none — model ids fall through to profile names)"]),
    ];
  } catch (err) {
    configBlock = [`Config error: ${err.message}`];
  }

  const pluginRoot = resolvePath(scriptDir, "..", "..", "..");
  const projectDir = resolveProjectDir(cwd);
  const threadsDir = resolvePath(projectDir, "threads");

  async function count(dir, suffix) {
    try {
      return (await readdir(dir)).filter((e) => e.endsWith(suffix)).length;
    } catch {
      return 0;
    }
  }

  const lines = [
    `agnz v${version}`,
    "",
    `User config:    ${resolvePath(resolveUserDir(), "config.json")}`,
    `Project config: ${resolvePath(projectDir, "config.json")} (optional override)`,
    "",
    ...configBlock,
    "",
    `Per-project (cwd: ${cwd}):`,
    `  threads: ${await count(threadsDir, ".meta.json")} (${threadsDir})`,
    `  plugin agents: ${await count(resolvePath(pluginRoot, "agents"), ".md")}`,
  ];

  print(lines.join("\n"));
}

main().catch((err) => fail(err.stack || err.message));
