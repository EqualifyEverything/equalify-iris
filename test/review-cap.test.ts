import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.ts";
import { normalizeReviewIterations, DEFAULT_MAX_REVIEW_ITERATIONS } from "../src/config.ts";

// `defaults.max_review_iterations` is the ONLY input to the review cap: the
// per-request `config` override was removed, so this one config
// value seeds every account default, which every session then inherits. That makes
// the values it must not silently become the whole point of normalizing it — and
// two of them fail in ways nothing else in the system would report:
//
//   null  -> reaches a NOT NULL column and every FIRST LOGIN on the deployment
//            fails as `401 unauthorized: Token validation failed` (a config typo
//            reported as the caller's token being bad)
//   0/-1  -> the review loop stops reviewing: 0 buys one reader pass with no fix
//            ever applied, a negative skips review outright
//
// Both are silent in the sense that matters: the service keeps answering, and
// documents come back looking converted.

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "iris-cap-"));
  try {
    fn(new Store(join(dir, "iris.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("review cap: missing or non-numeric falls back to the default", () => {
  assert.equal(normalizeReviewIterations(undefined), DEFAULT_MAX_REVIEW_ITERATIONS);
  assert.equal(normalizeReviewIterations("banana"), DEFAULT_MAX_REVIEW_ITERATIONS);
  assert.equal(normalizeReviewIterations(NaN), DEFAULT_MAX_REVIEW_ITERATIONS);
});

test("review cap: a valueless YAML key means the default, not zero", () => {
  // `max_review_iterations:` with nothing after it parses as null, and Number(null)
  // is 0 — which is finite, so it would otherwise floor to 1 and quietly buy the
  // deployment a single reader pass per document.
  assert.equal(normalizeReviewIterations(null), DEFAULT_MAX_REVIEW_ITERATIONS);
  assert.equal(normalizeReviewIterations(""), DEFAULT_MAX_REVIEW_ITERATIONS);
  assert.equal(normalizeReviewIterations("   "), DEFAULT_MAX_REVIEW_ITERATIONS);
});

test("review cap: floored to a cap that still reviews", () => {
  assert.equal(normalizeReviewIterations(0), 1, "0 would apply no fix at all");
  assert.equal(normalizeReviewIterations(-5), 1, "a negative would skip review outright");
  assert.equal(normalizeReviewIterations(3), 3, "a sane value passes through");
  assert.equal(normalizeReviewIterations(2.9), 2, "floored, not rounded");
  assert.equal(normalizeReviewIterations("4"), 4, "numeric strings from YAML are accepted");
});

test("review cap: no ceiling — a deliberately high cap is not silently reduced", () => {
  // Unlike the two concurrency knobs, rounds are sequential: a big number costs the
  // operator who chose it latency and tokens, and does not over-subscribe the
  // machine and degrade every other run. Capping it would be the surprise.
  assert.equal(normalizeReviewIterations(50), 50);
});

test("review cap: the normalized value is what makes a first login survive", () => {
  withStore((store) => {
    // The failure this prevents, spelled out: null straight from YAML reaches the
    // NOT NULL column, and makeAuthMiddleware turns the throw into a 401 about the
    // user's token. Asserted rather than described, so a future change that drops
    // the guard in loadConfig fails here instead of in production on first login.
    assert.throws(
      () =>
        store.upsertUser({ github_user_id: 1, github_login: "raw" }, null as unknown as number),
      /NOT NULL/,
      "an unnormalized null must still be rejected by the column — that is the trap",
    );

    const user = store.upsertUser(
      { github_user_id: 2, github_login: "normalized" },
      normalizeReviewIterations(null),
    );
    assert.equal(user.max_review_iterations, DEFAULT_MAX_REVIEW_ITERATIONS);
  });
});
