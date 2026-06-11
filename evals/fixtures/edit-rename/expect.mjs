// Assertion for the edit-rename fixture: foo -> greet everywhere, behaviour
// otherwise intact (the greeting string and the two call args are unchanged).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default async function check(cwd) {
  const p = join(cwd, "greet.js");
  if (!existsSync(p)) return { pass: false, detail: "greet.js missing" };
  const src = readFileSync(p, "utf8");

  if (/\bfoo\b/.test(src)) return { pass: false, detail: "old name `foo` still present" };
  if (!/function\s+greet\b/.test(src)) return { pass: false, detail: "no `function greet` definition" };
  const calls = src.match(/\bgreet\(/g) || [];
  if (calls.length < 2) return { pass: false, detail: `expected 2 greet() calls, found ${calls.length}` };
  if (!src.includes("Hello, ")) return { pass: false, detail: "greeting string was altered" };

  return { pass: true, detail: "renamed definition + 2 call sites" };
}
