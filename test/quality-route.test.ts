import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { QualityStats, Store } from "../src/store/db.ts";
import { qualityRouter } from "../src/routes/quality.ts";

// The route half of `GET /v1/quality` (PRD §7.16). test/quality.test.ts covers what
// the numbers mean; this covers the two things only the route decides — who is let in,
// and whether a window's answer can be served for a different window.
//
// The guard is the part worth pinning. Unlike every other endpoint this one is not
// behind the GitHub auth middleware (the data belongs to no user, and the caller is a
// CI job), so its shared secret is the ONLY thing standing between a deployment-wide
// quality report and anyone who guesses the path. A regression here is invisible: the
// endpoint keeps answering correctly for the workflow either way.

const TOKEN = "s3cret-quality-token";

function fakeStore(): { store: Store; state: { calls: number; days: number[] } } {
  const state = { calls: 0, days: [] as number[] };
  const store = {
    qualityStats({ days }: { days?: number } = {}) {
      state.calls++;
      // The route is expected to have clamped already, so this mirror of the clamp
      // should be a no-op on everything it receives — which is exactly what makes
      // `state.days` worth asserting: it records the window the query RAN under, and
      // the cache is required to be keyed on that same value.
      const w = Math.min(365, Math.max(1, Math.floor(Number(days)) || 30));
      state.days.push(w);
      return {
        window_days: w,
        documents: 10,
        since: "2026-01-01T00:00:00.000Z",
        mean_rounds: 1.5,
        unresolved_rate: 0.1,
        links_dropped_rate: 0,
        lint_error_rate: 0,
        documents_linted: 10,
        editor_truncated_rate: 0,
        review_unread_rate: 0,
        rules: [{ id: "heading-order", impact: "moderate", documents: 4, share: 0.4, nodes: 9 }],
      } satisfies QualityStats;
    },
  } as unknown as Store;
  return { store, state };
}

async function serve(router: express.Router): Promise<{
  get: (query?: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
}> {
  const app = express();
  app.use("/v1/quality", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/quality`;
  return { get: (query = "", init) => fetch(base + query, init), close: () => server.close() };
}

const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

test("an unconfigured deployment does not acknowledge the endpoint", async () => {
  const { store, state } = fakeStore();
  const srv = await serve(qualityRouter(store, {}));
  try {
    // 404 rather than 401 or 503, deliberately: a deployment that has not opted in
    // reveals nothing about whether the operator merely forgot a token. And a 404 with
    // no token configured must not be reachable by guessing one.
    for (const init of [undefined, auth]) {
      const res = await srv.get("", init);
      assert.equal(res.status, 404);
    }
    assert.equal(state.calls, 0, "and the table is never scanned for a caller that cannot read it");
  } finally {
    srv.close();
  }
});

test("a missing, malformed or wrong token is rejected without touching the store", async () => {
  const { store, state } = fakeStore();
  const srv = await serve(qualityRouter(store, { quality_token: TOKEN }));
  try {
    const rejected: (RequestInit | undefined)[] = [
      undefined,
      { headers: { authorization: "" } },
      { headers: { authorization: TOKEN } }, // no Bearer prefix
      { headers: { authorization: `Bearer ${TOKEN}x` } }, // right prefix, wrong token
      { headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}` } }, // one char short
      { headers: { authorization: "Bearer " } },
    ];
    for (const init of rejected) {
      const res = await srv.get("", init);
      assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(init ?? null)}`);
    }
    // The cost matters as much as the status: an unauthenticated caller must not be
    // able to make this deployment scan its signals table.
    assert.equal(state.calls, 0);
  } finally {
    srv.close();
  }
});

test("a valid token gets the tally, and the response is never shared-cached", async () => {
  const { store } = fakeStore();
  const srv = await serve(qualityRouter(store, { quality_token: TOKEN }));
  try {
    const res = await srv.get("", auth);
    assert.equal(res.status, 200);
    // no-store, unlike /v1/stats' public max-age: this response is gated by a secret,
    // and a proxy that cached it would hand it to a request presenting none.
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as QualityStats;
    assert.equal(body.documents, 10);
    assert.equal(body.rules[0].id, "heading-order");
  } finally {
    srv.close();
  }
});

test("the bearer prefix is matched case-insensitively, as the header spec allows", async () => {
  const { store } = fakeStore();
  const srv = await serve(qualityRouter(store, { quality_token: TOKEN }));
  try {
    const res = await srv.get("", { headers: { authorization: `bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
  } finally {
    srv.close();
  }
});

