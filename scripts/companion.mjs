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

// Exit code convention:
//   0 — success
//   1 — unexpected error (thrown from somewhere inside the dispatcher)
//   2 — usage error (wrong args, unknown sub-command, bad input)
// Callers that care about the distinction can branch on the code;
// Claude reading the output just sees "Error: ..." either way.
function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}
function usage(message) {
  return fail(message, 2);
}

async function main() {
  const [group, ...rest] = argv;
  if (!group) return usage("usage: companion.mjs <group> <subcommand> [args...]");

  if (group === "setup") return runSetup(rest);

  return usage(`unknown command group: ${group}`);
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
      return usage("setup add <name> <baseUrl> <model> [apiKey]");
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
    if (!name) return usage("setup remove <name>");
    await profiles.remove(name);
    return print(`removed ${name}`);
  }

  if (sub === "use") {
    const [, name] = args;
    if (!name) return usage("setup use <name>");
    await profiles.use(name);
    return print(`active profile: ${name}`);
  }

  if (sub === "test") {
    const [, name] = args;
    try {
      const result = await profiles.test(name);
      return print({ ok: true, ...result });
    } catch (err) {
      // Reachability / profile errors are runtime failures, not usage
      // mistakes — distinct exit code so scripts can tell them apart.
      return fail(err.message, 1);
    }
  }

  return usage(`unknown setup sub-command: ${sub}`);
}

main().catch((err) => fail(err.stack || err.message));
