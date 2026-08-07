import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.ts";
import {
  makeAuthMiddleware,
  __clearTokenCache,
  __MAX_ENTRIES,
  __tokenCacheSize,
  __tokenCacheExpiry,
  __seedTokenCache,
} from "../src/auth/middleware.ts";
import type { IrisConfig } from "../src/config.ts";

// The token cache is a map of LIVE CREDENTIALS held in memory, keyed by the token
// itself, so its two bounds are security properties rather than memory hygiene:
//
//   * the 10k ceiling, which is what stops the map growing with every distinct token
//     for the lifetime of the process; and
//   * FIFO-not-LRU — a cache hit must NOT renew `expires`, because renewing on read
//     would let a busy token outlive its revocation indefinitely, which is the exact
//     failure the 5-minute TTL exists to bound.
//
// Neither is observable from outside: a bound that is off by one and a cache that
// renews on read both answer 200 to every request. So these drive the REAL middleware
// (a real request, a real `evict` call, a real store) and assert against the module's
// test-only introspection, rather than through a behavioral proxy that would pass
// either way.

const GH_USER = { id: 7788, login: "cache-tester" };

// Every token this mock is willing to identify. Unlike the token-not-stored harness
// (one fixed token), the ceiling test needs thousands of DISTINCT accepted tokens.
function seedToken(i: number): string {
  return `gho_seed_${i}`;
}

async function mockGitHub(): Promise<{ base: string; close: () => void; calls: () => number }> {
  const app = express();
  const state = { calls: 0 };
  app.get("/user", (req, res) => {
    state.calls++;
    if (!/^Bearer gho_/.test(req.header("authorization") ?? "")) {
      res.status(401).json({ message: "Bad credentials" });
      return;
    }
    res.json(GH_USER);
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
    calls: () => state.calls,
  };
}

// A real express app with the real auth middleware in front of a trivial handler, so
// each `fetch` below runs the actual cache-hit / cache-miss branch.
async function harness(): Promise<{
  get: (token: string) => Promise<number>;
  ghCalls: () => number;
  close: () => void;
}> {
  __clearTokenCache();
  const dir = mkdtempSync(join(tmpdir(), "iris-cache-"));
  const gh = await mockGitHub();
  const store = new Store(join(dir, "iris.sqlite"));
  const cfg = {
    github: { api_base_url: gh.base, upstream_repo: "https://github.com/example/iris" },
    defaults: { max_review_iterations: 3 },
  } as unknown as IrisConfig;

  const app = express();
  app.use(makeAuthMiddleware(store, cfg));
  app.get("/ping", (_req, res) => void res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    get: async (token: string) => {
      const res = await fetch(`${base}/ping`, { headers: { Authorization: `Bearer ${token}` } });
      return res.status;
    },
    ghCalls: gh.calls,
    close: () => {
      server.close();
      gh.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the cache never exceeds its ceiling, even when nothing has expired", async () => {
  const h = await harness();
  try {
    // Fill to exactly the ceiling with UNEXPIRED entries, so the expiry sweep has
    // nothing to collect and the size-based branch is the only thing that can hold the
    // bound. (Seeded rather than requested: 10k real HTTP round-trips to prove a
    // constant is not worth the wall-clock.)
    const future = Date.now() + 60_000;
    for (let i = 0; i < __MAX_ENTRIES; i++) __seedTokenCache(seedToken(i), GH_USER.id, future);
    assert.equal(__tokenCacheSize(), __MAX_ENTRIES, "seeding did not fill the cache");

    // One real request with a token that is NOT in the cache: a miss, so the
    // middleware calls evict() and then inserts.
    assert.equal(await h.get("gho_the_new_one"), 200);

    assert.ok(
      __tokenCacheSize() <= __MAX_ENTRIES,
      `cache holds ${__tokenCacheSize()} entries, above the ${__MAX_ENTRIES} ceiling — ` +
        `eviction ran but did not make room for the insert (the "+1" in evict's excess)`,
    );
    // The oldest insertion is the one that went, and the new token is present: this is
    // the FIFO direction, and it distinguishes "evicted something" from "evicted the
    // entry we just added".
    assert.equal(__tokenCacheExpiry(seedToken(0)), undefined, "the oldest entry survived eviction");
    assert.notEqual(__tokenCacheExpiry("gho_the_new_one"), undefined, "the new entry was evicted instead");
  } finally {
    h.close();
  }
});

test("expired entries are collected before unexpired ones", async () => {
  const h = await harness();
  try {
    // Below the ceiling, so ONLY the expiry sweep can run. An expired entry must be
    // gone after the next request even though there is no size pressure at all —
    // otherwise a revoked token's entry lingers until the map fills.
    const past = Date.now() - 1;
    const future = Date.now() + 60_000;
    __seedTokenCache("gho_expired", GH_USER.id, past);
    __seedTokenCache("gho_fresh", GH_USER.id, future);

    assert.equal(await h.get("gho_trigger"), 200);

    assert.equal(__tokenCacheExpiry("gho_expired"), undefined, "an expired entry survived the sweep");
    assert.equal(__tokenCacheExpiry("gho_fresh"), future, "an unexpired entry was collected");
  } finally {
    h.close();
  }
});

test("a cache hit does not renew the entry, so a token cannot outlive its revocation", async () => {
  const h = await harness();
  try {
    // First request: a miss, so GitHub is consulted once and the entry is written.
    assert.equal(await h.get("gho_hot"), 200);
    assert.equal(h.ghCalls(), 1);
    const firstExpiry = __tokenCacheExpiry("gho_hot");
    assert.notEqual(firstExpiry, undefined, "the first request did not populate the cache");

    // Hammer it. Every one of these is a cache HIT — GitHub is not consulted again,
    // which is what the cache is for.
    for (let i = 0; i < 5; i++) assert.equal(await h.get("gho_hot"), 200);
    assert.equal(h.ghCalls(), 1, "a cached token was re-validated against GitHub");

    // ...and the deadline has not moved. This is the assertion that fails if someone
    // converts this to an LRU: under LRU those five hits would each push `expires`
    // out, and a token revoked at github.com would keep working for as long as its
    // holder kept using it, instead of for at most TTL_MS.
    assert.equal(
      __tokenCacheExpiry("gho_hot"),
      firstExpiry,
      "a cache hit renewed the entry's expiry — the cache is now LRU, and a busy token " +
        "outlives its revocation for as long as it stays busy",
    );
  } finally {
    h.close();
  }
});

test("an expired entry is re-validated against GitHub rather than trusted", async () => {
  const h = await harness();
  try {
    // The other half of the TTL contract: expiring is only useful if the next request
    // actually goes back to GitHub. Seed an entry that is already past its deadline
    // and confirm the request is a MISS (a second /user call), not a hit on stale state.
    __seedTokenCache("gho_stale", GH_USER.id, Date.now() - 1);
    assert.equal(h.ghCalls(), 0);

    assert.equal(await h.get("gho_stale"), 200);

    assert.equal(h.ghCalls(), 1, "an expired entry was served from cache without re-validation");
    assert.ok((__tokenCacheExpiry("gho_stale") ?? 0) > Date.now(), "the re-validated entry was not refreshed");
  } finally {
    h.close();
  }
});
