import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_QUALITY_WINDOW_DAYS,
  SIGNAL_LINKS_DROPPED,
  SIGNAL_LINT_ERROR,
  SIGNAL_ROUNDS,
  SIGNAL_UNRESOLVED,
  Store,
  type RunSignal,
} from "../src/store/db.ts";

// The store half of `GET /v1/quality` (PRD §7.16): the tally the weekly workflow
// files issues from.
//
// What makes this worth testing rather than trusting is that every number here is
// about to be turned into a public claim about the app's quality, and the ways it can
// be wrong are all silent. A rate computed per-occurrence instead of per-document
// still looks like a percentage. A denominator that omits the clean documents still
// looks like a percentage — a much more alarming one. A feedback re-run that appends
// instead of replacing still looks like a percentage, biased upward on exactly the
// documents users asked Iris to retry. None of those show up as an error; they show
// up as a workflow filing an issue about a problem that is smaller than it says, or
// not filing one about a problem that is bigger.

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "iris-quality-"));
  try {
    fn(new Store(join(dir, "iris.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A delivered document, recorded the way the orchestrator records one: always a
// rounds signal (the denominator), plus whatever went wrong.
function delivered(store: Store, id: string, extra: RunSignal[] = [], rounds = 1): void {
  store.recordRunSignals(id, [{ code: SIGNAL_ROUNDS, count: rounds }, ...extra]);
}

test("an empty deployment reports zeroes rather than dividing by zero", () => {
  withStore((store) => {
    const q = store.qualityStats();
    assert.equal(q.documents, 0);
    assert.equal(q.since, null);
    assert.deepEqual(q.rules, []);
    // The one that matters: 0/0 is NaN, which serializes to `null` in JSON and would
    // reach the workflow's `>` comparison as a silent false — a threshold that can
    // never trip, on a deployment where nothing has run yet.
    for (const rate of [q.unresolved_rate, q.links_dropped_rate, q.lint_error_rate]) {
      assert.equal(rate, 0);
      assert.ok(Number.isFinite(rate), "a rate must be a number, not NaN");
    }
    // Distinct from a rate, and the one field where `null` is deliberate: 0 rounds is
    // a real and GOOD value (see below), so reporting 0 here would give a deployment
    // that has converted nothing the best score the metric can produce.
    assert.equal(q.mean_rounds, null);
  });
});

test("a flawless document still counts in the denominator", () => {
  withStore((store) => {
    // THE trap this whole design turns on. A clean run produces no rule rows and no
    // unresolved row, so counting documents by "has any signal" would divide by the
    // problem documents alone: one bad document among ten would be reported as 100%.
    for (const id of ["a", "b", "c", "d"]) delivered(store, id);
    delivered(store, "bad", [{ code: SIGNAL_UNRESOLVED, count: 3 }]);

    const q = store.qualityStats();
    assert.equal(q.documents, 5, "all five delivered documents are the denominator");
    assert.equal(q.unresolved_rate, 1 / 5);
  });
});

test("rule rates are per document, not per offending node", () => {
  withStore((store) => {
    // One pathological scan with 400 bad headings must not read as a worse rate than
    // two ordinary documents with one each. "Fails on 40% of documents" names a
    // prompt defect; "is 90% of our violations" moves when an unrelated rule is fixed.
    delivered(store, "huge", [{ code: "heading-order", impact: "moderate", count: 400 }]);
    delivered(store, "small", [{ code: "heading-order", impact: "moderate", count: 1 }]);
    delivered(store, "clean");

    const q = store.qualityStats();
    const rule = q.rules.find((r) => r.id === "heading-order")!;
    assert.equal(rule.documents, 2);
    assert.equal(rule.share, 2 / 3);
    // The per-node total is still available, alongside rather than folded in — a rule
    // can be rare and enormous or ubiquitous and trivial, and the two rank differently.
    assert.equal(rule.nodes, 401);
    assert.equal(rule.impact, "moderate");
  });
});

test("a feedback re-run replaces a document's signals instead of adding to them", () => {
  withStore((store) => {
    delivered(store, "clean-one");
    delivered(store, "retried", [
      { code: "heading-order", impact: "moderate", count: 2 },
      { code: SIGNAL_UNRESOLVED, count: 4 },
    ]);
    assert.equal(store.qualityStats().documents, 2, "precondition");

    // The user sends feedback and the re-run comes out clean.
    delivered(store, "retried");

    const q = store.qualityStats();
    // Appending would count this document twice — and re-run documents correlate with
    // badly-converted ones, so every rate would read high for a reason that has
    // nothing to do with the prompts.
    assert.equal(q.documents, 2, "the same session is one document however often it re-runs");
    // And the DELETE half: a rule that no longer fires has to disappear. An upsert
    // alone would leave the stale row, so a problem the feedback actually FIXED would
    // keep being reported as present.
    assert.deepEqual(q.rules, [], "signals from the superseded run are gone");
    assert.equal(q.unresolved_rate, 0);
  });
});

test("rounds are averaged over documents, and a re-run's rounds replace the old ones", () => {
  withStore((store) => {
    delivered(store, "a", [], 1);
    delivered(store, "b", [], 3);
    assert.equal(store.qualityStats().mean_rounds, 2);
    delivered(store, "b", [], 1);
    assert.equal(store.qualityStats().mean_rounds, 1);
  });
});

test("a document that needed no editor pass is a recorded 0, not an absent row", () => {
  withStore((store) => {
    // A round is an editor pass: the loop returns as soon as the Reader finds nothing,
    // so a document that reads clean on the first look completes with 0. Recording it
    // anyway is what keeps that document in the denominator — dropping a zero count as
    // "nothing to report" would remove the BEST documents from every rate below, and
    // the tally would get worse the better the pipeline got.
    delivered(store, "clean-first-look", [], 0);
    delivered(store, "needed-work", [{ code: SIGNAL_UNRESOLVED, count: 2 }], 2);

    const q = store.qualityStats();
    assert.equal(q.documents, 2);
    assert.equal(q.mean_rounds, 1);
    assert.equal(q.unresolved_rate, 1 / 2);

    // And all-zero has to be 0 rather than null, which is reserved for "nothing ran".
    delivered(store, "needed-work", [], 0);
    assert.equal(store.qualityStats().mean_rounds, 0);
  });
});

test("our own measurements never collide with an axe rule id", () => {
  withStore((store) => {
    // The `iris:` prefix is what keeps the two namespaces apart, and axe adds rules
    // between versions. A rule literally named "rounds" must be reported as a rule,
    // not counted as our denominator.
    delivered(store, "a", [
      { code: "rounds", impact: "serious", count: 1 },
      { code: "unresolved", impact: "serious", count: 1 },
    ]);
    const q = store.qualityStats();
    assert.equal(q.documents, 1, "the denominator comes from iris:rounds alone");
    assert.equal(q.unresolved_rate, 0, "a rule named 'unresolved' is not our signal");
    assert.deepEqual(
      q.rules.map((r) => r.id).sort(),
      ["rounds", "unresolved"],
      "and both are reported as the rules they are",
    );
  });
});

test("a linter that could not run is recorded, not inferred from silence", () => {
  withStore((store) => {
    // runAxe degrades to `{ ok: true, violations: [] }` when axe cannot run at all, so
    // a broken linter drives every accessibility rate to zero and reads as a deployment
    // that got better. This is the signal that tells the two apart.
    delivered(store, "broken", [{ code: SIGNAL_LINT_ERROR, count: 1 }]);
    delivered(store, "fine");
    const q = store.qualityStats();
    assert.equal(q.lint_error_rate, 1 / 2);
    assert.deepEqual(q.rules, [], "and it is not mistaken for a rule");
  });
});

test("dropped links are counted per document and per link", () => {
  withStore((store) => {
    delivered(store, "a", [{ code: SIGNAL_LINKS_DROPPED, count: 3 }]);
    delivered(store, "b");
    const q = store.qualityStats();
    assert.equal(q.links_dropped_rate, 1 / 2);
  });
});

test("the window is clamped, and echoed back so a caller sees what it got", () => {
  withStore((store) => {
    delivered(store, "a");
    assert.equal(store.qualityStats({ days: 1 }).window_days, 1);
    assert.equal(store.qualityStats({ days: 10_000 }).window_days, MAX_QUALITY_WINDOW_DAYS);
    assert.equal(store.qualityStats({ days: -5 }).window_days, 1);
    // Absent, unparseable and zero all mean "the default", the same way every other
    // normalizer in this codebase treats them (see config.ts) — a window of zero days
    // is not a measurement anyone wants and would report an empty deployment.
    for (const days of [undefined, NaN, 0]) {
      assert.equal(store.qualityStats({ days }).window_days, 30, `days=${days}`);
    }
  });
});

test("the window excludes older documents from both halves of every rate", () => {
  withStore((store) => {
    // An all-time rate converges and stops responding to a fix, which is why the
    // tally is windowed. Backdate a document past the window by hand — the recorder
    // stamps `now`, so there is no other way to age one.
    delivered(store, "old", [{ code: "heading-order", impact: "moderate", count: 1 }]);
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db;
    // 100 days back: outside the 30-day default, inside the 365-day maximum, so the
    // same row can be shown to leave one window and stay in the other. Relative to
    // now rather than a literal date, which would drift out of every window as the
    // calendar moves and turn the second half of this test into a tautology.
    const hundredDaysAgo = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.prepare(`UPDATE run_signals SET recorded_at = ? WHERE session_id = 'old'`).run(hundredDaysAgo);
    delivered(store, "new");

    const q = store.qualityStats({ days: 30 });
    assert.equal(q.documents, 1, "the old document leaves the denominator");
    assert.deepEqual(q.rules, [], "and its rule leaves the numerator");
    // Both halves, together: dropping the old document from the denominator while
    // keeping its rule would report heading-order failing on 100% of documents.
    const wide = store.qualityStats({ days: MAX_QUALITY_WINDOW_DAYS });
    assert.equal(wide.documents, 2);
    assert.equal(wide.rules[0].share, 1 / 2);
  });
});

test("nothing per-session, per-user or per-document is exposed", () => {
  withStore((store) => {
    // The constraint that matters most, because the consumer copies these values into
    // a PUBLIC GitHub issue and the documents are whatever users uploaded. A field
    // added here that quotes a document would leak it through a path no reviewer of
    // the workflow would think to check.
    delivered(store, "ses_secret", [{ code: "heading-order", impact: "moderate", count: 2 }]);
    const serialized = JSON.stringify(store.qualityStats());
    assert.ok(!serialized.includes("ses_secret"), "no session id");
    assert.deepEqual(
      Object.keys(store.qualityStats()).sort(),
      [
        "documents",
        "links_dropped_rate",
        "lint_error_rate",
        "mean_rounds",
        "rules",
        "since",
        "unresolved_rate",
        "window_days",
      ],
      "the shape is pinned, so a new field is a deliberate decision rather than a drift",
    );
    // Same for a rule entry, which is the other place a description or a snippet
    // would plausibly be added.
    assert.deepEqual(store.qualityStats().rules.map((r) => Object.keys(r).sort()), [
      ["documents", "id", "impact", "nodes", "share"],
    ]);
  });
});

test("a duplicated code within one call is merged rather than aborting the write", () => {
  withStore((store) => {
    // `code` is half the primary key, so two rows sharing one inside a single
    // transaction would abort it — and the whole document would drop out of the
    // tally. Whether axe can report a rule twice is not the recorder's business to
    // police; losing the document over it would be.
    store.recordRunSignals("a", [
      { code: SIGNAL_ROUNDS, count: 1 },
      { code: "heading-order", impact: "moderate", count: 2 },
      { code: "heading-order", impact: "moderate", count: 3 },
    ]);
    const q = store.qualityStats();
    assert.equal(q.documents, 1);
    assert.equal(q.rules[0].documents, 1, "still one document");
    assert.equal(q.rules[0].nodes, 5, "and the node counts are summed");
  });
});
