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

/**
 * @typedef {Object} ChatRequest
 * @property {string} baseUrl       — e.g. http://localhost:1234/v1
 * @property {string|null} apiKey   — optional; many local servers ignore it
 * @property {string} model
 * @property {Array<object>} messages
 * @property {Array<object>} [tools]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
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
    signal,
  } = req;

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
      signal,
    });
  } catch (err) {
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
    message: choice.message || { role: "assistant", content: "" },
    finishReason: choice.finish_reason || null,
    usage: json.usage || null,
    raw: json,
  };
}

/**
 * Ping /models to verify a baseUrl is reachable and speaks the OpenAI API.
 * Returns the list of model IDs (may be empty for some servers).
 */
export async function listModels({ baseUrl, apiKey, signal }) {
  const url = joinUrl(baseUrl, "/models");
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`llm: ${res.status} ${res.statusText} from ${url}: ${text}`);
  }
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m.id).filter(Boolean);
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
