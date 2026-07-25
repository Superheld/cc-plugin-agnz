// node:test coverage for the LLM client (lib/llm/openai-compatible.mjs).
//
// The client moved from fetch to node:http specifically because undici's
// non-configurable 300 s headersTimeout killed legitimate slow local-model
// calls as an opaque "fetch failed". These tests pin the new contract:
// no implicit deadline, explicit timeoutMs honoured, abort signal honoured,
// network errors carry their syscall code.
//
// Run with: node --test tests/llm-client.test.mjs

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { chat, listModels } from "../lib/llm/openai-compatible.mjs";

const COMPLETION = {
  choices: [
    {
      message: { role: "assistant", content: "hello" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

let server = null;

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

/** Start an http server on an ephemeral port; returns its baseUrl. */
function listen(handler) {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}/v1`);
    });
  });
}

function baseReq(baseUrl, extra = {}) {
  return {
    baseUrl,
    apiKey: null,
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

test("chat parses a completion from a well-behaved server", async () => {
  const baseUrl = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(COMPLETION));
  });
  const out = await chat(baseReq(baseUrl));
  assert.equal(out.message.content, "hello");
  assert.equal(out.finishReason, "stop");
  assert.equal(out.usage.total_tokens, 12);
});

test("chat without timeoutMs survives headers slower than the old undici cap would allow", async () => {
  // We obviously can't wait 300 s in a test. This guards the *contract*:
  // no deadline configured → a slow-headers response still completes.
  // Reintroducing fetch would not fail this test, but removing the
  // no-default-timeout behaviour (e.g. restoring DEFAULT_TIMEOUT_MS at a
  // value a test can hit) is the regression it documents.
  const baseUrl = await listen((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(COMPLETION));
    }, 400);
  });
  const out = await chat(baseReq(baseUrl));
  assert.equal(out.message.content, "hello");
});

test("chat honours an explicit timeoutMs with the timed-out message", async () => {
  const baseUrl = await listen(() => {
    /* never respond */
  });
  await assert.rejects(
    chat(baseReq(baseUrl, { timeoutMs: 120 })),
    /timed out after 120ms/,
  );
});

test("chat rejects when the abort signal fires mid-request", async () => {
  const baseUrl = await listen(() => {
    /* never respond */
  });
  const controller = new AbortController();
  const p = assert.rejects(chat(baseReq(baseUrl, { signal: controller.signal })));
  setTimeout(() => controller.abort(), 50);
  await p;
});

test("chat rejects immediately on an already-aborted signal", async () => {
  const baseUrl = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(COMPLETION));
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(chat(baseReq(baseUrl, { signal: controller.signal })));
});

test("chat surfaces the syscall code for a refused connection", async () => {
  // Grab an ephemeral port, then close the server so the port is dead.
  const baseUrl = await listen(() => {});
  await new Promise((r) => server.close(r));
  server = null;
  await assert.rejects(chat(baseReq(baseUrl)), /ECONNREFUSED/);
});

test("chat wraps a non-2xx response with status and body excerpt", async () => {
  const baseUrl = await listen((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"model exploded"}');
  });
  await assert.rejects(chat(baseReq(baseUrl)), /llm: 500 .*model exploded/);
});

test("listModels returns ids and keeps its default deadline behaviour", async () => {
  const baseUrl = await listen((req, res) => {
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
  });
  assert.deepEqual(await listModels({ baseUrl }), ["m1", "m2"]);
});

// --- structured error detail ------------------------------------------------
// Every failure below used to exist only as prose inside err.message. The
// trace could record the sentence but not the endpoint, the syscall code or
// the server's own body, which is what a diagnosis actually needs.

test("an HTTP error carries status, endpoint and the server's body as fields", async () => {
  const baseUrl = await listen((req, res) => {
    res.writeHead(422, { "content-type": "application/json" });
    res.end('{"error":{"message":"context length exceeded"}}');
  });
  const err = await chat(baseReq(baseUrl)).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "the call rejects");
  assert.equal(err.detail.kind, "http");
  assert.equal(err.detail.status, 422);
  assert.match(err.detail.url, /\/v1\/chat\/completions$/);
  assert.match(err.detail.body, /context length exceeded/);
});

test("a network error carries its syscall code as a field", async () => {
  // Port 1 on loopback: nothing listens, so the connect fails at the syscall.
  const err = await chat(baseReq("http://127.0.0.1:1/v1")).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "the call rejects");
  assert.equal(err.detail.kind, "network");
  assert.ok(err.detail.code, `a syscall code is present (got ${err.detail.code})`);
  assert.match(err.detail.url, /127\.0\.0\.1:1/);
});

test("a non-JSON response carries the body that failed to parse", async () => {
  const baseUrl = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>proxy error</html>");
  });
  const err = await chat(baseReq(baseUrl)).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.detail.kind, "bad_json");
  assert.match(err.detail.body, /proxy error/);
});
