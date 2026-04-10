// Tier-1 context compression: collapses redundant tool call/result pairs
// in the message history before they reach the LLM.
//
// Strategy (V1 — path-based deduplication):
//   For each LS / Read / Grep tool call, extract the target path from the
//   call arguments. When the same (tool, path) pair appears more than once,
//   keep only the LAST occurrence (most recent = most accurate) and replace
//   earlier tool results with a short "[omitted]" placeholder.
//
// This function is a pure transformation — it never touches the on-disk
// transcript. The loop calls it in buildMessages() so the LLM sees a
// compressed view while the full history is still persisted.

// PascalCase (current) and snake_case (pre-v0.5 threads) both supported.
const COMPRESSIBLE = new Set(["LS", "Read", "Grep", "list_dir", "read_file", "grep"]);

/**
 * Rough token estimate: 1 token ≈ 4 characters.
 * Good enough for threshold decisions; no need for a real tokeniser.
 */
export function estimateTokens(str) {
  return Math.ceil((str?.length ?? 0) / 4);
}

/**
 * Sum estimated tokens across a messages array (content + tool_call args).
 */
export function countTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function?.arguments);
      }
    }
  }
  return total;
}

/**
 * Compress a message history (everything after the system prompt).
 *
 * @param {object[]} history          — raw persisted messages (no system prompt)
 * @param {object}   [opts]
 * @param {number}   [opts.threshold] — only compress when history exceeds this
 *                                      many estimated tokens (default: 8000)
 * @returns {{ messages: object[], stats: { before: number, after: number, omitted: number } }}
 */
export function compressHistory(history, { threshold = 8000 } = {}) {
  const before = countTokens(history);

  if (before < threshold) {
    return { messages: history, stats: { before, after: before, omitted: 0 } };
  }

  // --- pass 1: map each tool_call_id → { name, path } ---
  const callMeta = new Map(); // id → { name, path }
  for (const m of history) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name;
      if (!COMPRESSIBLE.has(name)) continue;
      let path;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        // LS and Read use 'path'; Grep uses 'path' too (directory to search)
        path = args.path ?? null;
      } catch {
        continue;
      }
      if (path) callMeta.set(tc.id, { name, path });
    }
  }

  // --- pass 2: walk tool results in order, group by (name, path) ---
  // We want to keep the LAST occurrence for each (name, path) pair.
  // Walking in reverse: first time we see a key → keep; subsequent → omit.
  const resultEntries = []; // [{id, key}] in forward order
  for (const m of history) {
    if (m.role !== "tool" || !m.tool_call_id) continue;
    const meta = callMeta.get(m.tool_call_id);
    if (!meta) continue;
    resultEntries.push({ id: m.tool_call_id, key: `${meta.name}:${meta.path}` });
  }

  const omitIds = new Set();
  const seenKeys = new Set();
  for (let i = resultEntries.length - 1; i >= 0; i--) {
    const { id, key } = resultEntries[i];
    if (seenKeys.has(key)) {
      omitIds.add(id);
    } else {
      seenKeys.add(key);
    }
  }

  // --- pass 3: rebuild with omitted results replaced ---
  let omitted = 0;
  const compressed = history.map((m) => {
    if (m.role !== "tool" || !omitIds.has(m.tool_call_id)) return m;
    const meta = callMeta.get(m.tool_call_id);
    omitted++;
    return {
      ...m,
      content: `[omitted — ${meta.name} ${meta.path} superseded by a later read]`,
    };
  });

  const after = countTokens(compressed);
  return { messages: compressed, stats: { before, after, omitted } };
}
