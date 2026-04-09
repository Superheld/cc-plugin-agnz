#!/usr/bin/env node
// Slash-command dispatcher. Keeps slash-command markdown files simple:
// they shell out here with `node companion.mjs <group> <subcommand> ...`
// and print whatever we write to stdout.
//
// Currently only `setup` is implemented. Future /agnz:* sub-commands
// (threads, board, etc.) will hook in here.

import { createProfileStore } from "../lib/profiles.mjs";
import { resolveUserDir } from "../lib/data-dir.mjs";

const DATA_DIR = resolveUserDir();

const argv = process.argv.slice(2);

function print(obj) {
  if (typeof obj === "string") {
    process.stdout.write(obj + "\n");
  } else {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  }
}

function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

async function main() {
  const [group, ...rest] = argv;
  if (!group) return fail("usage: companion.mjs <group> <subcommand> [args...]");

  if (group === "setup") return runSetup(rest);

  return fail(`unknown command group: ${group}`);
}

async function runSetup(args) {
  const profiles = createProfileStore({ dataDir: DATA_DIR });
  const sub = args[0] || "list";

  if (sub === "list") {
    const summary = await profiles.list();
    return print(summary);
  }

  if (sub === "add") {
    // add <name> <baseUrl> <model> [apiKey]
    const [, name, baseUrl, model, apiKey] = args;
    if (!name || !baseUrl || !model) {
      return fail("usage: setup add <name> <baseUrl> <model> [apiKey]");
    }
    const p = await profiles.add(name, {
      baseUrl,
      model,
      apiKey: apiKey || null,
    });
    return print({ added: name, ...p });
  }

  if (sub === "remove") {
    const [, name] = args;
    if (!name) return fail("usage: setup remove <name>");
    await profiles.remove(name);
    return print(`removed ${name}`);
  }

  if (sub === "use") {
    const [, name] = args;
    if (!name) return fail("usage: setup use <name>");
    await profiles.use(name);
    return print(`active profile: ${name}`);
  }

  if (sub === "test") {
    const [, name] = args;
    try {
      const result = await profiles.test(name);
      return print({ ok: true, ...result });
    } catch (err) {
      return fail(err.message, 2);
    }
  }

  return fail(`unknown setup sub-command: ${sub}`);
}

main().catch((err) => fail(err.stack || err.message));
