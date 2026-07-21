// node:test coverage for the unified two-layer config (ADR 0017).
//
// Pins the merge semantics (per-entry, project wins), the model→profile
// resolution chain, and the loud failure on a pre-0.18 legacy layout.
//
// Run with: node --test tests/config.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resolveProfileForModel, updateConfigLayer } from "../lib/config.mjs";

let userDir;
let projectCwd;

function writeUserConfig(obj) {
  writeFileSync(join(userDir, "config.json"), JSON.stringify(obj), "utf8");
}
function writeProjectConfig(obj) {
  const dir = join(projectCwd, ".claude", "agnz");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj), "utf8");
}

const OLLAMA = { baseUrl: "http://ollama:11434/v1", model: "devstral" };
const LMSTUDIO = { baseUrl: "http://localhost:1234/v1", model: "qwen" };

beforeEach(() => {
  userDir = mkdtempSync(join(tmpdir(), "agnz-config-user-"));
  projectCwd = mkdtempSync(join(tmpdir(), "agnz-config-cwd-"));
  process.env.AGNZ_DATA_DIR = userDir;
});

afterEach(() => {
  delete process.env.AGNZ_DATA_DIR;
  rmSync(userDir, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
});

test("user layer alone provides profiles and mappings with origin", async () => {
  writeUserConfig({ profiles: { devstral: OLLAMA }, mappings: { _default: "devstral" } });
  const { profiles, mappings } = await loadConfig(projectCwd);
  assert.equal(profiles.devstral.baseUrl, OLLAMA.baseUrl);
  assert.equal(profiles.devstral.origin, "user");
  assert.equal(mappings._default.profile, "devstral");
  assert.equal(mappings._default.origin, "user");
});

test("project layer overrides per entry, not wholesale", async () => {
  writeUserConfig({
    profiles: { devstral: OLLAMA, lmstudio: LMSTUDIO },
    mappings: { _default: "devstral", sonnet: "devstral" },
  });
  writeProjectConfig({
    profiles: { devstral: { ...OLLAMA, temperature: 0.7 } },
    mappings: { sonnet: "lmstudio" },
  });
  const { profiles, mappings } = await loadConfig(projectCwd);
  // overridden entry comes from the project…
  assert.equal(profiles.devstral.temperature, 0.7);
  assert.equal(profiles.devstral.origin, "project");
  assert.equal(mappings.sonnet.profile, "lmstudio");
  assert.equal(mappings.sonnet.origin, "project");
  // …while untouched user entries survive
  assert.equal(profiles.lmstudio.origin, "user");
  assert.equal(mappings._default.profile, "devstral");
});

test("resolveProfileForModel walks mapping → _default → profile-name", async () => {
  writeUserConfig({
    profiles: { devstral: OLLAMA, lmstudio: LMSTUDIO },
    mappings: { _default: "devstral", sonnet: "lmstudio" },
  });
  assert.equal((await resolveProfileForModel(projectCwd, "sonnet")).name, "lmstudio");
  assert.equal((await resolveProfileForModel(projectCwd, "haiku")).name, "devstral"); // _default
  // no _default: the identifier itself is tried as a profile name
  writeUserConfig({ profiles: { lmstudio: LMSTUDIO }, mappings: {} });
  assert.equal((await resolveProfileForModel(projectCwd, "lmstudio")).name, "lmstudio");
  assert.equal(await resolveProfileForModel(projectCwd, "unknown"), null);
});

test("a legacy profiles.json without config.json fails loudly", async () => {
  writeFileSync(join(userDir, "profiles.json"), '{"version":1,"profiles":{}}', "utf8");
  await assert.rejects(loadConfig(projectCwd), /ADR 0017/);
});

test("updateConfigLayer round-trips and loadConfig sees the write", async () => {
  await updateConfigLayer("user", null, (layer) => ({
    ...layer,
    profiles: { ...layer.profiles, devstral: OLLAMA },
    mappings: { _default: "devstral" },
  }));
  await updateConfigLayer("project", projectCwd, (layer) => ({
    ...layer,
    mappings: { ...layer.mappings, _default: "devstral" },
  }));
  const { mappings } = await loadConfig(projectCwd);
  assert.equal(mappings._default.origin, "project");
});

test("a malformed profile fails validation with the profile's name", async () => {
  writeUserConfig({ profiles: { broken: { model: "x" } }, mappings: {} });
  await assert.rejects(loadConfig(projectCwd), /profile 'broken': baseUrl is required/);
});
