// Recovery for tool calls that local models emit as plain TEXT instead of
// structured tool_calls.
//
// Models only ever learn their family's native tool-call wire syntax (e.g.
// Mistral's `[TOOL_CALLS]Name[ARGS]{json}`); the OpenAI-style structured
// form exists solely because the server's template parser translates the
// text back. When the emission drifts slightly (leading prose, a swallowed
// special token, a template mismatch), that parser falls through and the
// raw syntax leaks to us as assistant content. Without recovery the loop
// reads such a message as a final answer and silently ends the run
// mid-task — observed repeatedly with devstral-2 under Ollama.
//
// This module is the deterministic half of the defense: recognise the known
// leak formats and rebuild real tool_calls from them, no LLM round-trip.
// The loop nudges the model only when something *looks* like an attempt but
// cannot be parsed.

// Non-call text allowed to surround recovered calls. Above this we assume
// the content merely QUOTES call syntax (e.g. an agent writing docs about
// tool formats) and leave the message alone.
const MAX_RESIDUAL_CHARS = 200;

// Content longer than this is never treated as a failed call attempt — a
// long final report that happens to mention a marker token is a report.
const MAX_ATTEMPT_CHARS = 2000;

/** Corrective user message injected when an attempt is detected but not parseable. */
export const TEXTUAL_TOOL_CALL_NUDGE =
  "Workflow: your last message contained a tool call written as plain text, " +
  "which the harness cannot execute. Re-issue it as a proper structured tool " +
  "call. If you are actually finished, reply with your final answer in prose only.";

/**
 * Try to recover structured tool calls from assistant text.
 *
 * @param {string} content — the assistant message content (no tool_calls present)
 * @param {string[]} knownToolNames — registry tool names; unknown names never match
 * @returns {{toolCalls: Array<object>, attempted: boolean}|null}
 *   toolCalls non-empty → deterministically recovered, dispatch them.
 *   attempted true (with empty toolCalls) → looks like a failed attempt, nudge.
 *   null → no sign of a tool call, treat as a genuine final answer.
 */
export function recoverTextualToolCalls(content, knownToolNames) {
  if (typeof content !== "string" || content.trim().length === 0) return null;
  const known = new Set(knownToolNames);

  const found = []; // { name, argsJson, start, end }

  collectMistralTekken(content, known, found);
  collectMistralArray(content, known, found);
  collectHermesTags(content, known, found);
  if (found.length === 0) collectBareJsonObject(content, known, found);

  if (found.length > 0) {
    // Residual = everything outside the matched call spans. Heavy prose
    // around a parseable fragment means quoting, not calling.
    found.sort((a, b) => a.start - b.start);
    let residual = "";
    let cursor = 0;
    for (const f of found) {
      residual += content.slice(cursor, Math.max(cursor, f.start));
      cursor = Math.max(cursor, f.end);
    }
    residual += content.slice(cursor);
    if (residual.trim().length > MAX_RESIDUAL_CHARS) return null;

    return {
      attempted: true,
      toolCalls: found.map((f, i) => ({
        id: `call_recovered_${Date.now()}_${i}`,
        type: "function",
        function: { name: f.name, arguments: f.argsJson },
      })),
    };
  }

  // Nothing parseable — is it at least recognisably an attempt?
  if (
    content.length <= MAX_ATTEMPT_CHARS &&
    /\[TOOL_CALLS\]|\[ARGS\]|<tool_call>/.test(content)
  ) {
    return { attempted: true, toolCalls: [] };
  }
  return null;
}

// --- format collectors -----------------------------------------------------

// Mistral v7+/Tekken leak: `Name[ARGS]{json}`, optionally still prefixed by
// the `[TOOL_CALLS]` special token, possibly several in sequence.
function collectMistralTekken(content, known, found) {
  const re = /(?:\[TOOL_CALLS\]\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\[ARGS\]\s*/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!known.has(m[1])) continue;
    const json = extractBalanced(content, re.lastIndex, "{", "}");
    if (!json) continue;
    if (!parses(json)) continue;
    found.push({ name: m[1], argsJson: json, start: m.index, end: re.lastIndex + json.length });
    re.lastIndex += json.length;
  }
}

// Older Mistral form: `[TOOL_CALLS] [{"name": "...", "arguments": {...}}, …]`.
function collectMistralArray(content, known, found) {
  const re = /\[TOOL_CALLS\]\s*(?=\[)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const arr = extractBalanced(content, re.lastIndex, "[", "]");
    if (!arr) continue;
    let parsed;
    try {
      parsed = JSON.parse(arr);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const calls = parsed.filter(
      (c) => c && known.has(c.name) && typeof (c.arguments ?? c.parameters) === "object",
    );
    if (calls.length === 0) continue;
    for (const c of calls) {
      found.push({
        name: c.name,
        argsJson: JSON.stringify(c.arguments ?? c.parameters ?? {}),
        start: m.index,
        end: re.lastIndex + arr.length,
      });
    }
  }
}

// Hermes/Qwen-family leak: `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`.
function collectHermesTags(content, known, found) {
  const re = /<tool_call>\s*/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const json = extractBalanced(content, re.lastIndex, "{", "}");
    if (!json) continue;
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (!parsed || !known.has(parsed.name)) continue;
    const args = parsed.arguments ?? parsed.parameters ?? {};
    let end = re.lastIndex + json.length;
    const closer = content.slice(end).match(/^\s*<\/tool_call>/);
    if (closer) end += closer[0].length;
    found.push({ name: parsed.name, argsJson: JSON.stringify(args), start: m.index, end });
  }
}

// A message that IS one bare JSON call object: `{"name": "Read", "arguments": {...}}`.
// Only exact shape + known tool name, so a JSON-formatted final answer survives.
function collectBareJsonObject(content, known, found) {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const keys = Object.keys(parsed).sort();
  const shapeOk =
    (keys.length === 2 &&
      keys.includes("name") &&
      (keys.includes("arguments") || keys.includes("parameters")));
  if (!shapeOk || !known.has(parsed.name)) return;
  const args = parsed.arguments ?? parsed.parameters;
  if (typeof args !== "object" || args === null) return;
  found.push({
    name: parsed.name,
    argsJson: JSON.stringify(args),
    start: 0,
    end: content.length,
  });
}

// --- helpers ---------------------------------------------------------------

/**
 * Extract a balanced {...} or [...] starting at `start` (which must point at
 * the opening char), honouring JSON string literals and escapes. Returns the
 * matched slice or null.
 */
function extractBalanced(text, start, open, close) {
  if (text[start] !== open) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parses(json) {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}
