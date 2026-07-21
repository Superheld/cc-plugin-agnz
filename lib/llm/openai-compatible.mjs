// Thin client for OpenAI-compatible /v1/chat/completions endpoints.
// Works with LM Studio, Ollama (via its OpenAI-compat endpoint), OpenRouter,
// vLLM, llama.cpp server, DeepSeek, real OpenAI, etc.
//
// Built on node:http/https rather than fetch — deliberately. Node's fetch
// (undici) enforces a non-overridable-without-deps 300 s headersTimeout;
// with stream:false a local model that spends >5 min on cold-load + a
// large-context completion gets its connection killed as an opaque
// "fetch failed" long before any configured llmTimeoutMs fires. node:http
// has no implicit deadline, so the request runs as long as the model needs.
//
// There is NO default timeout. Local cold-loads and big-context turns are
// legitimately slow, and a truly hung server does not zombify anything:
// the runner is killable (`agnz interrupt`/`stop`) and a dead peer
// eventually fails at the TCP layer. A profile can still opt in to a
// deadline via llmTimeoutMs.
//
// The client is intentionally dumb: it takes a fully-formed messages array
// and a tools array (already in OpenAI format) and returns the raw
// assistant message. The agent loop is responsible for deciding what to do
// with tool_calls.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * @typedef {Object} ChatRequest
 * @property {string} baseUrl       — e.g. http://localhost:1234/v1
 * @property {string|null} apiKey   — optional; many local servers ignore it
 * @property {string} model
 * @property {Array<object>} messages
 * @property {Array<object>} [tools]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {number} [timeoutMs]   — per-request deadline; 0/absent = none
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
    timeoutMs = 0,
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
    res = await requestJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      timeoutMs,
      signal,
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`llm: request to ${url} timed out after ${timeoutMs}ms`);
    }
    // Surface the syscall code (ECONNREFUSED, ETIMEDOUT, …) — fetch used to
    // swallow it in err.cause, which cost us a debugging session once.
    const code = err.code && !String(err.message).includes(err.code) ? ` (${err.code})` : "";
    throw new Error(`llm: request to ${url} failed: ${err.message}${code}`);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`llm: ${res.status} ${res.statusText} from ${url}: ${res.text.slice(0, 500)}`);
  }

  let json;
  try {
    json = JSON.parse(res.text);
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
 * Unlike chat(), this keeps a default deadline — it is a health check, and
 * "the ping hangs" is exactly the failure it exists to report quickly.
 */
export async function listModels({ baseUrl, apiKey, signal, timeoutMs = 30000 }) {
  const url = joinUrl(baseUrl, "/models");
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await requestJson(url, { method: "GET", headers, timeoutMs, signal });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`llm: ${res.status} ${res.statusText} from ${url}: ${res.text.slice(0, 500)}`);
  }
  const json = JSON.parse(res.text);
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m.id).filter(Boolean);
}

/**
 * One HTTP request → { status, statusText, text }. Rejects on network
 * error, on abort (with signal.reason), and on deadline (err.name
 * "TimeoutError") when timeoutMs > 0. The deadline spans the whole
 * request — connect, headers, and body — matching what the old
 * AbortSignal.timeout covered.
 */
function requestJson(url, { method, headers = {}, body = null, timeoutMs = 0, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url);
    const doRequest = u.protocol === "https:" ? httpsRequest : httpRequest;

    // Some servers mishandle chunked encoding; send an explicit length.
    if (body != null) headers = { ...headers, "content-length": Buffer.byteLength(body) };

    let timer = null;
    let onAbort = null;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // The loop reuses one AbortSignal across every turn's chat() call —
      // without this removal the listeners would pile up run-long.
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };

    const req = doRequest(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          settle(resolvePromise, {
            status: res.statusCode,
            statusText: res.statusMessage || "",
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", (err) => settle(rejectPromise, err));
      },
    );

    req.on("error", (err) => settle(rejectPromise, err));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`timed out after ${timeoutMs}ms`);
        err.name = "TimeoutError";
        req.destroy(err); // surfaces via the 'error' handler above
      }, timeoutMs);
    }

    if (signal) {
      const abortErr = () =>
        signal.reason instanceof Error ? signal.reason : new Error("aborted");
      if (signal.aborted) {
        const err = abortErr();
        req.destroy(err);
        settle(rejectPromise, err);
        return;
      }
      onAbort = () => req.destroy(abortErr());
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (body != null) req.write(body);
    req.end();
  });
}

function joinUrl(base, path) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : "/" + path;
  return b + p;
}
