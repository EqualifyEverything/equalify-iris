import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Store } from "../src/store/db.ts";
import { statsRouter, DEFAULT_TTL_MS } from "../src/routes/stats.ts";

// The store side of `GET /v1/stats` is covered in test/stats.test.ts, and e2e step
// 7b covers one real uncached response with no token. This covers the part neither
// of them can see: the route's cache.
//
// That cache is the stated reason it is acceptable for an unauthenticated caller to
// trigger a full scan of the sessions table, which makes it a load-bearing claim
// rather than an optimization. Without these assertions `>= ttlMs` could become
// `<= ttlMs` (recompute every request — the scan-per-request the cache exists to
// prevent), or the `Cache-Control` header could be dropped, and the unit tests, the
// typecheck and the e2e would all still pass.

// A store that records how many times it was actually consulted, and can change its
// answer between reads. Only `publicStats` is reachable from this router, so nothing
// else needs to exist.
function fakeStore(initial: { pages: number; documents: number; since: string | null }) {
  const state = { calls: 0, value: initial };
  const store = {
    publicStats() {
      state.calls++;
      return state.value;
    },
  } as unknown as Store;
  return { store, state };
}

async function serve(router: express.Router): Promise<{
  get: (query?: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
}> {
  const app = express();
  app.use("/v1/stats", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/stats`;
  return { get: (query = "", init) => fetch(base + query, init), close: () => server.close() };
}

const STATS = { pages: 40, documents: 3, since: "2026-01-01T00:00:00.000Z" };

test("the tally is served from cache within the TTL, and recomputed after it", async () => {
  const { store, state } = fakeStore(STATS);
  // 200ms rather than the production minute: the branch is the same, and a test
  // that has to wait 60s to assert expiry is a test nobody runs. Long enough that
  // two localhost round-trips inside the window are not a coin flip.
  const srv = await serve(statsRouter(store, { ttlMs: 200 }));
  try {
    const first = await srv.get();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      pages_processed: 40,
      documents_processed: 3,
      since: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(state.calls, 1, "the first request must actually query the store");

    // Change what the store would say, so a second query is detectable in the
    // body and not only in the counter.
    state.value = { pages: 999, documents: 99, since: "2026-01-01T00:00:00.000Z" };
    const second = await srv.get();
    assert.equal(state.calls, 1, "a request inside the TTL re-queried the store");
    assert.equal((await second.json()).pages_processed, 40, "the cached body was not served");

    await new Promise((r) => setTimeout(r, 250));
    const third = await srv.get();
    assert.equal(state.calls, 2, "a request after the TTL did not recompute");
    assert.equal((await third.json()).pages_processed, 999, "the recomputed body was not served");
  } finally {
    srv.close();
  }
});

test("the response carries Cache-Control matching the TTL", async () => {
  const { store } = fakeStore(STATS);
  const srv = await serve(statsRouter(store));
  try {
    const res = await srv.get();
    // Shared caches are asked for the same lifetime the in-process cache uses, so
    // a CDN in front of this deployment does not serve a tally staler than the
    // origin would.
    assert.equal(res.headers.get("cache-control"), `public, max-age=${DEFAULT_TTL_MS / 1000}`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    srv.close();
  }
});

test("an empty deployment answers 200 with zeros rather than an error", async () => {
  // The demo page hides its line on a zero, but that is the client's decision to
  // make — the endpoint has to give it a well-formed number to decide from, and a
  // fresh deployment is the first thing anyone runs.
  const { store } = fakeStore({ pages: 0, documents: 0, since: null });
  const srv = await serve(statsRouter(store));
  try {
    const res = await srv.get();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pages_processed: 0, documents_processed: 0, since: null });
  } finally {
    srv.close();
  }
});

test("no request-derived value reaches the response", async () => {
  // The endpoint is unauthenticated and takes no parameters. Asserting it ignores
  // query strings and headers keeps a future "?since=" or per-caller variation
  // from quietly turning a cached public aggregate into a per-request answer —
  // which would also make the single shared cache entry wrong for everyone.
  const { store, state } = fakeStore(STATS);
  const srv = await serve(statsRouter(store));
  try {
    const plain = await (await srv.get()).json();
    const withJunk = await srv.get("?limit=1&user=99&session_id=ses_x", {
      headers: { "x-forwarded-for": "1.2.3.4", authorization: "Bearer nope" },
    });
    assert.deepEqual(await withJunk.json(), plain, "a query string or header changed the response");
    assert.equal(state.calls, 1, "the query string bypassed the shared cache entry");
  } finally {
    srv.close();
  }
});
