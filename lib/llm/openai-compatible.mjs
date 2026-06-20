// Thin client for OpenAI-compatible /v1/chat/completions endpoints.
// Works with LM Studio, Ollama (via its OpenAI-compat endpoint), OpenRouter,
// vLLM, llama.cpp server, DeepSeek, real OpenAI, etc.
//
// We only depend on native fetch (Node >= 18). No SDKs.
//
// The client is intentionally dumb: it takes a fully-formed messages array
// and a tools array (already in OpenAI format) and returns the raw
// assistant message. The agent loop is responsible for deciding what to do
// with tool_calls.

// Default LLM request timeout. Local models under load can be slow;
// 10 minutes is generous enough for large-context completions while still
// preventing a hung server from blocking the thread permanently.
// Override per-profile via profile.llmTimeoutMs.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @typedef {Object} ChatRequest
 * @property {string} baseUrl       — e.g. http://localhost:1234/v1
 * @property {string|null} apiKey   — optional; many local servers ignore it
 * @property {string} model
 * @property {Array<object>} messages
 * @property {Array<object>} [tools]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {number} [timeoutMs]   — per-request timeout in ms (default: 10 min)
 * @property {AbortSignal} [signal] — caller's cancellation signal
 */

/**
 * Send one chat completion request. Returns { message, usage, raw }.
 * message has shape { role: "assistant", content: string|null, tool_calls?: [...] }.
 */
export async function chat(req) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    temperature,
    maxTokens,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = req;

  // Combine the caller's cancellation signal (if any) with a deadline so
  // a hung LLM server cannot block the thread indefinitely. Node 18 does
  // not have AbortSignal.any(); use a manual controller instead.
  const effectiveSignal = anySignal([signal, AbortSignal.timeout(timeoutMs)]);

  if (!baseUrl) throw new Error("llm: baseUrl is required");
  if (!model) throw new Error("llm: model is required");

  const url = joinUrl(baseUrl, "/chat/completions");
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages,
    ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
    stream: false,
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: effectiveSignal,
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`llm: request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`llm: request to ${url} failed: ${err.message}`);
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`llm: ${res.status} ${res.statusText} from ${url}: ${text}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`llm: invalid JSON from ${url}: ${err.message}`);
  }

  const choice = json.choices?.[0];
  if (!choice) {
    throw new Error(`llm: response has no choices: ${JSON.stringify(json).slice(0, 400)}`);
  }

  return {
    message: normaliseAssistantMessage(choice.message),
    finishReason: choice.finish_reason || null,
    usage: json.usage || null,
    raw: json,
  };
}

// Local models occasionally emit a malformed assistant message: tool_calls
// that aren't an array, arguments that aren't a string, content as an array of
// parts, or a missing role. Normalise into the shape the loop expects so a bad
// response degrades gracefully instead of crashing deep in tool dispatch.
function normaliseAssistantMessage(message) {
  const m = message && typeof message === "object" ? { ...message } : {};
  m.role = "assistant";
  if (Array.isArray(m.content)) {
    m.content = m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
  } else if (m.content != null && typeof m.content !== "string") {
    m.content = String(m.content);
  }
  if (m.tool_calls != null && !Array.isArray(m.tool_calls)) {
    delete m.tool_calls;
  }
  if (Array.isArray(m.tool_calls)) {
    m.tool_calls = m.tool_calls.filter(
      (tc) => tc && tc.function && typeof tc.function.name === "string",
    );
    for (const tc of m.tool_calls) {
      if (typeof tc.function.arguments !== "string") {
        tc.function.arguments =
          tc.function.arguments == null ? "{}" : JSON.stringify(tc.function.arguments);
      }
      if (!tc.id) tc.id = `call_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    }
    if (m.tool_calls.length === 0) delete m.tool_calls;
  }
  if (m.content == null && !m.tool_calls) m.content = "";
  return m;
}

/**
 * Ping /models to verify a baseUrl is reachable and speaks the OpenAI API.
 * Returns the list of model IDs (may be empty for some servers).
 */
export async function listModels({ baseUrl, apiKey, signal, timeoutMs = 30000 }) {
  const url = joinUrl(baseUrl, "/models");
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  // A hung server must not block the ping forever (the chat() path has a
  // deadline; listModels needs one too).
  const res = await fetch(url, { headers, signal: anySignal([signal, AbortSignal.timeout(timeoutMs)]) });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`llm: ${res.status} ${res.statusText} from ${url}: ${text}`);
  }
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m.id).filter(Boolean);
}

// AbortSignal.any() was added in Node.js 20.3 / 18.17; write our own so
// we stay compatible with older Node versions that ship with some CC builds.
// Returns a signal that aborts when any of the non-null inputs abort.
function anySignal(signals) {
  const live = signals.filter(Boolean);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  // Fast path: already aborted.
  const already = live.find((s) => s.aborted);
  if (already) return already;
  const controller = new AbortController();
  const abort = (reason) => controller.abort(reason);
  for (const sig of live) {
    // Pass controller.signal so listeners self-remove once we abort.
    sig.addEventListener("abort", () => abort(sig.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

function joinUrl(base, path) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : "/" + path;
  return b + p;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
