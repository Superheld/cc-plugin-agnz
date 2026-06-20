// node:test coverage for lib/workspace-store.mjs.
//
// Uses a per-test temp cwd so the real per-project state under
// <cwd>/.claude/agnz/ is isolated from everything else. Thread
// ids are passed as plain strings (no crypto dependency on these
// tests — the store doesn't care where the id came from).
//
// Run with: node --test tests/workspace-store.test.mjs

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  createWorkspaceStore,
  WORKSPACE_SCHEMA_VERSION,
} from "../lib/workspace-store.mjs";

let cwd;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "agnz-ws-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("createWorkspaceStore", () => {
  test("throws on missing cwd", () => {
    assert.throws(() => createWorkspaceStore(""), /cwd is required/);
  });

  test("exposes cwd and root paths", () => {
    const store = createWorkspaceStore(cwd);
    assert.equal(store.cwd, cwd);
    assert.ok(store.root.endsWith(join(".claude", "agnz")));
  });
});

describe("workspace.json lifecycle", () => {
  test("readWorkspace returns null when no workspace exists yet", async () => {
    const store = createWorkspaceStore(cwd);
    assert.equal(await store.readWorkspace(), null);
  });

  test("ensureWorkspace creates a default workspace.json", async () => {
    const store = createWorkspaceStore(cwd);
    const ws = await store.ensureWorkspace();
    assert.equal(ws.schemaVersion, WORKSPACE_SCHEMA_VERSION);
    assert.equal(ws.name, basename(cwd));
    assert.equal(ws.cwd, cwd);
    assert.ok(typeof ws.createdAt === "number");
    assert.ok(existsSync(join(cwd, ".claude", "agnz", "workspace.json")));
  });

  test("ensureWorkspace is idempotent — does not overwrite", async () => {
    const store = createWorkspaceStore(cwd);
    const first = await store.ensureWorkspace();
    await new Promise((r) => setTimeout(r, 10));
    const second = await store.ensureWorkspace();
    assert.equal(first.createdAt, second.createdAt);
  });

  test("updateWorkspace patches fields and bumps updatedAt", async () => {
    const store = createWorkspaceStore(cwd);
    const first = await store.ensureWorkspace();
    await new Promise((r) => setTimeout(r, 10));
    const patched = await store.updateWorkspace({ members: ["t-1"] });
    assert.deepEqual(patched.members, ["t-1"]);
    assert.ok(patched.updatedAt >= first.updatedAt);
  });

  test("updateWorkspace creates the file if missing", async () => {
    const store = createWorkspaceStore(cwd);
    const patched = await store.updateWorkspace({ name: "renamed" });
    assert.equal(patched.name, "renamed");
    assert.ok(existsSync(join(cwd, ".claude", "agnz", "workspace.json")));
  });
});

describe("thread meta", () => {
  test("readThreadMeta returns null for unknown id", async () => {
    const store = createWorkspaceStore(cwd);
    assert.equal(await store.readThreadMeta("ghost"), null);
  });

  test("writeThreadMeta then readThreadMeta roundtrips", async () => {
    const store = createWorkspaceStore(cwd);
    const meta = {
      id: "t-1",
      cwd,
      profile: "test-profile",
      status: "idle",
      createdAt: Date.now(),
    };
    await store.writeThreadMeta("t-1", meta);
    const loaded = await store.readThreadMeta("t-1");
    assert.deepEqual(loaded, meta);
  });

  test("writeThreadMeta creates the threads/ dir lazily", async () => {
    const store = createWorkspaceStore(cwd);
    await store.writeThreadMeta("t-2", { id: "t-2" });
    assert.ok(existsSync(join(cwd, ".claude", "agnz", "threads", "t-2.meta.json")));
  });
});

describe("thread transcript (jsonl)", () => {
  test("readThreadMessages returns [] for missing file", async () => {
    const store = createWorkspaceStore(cwd);
    assert.deepEqual(await store.readThreadMessages("none"), []);
  });

  test("appendThreadMessage then readThreadMessages returns all appended", async () => {
    const store = createWorkspaceStore(cwd);
    await store.appendThreadMessage("t-3", { role: "user", content: "hi" });
    await store.appendThreadMessage("t-3", { role: "assistant", content: "hello" });
    const messages = await store.readThreadMessages("t-3");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.ok(typeof messages[0].ts === "number");
  });

  test("appended messages are JSONL (one object per line, trailing newline)", async () => {
    const store = createWorkspaceStore(cwd);
    await store.appendThreadMessage("t-4", { tag: "first" });
    await store.appendThreadMessage("t-4", { tag: "second" });
    const raw = readFileSync(
      join(cwd, ".claude", "agnz", "threads", "t-4.jsonl"),
      "utf8",
    );
    assert.ok(raw.endsWith("\n"));
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    for (const line of lines) JSON.parse(line); // each line must be valid JSON
  });

  test("readThreadMessages skips empty/trailing newlines gracefully", async () => {
    const store = createWorkspaceStore(cwd);
    await store.appendThreadMessage("t-5", { ok: true });
    const messages = await store.readThreadMessages("t-5");
    assert.equal(messages.length, 1);
  });
});

describe("listThreads", () => {
  test("returns [] when threads/ does not exist", async () => {
    const store = createWorkspaceStore(cwd);
    // ensureDirs is triggered by writes, so listThreads on a bare cwd
    // will create the dir and return empty.
    const list = await store.listThreads();
    assert.deepEqual(list, []);
  });

  test("returns meta for every thread in the workspace", async () => {
    const store = createWorkspaceStore(cwd);
    await store.writeThreadMeta("t-a", { id: "t-a", createdAt: 1000 });
    await store.writeThreadMeta("t-b", { id: "t-b", createdAt: 3000 });
    await store.writeThreadMeta("t-c", { id: "t-c", createdAt: 2000 });
    const list = await store.listThreads();
    assert.equal(list.length, 3);
    // Sorted by createdAt descending (most recent first)
    assert.equal(list[0].id, "t-b");
    assert.equal(list[1].id, "t-c");
    assert.equal(list[2].id, "t-a");
  });

  test("ignores non-meta files in the threads/ dir", async () => {
    const store = createWorkspaceStore(cwd);
    // Create a transcript without a meta — should be ignored by listThreads
    await store.appendThreadMessage("t-orphan", { role: "user" });
    const list = await store.listThreads();
    assert.equal(list.length, 0);
  });
});
