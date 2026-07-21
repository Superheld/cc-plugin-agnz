#!/usr/bin/env node
// agnz eval harness runner (ADR 0011 §5).
//
// Runs each fixture under evals/fixtures/ against one or more named profiles,
// in a throwaway temp workspace, and scores the *outcome* (a programmatic
// assertion on the resulting files), combined with quality metrics pulled
// from the ADR 0011 trace (turns, tokens, tool errors, repairs, duration).
//
// This needs a live local model, so it is NOT part of `node --test`. Run it
// by hand to compare models/profiles for a given agent role:
//
//   node evals/run.mjs                       # active profile, all fixtures
//   node evals/run.mjs --profile a,b         # compare two profiles
//   node evals/run.mjs --fixture create-file # one fixture
//   node evals/run.mjs --json                # machine-readable scorecard
//
// A fixture is a directory evals/fixtures/<name>/ with:
//   fixture.json  { name, description, prompt, agent: <inline agent def> }
//   seed/         (optional) files copied into the workspace before the run
//   expect.mjs    default-exports async (cwd) => { pass, detail }
//
// The agent def's `tools` must list every tool the task needs — anything left
// to "ask" would pause forever in an unattended run (recorded as `paused`).

import { readdir, readFile, mkdtemp, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createThreadManager } from "../lib/threads.mjs";
import { createSandbox } from "../lib/sandbox.mjs";
import { createRegistry } from "../lib/tools/registry.mjs";
import { runThread } from "../lib/loop.mjs";
import { loadConfig } from "../lib/config.mjs";
import { buildToolPolicy } from "../lib/agent-defs.mjs";
import { aggregateThread } from "../lib/trace-stats.mjs";
import { buildScorecard, formatScorecard } from "./score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");

function parseArgs(argv) {
  const args = { profiles: null, fixtures: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--profile") args.profiles = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--fixture") args.fixtures = (argv[++i] || "").split(",").filter(Boolean);
  }
  return args;
}

async function loadFixtures(filter) {
  let names;
  try {
    names = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  if (filter) names = names.filter((n) => filter.includes(n));
  const fixtures = [];
  for (const name of names) {
    const dir = join(FIXTURES_DIR, name);
    try {
      const spec = JSON.parse(await readFile(join(dir, "fixture.json"), "utf8"));
      fixtures.push({ ...spec, name: spec.name || name, dir });
    } catch (err) {
      console.error(`[eval] skipping fixture ${name}: ${err.message}`);
    }
  }
  return fixtures;
}

async function runOne(fixture, profile, registry) {
  // Each run gets its own throwaway project cwd and an isolated thread index.
  const cwd = await mkdtemp(join(tmpdir(), `agnz-eval-${fixture.name}-`));
  const userDir = await mkdtemp(join(tmpdir(), "agnz-eval-user-"));
  const prevDataDir = process.env.AGNZ_DATA_DIR;
  process.env.AGNZ_DATA_DIR = userDir;

  const result = {
    fixture: fixture.name,
    profile: profile.name,
    pass: false,
    status: "error",
    detail: "",
    metrics: { turns: 0, tokens: 0, toolCalls: 0, toolErrors: 0, repairs: 0, durationMs: 0 },
  };

  try {
    const seed = join(fixture.dir, "seed");
    if (existsSync(seed)) await cp(seed, cwd, { recursive: true });

    const agentDef = fixture.agent || {};
    const threadMgr = createThreadManager();
    const thread = await threadMgr.createThread({ cwd, name: agentDef.name || fixture.name, agentDef });
    const policy = buildToolPolicy(agentDef, registry.list().map((t) => t.name));
    const sandbox = createSandbox({ root: cwd, policy });

    const outcome = await runThread({
      thread,
      threadMgr,
      sandbox,
      registry,
      profile,
      userMessage: fixture.prompt,
    });

    result.status = outcome.status === "awaiting_input" ? "paused" : outcome.status;

    if (outcome.status === "awaiting_input") {
      result.detail = `paused on ${outcome.pending?.name || outcome.pending?.kind} — agent def must allow every tool the task needs`;
    } else {
      const checkMod = await import(pathToFileURL(join(fixture.dir, "expect.mjs")).href);
      const check = checkMod.default;
      const verdict = await check(cwd);
      result.pass = !!verdict.pass;
      result.detail = verdict.detail || "";
    }

    const m = await aggregateThread(cwd, thread.id);
    result.metrics = {
      turns: m.turns,
      tokens: m.tokens.total,
      toolCalls: m.toolCalls.total,
      toolErrors: m.toolCalls.error,
      repairs: m.repairs.total,
      durationMs: m.durationMs,
    };
  } catch (err) {
    result.status = "error";
    result.detail = err.message;
  } finally {
    if (prevDataDir === undefined) delete process.env.AGNZ_DATA_DIR;
    else process.env.AGNZ_DATA_DIR = prevDataDir;
    await rm(cwd, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve profiles from the *real* config BEFORE any AGNZ_DATA_DIR override
  // happens inside runOne — the profile object is plain data once loaded.
  const config = await loadConfig(process.cwd());
  const profileNames =
    args.profiles || [config.mappings._default?.profile].filter(Boolean);
  if (profileNames.length === 0) {
    console.error("[eval] no profile available. Run /agnz:setup first or pass --profile.");
    process.exit(1);
  }
  const profiles = [];
  for (const name of profileNames) {
    const p = config.profiles[name];
    if (!p) {
      console.error(`[eval] unknown profile: ${name}`);
      process.exit(1);
    }
    profiles.push(p);
  }

  const fixtures = await loadFixtures(args.fixtures);
  if (fixtures.length === 0) {
    console.error("[eval] no fixtures found under evals/fixtures/");
    process.exit(1);
  }

  const registry = createRegistry();
  const results = [];
  for (const profile of profiles) {
    for (const fixture of fixtures) {
      process.stderr.write(`[eval] ${profile.name} × ${fixture.name} … `);
      const r = await runOne(fixture, profile, registry);
      process.stderr.write(`${r.pass ? "PASS" : "FAIL"} (${r.status})\n`);
      results.push(r);
    }
  }

  const scorecard = buildScorecard(results);
  console.log(args.json ? JSON.stringify(scorecard, null, 2) : formatScorecard(scorecard));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[eval] ${err.stack || err.message}`);
    process.exit(1);
  });
}