test("each window is cached separately, so one window's answer is never served for another", async () => {
  const { store, state } = fakeStore();
  const srv = await serve(qualityRouter(store, { quality_token: TOKEN }, { ttlMs: 60_000 }));
  try {
    const a = (await (await srv.get("?days=30", auth)).json()) as QualityStats;
    const b = (await (await srv.get("?days=90", auth)).json()) as QualityStats;
    assert.equal(a.window_days, 30);
    // The bug a single-slot cache would produce: 90 days answered with 30-day numbers,
    // wrong in a way nothing in the response reveals — which is why the window is
    // echoed back at all.
    assert.equal(b.window_days, 90);
    assert.equal(state.calls, 2);

    // ...and each is then genuinely cached.
    await srv.get("?days=30", auth);
    await srv.get("?days=90", auth);
    assert.equal(state.calls, 2, "a second read inside the TTL reuses the first answer");
  } finally {
    srv.close();
  }
});

test("windows that clamp to the same number share one cache entry", async () => {
  const { store, state } = fakeStore();
  const srv = await serve(qualityRouter(store, { quality_token: TOKEN }, { ttlMs: 60_000 }));
  try {
    // `days=0` and an absent `days` both mean 30 (the codebase's normalizer idiom), so
    // recomputing identical numbers under two keys would be pure waste.
    await srv.get("?days=0", auth);
    await srv.get("", auth);
    await srv.get("?days=30", auth);
    assert.equal(state.calls, 1);
    assert.deepEqual(state.days, [30]);
  } finally {
    srv.close();
  }
});

test("the cache cannot be grown past one entry per legal window", async () => {
  const { store, state } = fakeStore();
  const srv = await serve(qualityRouter(store, { quality_token: TOKEN }, { ttlMs: 60_000 }));
  try {
    // Every one of these is the same 365-day answer. Keying the cache on what was
    // ASKED for rather than what was served would add a permanent entry per distinct
    // query string, none of which is ever hit again — a caller holding the token could
    // grow the map without limit, and would recompute the tally every time while doing
    // it. Nothing evicts, so "bounded by the clamp" has to be true rather than stated.
    for (const q of ["?days=1000", "?days=1001", "?days=99999", "?days=365"]) {
      const body = (await (await srv.get(q, auth)).json()) as QualityStats;
      assert.equal(body.window_days, 365, `${q} should be answered with the maximum window`);
    }
    assert.equal(state.calls, 1, "one query for four requests that mean the same window");
    assert.deepEqual(state.days, [365]);

    // Same on the other end, including the garbled and negative cases the route is
    // deliberately lenient about.
    for (const q of ["?days=-5", "?days=nonsense", "?days=", "?days=0.4"]) {
      const body = (await (await srv.get(q, auth)).json()) as QualityStats;
      assert.ok(body.window_days === 1 || body.window_days === 30, `${q} gave ${body.window_days}`);
    }
    assert.ok(state.calls <= 3, `expected at most one entry per clamped window, got ${state.calls}`);
  } finally {
    srv.close();
  }
});

test("an expired entry is recomputed", async () => {
  const { store, state } = fakeStore();
  // ttlMs is why the cache is injectable: the production default is five minutes, and
  // the claim that a stuck workflow cannot scan the table per request has to be
  // asserted rather than assumed.
  const srv = await serve(qualityRouter(store, { quality_token: TOKEN }, { ttlMs: 1 }));
  try {
    await srv.get("", auth);
    await new Promise((r) => setTimeout(r, 5));
    await srv.get("", auth);
    assert.equal(state.calls, 2);
  } finally {
    srv.close();
  }
});
