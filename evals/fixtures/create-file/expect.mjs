// Assertion for the create-file fixture: result.txt must contain exactly DONE.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default async function check(cwd) {
  const p = join(cwd, "result.txt");
  if (!existsSync(p)) return { pass: false, detail: "result.txt not created" };
  const content = readFileSync(p, "utf8").trim();
  if (content === "DONE") return { pass: true, detail: "exact match" };
  return { pass: false, detail: `content was ${JSON.stringify(content.slice(0, 40))}` };
}
