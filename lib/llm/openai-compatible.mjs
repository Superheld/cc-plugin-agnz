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
// How much of a server response body travels with an error. Long enough for a
// real stack or validation payload, short enough to keep a trace line readable.
const MAX_ERROR_BODY = 2000;

// Syscall codes worth trying again: the network hiccuped, nothing is wrong with
// the request. Field case (2026-07-25): a Mac on Wi-Fi talking to a LAN
// inference box got intermittent EHOSTUNREACH — an ARP re-resolution that the
// access point did not answer in time, while ping and a probe seconds either
// side both succeeded. A 40-turn run dying on a sub-second ARP gap is waste.
//
// ECONNREFUSED is deliberately NOT here: it means nothing is listening, which
// is a real answer (wrong port, server down) and retrying only delays it.
// Neither is our own TimeoutError — a slow model is working, not broken, and
// re-asking would put a second generation on a busy server.
//
// Retrying a POST is safe here because these failures happen at connect, before
// anything was sent; a chat completion has no server-side effect to duplicate.
const TRANSIENT_CODES = new Set([
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
]);

const RETRY_BACKOFF_MS = [250, 1000];

// Private IPv4 ranges — a host we should be able to reach without leaving the LAN.
const PRIVATE_HOST = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * macOS blocks an unapproved binary from reaching other hosts on the local
 * network and reports it as an INSTANT EHOSTUNREACH — indistinguishable from a
 * real routing failure unless you notice the timing.
 *
 * Cost us an hour on 2026-07-25: curl reached the inference box, node did not,
 * from the same shell, deterministically. Node reached the internet and the
 * gateway fine (both exempt), only LAN peers were refused. The trigger was a
 * Homebrew node upgrade — the permission is granted per executable, so a new
 * binary starts unapproved.
 *
 * Only hinted for private addresses, and only on macOS, so a genuine routing
 * problem on a public host is not given a misleading explanation.
 */
function hostUnreachableHint(err, url) {
  if (err.code !== "EHOSTUNREACH" || process.platform !== "darwin") return "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  if (!PRIVATE_HOST.test(host)) return "";
  return (
    ` — the host is on your local network and this failed instantly, which on macOS usually means ` +
    `node lacks Local Network permission rather than the host being down ` +
    `(System Settings > Privacy & Security > Local Network; the grant is per binary, so a node upgrade revokes it). ` +
    `Compare: curl ${url}`
  );
}

/**
 * requestJson with bounded retries on transient network failures.
 *
 * @param {function} onRetry — called as ({attempt, code, delayMs}) before each
 *   wait, so the caller can record that the harness papered over something.
 *   A run that only succeeded on the third try should not look clean.
 */
async function requestWithRetry(url, opts, onRetry) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await requestJson(url, opts);
    } catch (err) {
      lastErr = err;
      const retriable =
        TRANSIENT_CODES.has(err.code) &&
        err.name !== "TimeoutError" &&
        !opts.signal?.aborted &&
        attempt < RETRY_BACKOFF_MS.length;
      if (!retriable) throw err;
      const delayMs = RETRY_BACKOFF_MS[attempt];
      try {
        onRetry?.({ attempt: attempt + 1, code: err.code, delayMs });
      } catch {
        // a logging failure must not turn a recoverable hiccup into an error
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * An Error carrying machine-readable detail alongside the human message.
 *
 * Every failure mode here used to exist ONLY as prose in err.message: the
 * syscall code, the HTTP status and the server's own body were formatted into
 * a string and then had nowhere to go but a status field. The trace could not
 * record which endpoint was tried or why, which is exactly what a
 * host-unreachable or a 400-from-the-server needs at diagnosis time.
 *
 * `detail.kind` is the discriminator: "network" | "timeout" | "http" |
 * "bad_json" | "no_choices".
 */
function llmError(message, detail) {
  const err = new Error(message);
  err.detail = detail;
  return err;
}

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
    res = await requestWithRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body), timeoutMs, signal },
      req.onRetry,
    );
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw llmError(`llm: request to ${url} timed out after ${timeoutMs}ms`, {
        kind: "timeout",
        url,
        timeoutMs,
      });
    }
    // Surface the syscall code (ECONNREFUSED, ETIMEDOUT, …) — fetch used to
    // swallow it in err.cause, which cost us a debugging session once.
    const code = err.code && !String(err.message).includes(err.code) ? ` (${err.code})` : "";
    throw llmError(`llm: request to ${url} failed: ${err.message}${code}${hostUnreachableHint(err, url)}`, {
      kind: "network",
      url,
      code: err.code ?? null,
    });
  }

  if (res.status < 200 || res.status >= 300) {
    throw llmError(`llm: ${res.status} ${res.statusText} from ${url}: ${res.text.slice(0, 500)}`, {
      kind: "http",
      url,
      status: res.status,
      statusText: res.statusText,
      body: res.text.slice(0, MAX_ERROR_BODY),
    });
  }

  let json;
  try {
    json = JSON.parse(res.text);
  } catch (err) {
    throw llmError(`llm: invalid JSON from ${url}: ${err.message}`, {
      kind: "bad_json",
      url,
      body: res.text.slice(0, MAX_ERROR_BODY),
    });
  }

  const choice = json.choices?.[0];
  if (!choice) {
    throw llmError(`llm: response has no choices: ${JSON.stringify(json).slice(0, 400)}`, {
      kind: "no_choices",
      url,
      body: JSON.stringify(json).slice(0, MAX_ERROR_BODY),
    });
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
export async function listModels({ baseUrl, apiKey, signal, timeoutMs = 30000, onRetry }) {
  const url = joinUrl(baseUrl, "/models");
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  // Same wrapping as chat(): this is the reachability probe, so it is the one
  // call whose network failure a user actually reads. Unwrapped, it reached the
  // log as a bare syscall message with no endpoint and no code to key on.
  let res;
  try {
    res = await requestWithRetry(url, { method: "GET", headers, timeoutMs, signal }, onRetry);
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw llmError(`llm: request to ${url} timed out after ${timeoutMs}ms`, {
        kind: "timeout",
        url,
        timeoutMs,
      });
    }
    const code = err.code && !String(err.message).includes(err.code) ? ` (${err.code})` : "";
    throw llmError(`llm: request to ${url} failed: ${err.message}${code}${hostUnreachableHint(err, url)}`, {
      kind: "network",
      url,
      code: err.code ?? null,
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw llmError(`llm: ${res.status} ${res.statusText} from ${url}: ${res.text.slice(0, 500)}`, {
      kind: "http",
      url,
      status: res.status,
      statusText: res.statusText,
      body: res.text.slice(0, MAX_ERROR_BODY),
    });
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
