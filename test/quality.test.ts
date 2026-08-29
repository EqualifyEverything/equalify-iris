import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_QUALITY_WINDOW_DAYS,
  PUBLIC_QUALITY_MIN_DOCUMENTS,
  SIGNAL_EDITOR_TRUNCATED,
  SIGNAL_EDITOR_TRUNCATED_LOST,
  SIGNAL_LINKS_DROPPED,
  SIGNAL_LINKS_UNRESOLVED,
  SIGNAL_MARKUP_UNBALANCED,
  SIGNAL_TABLE_NO_BODY,
  SIGNAL_STRUCTURAL_DEFECT,
  SIGNAL_LINT_ERROR,
  SIGNAL_REVIEW_UNREAD,
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
    for (const rate of [
      q.unresolved_rate,
      q.links_dropped_rate,
      q.links_unresolved_rate,
      q.markup_unbalanced_rate,
      q.table_no_body_rate,
      q.structural_defect_rate,
      q.lint_error_rate,
    ]) {
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
    // A linter that could not run has no violations to report, so on its own a broken
    // linter drives every accessibility rate to zero and reads as a deployment that got
    // better. This is the signal that tells the two apart.
    delivered(store, "broken", [{ code: SIGNAL_LINT_ERROR, count: 1 }]);
    delivered(store, "fine");
    const q = store.qualityStats();
    assert.equal(q.lint_error_rate, 1 / 2);
    assert.deepEqual(q.rules, [], "and it is not mistaken for a rule");
  });
});

// The other half of the same problem, and the reason the signal alone was not enough
// (#164): a document the linter never examined was still in every rule's denominator, so
// each unrunnable lint moved every rule's share DOWN. A spell of them reads exactly like
// the prompts getting better, on the one endpoint whose job is to notice they have not.
test("a document the linter never examined is in no rule's denominator", () => {
  withStore((store) => {
    delivered(store, "checked-bad", [{ code: "heading-order", impact: "moderate", count: 2 }]);
    delivered(store, "checked-good");
    delivered(store, "never-linted", [{ code: SIGNAL_LINT_ERROR, count: 1 }]);

    const q = store.qualityStats();
    assert.equal(q.documents, 3, "all three were delivered, so all three are the rate denominator");
    assert.equal(q.documents_linted, 2, "the unexamined document is still counted as examined");
    // 1 in 2 of the documents that were actually checked, not 1 in 3 of the documents
    // that were shipped.
    assert.equal(q.rules[0].share, 1 / 2);
    // And the rate that says why the two differ is unchanged — this does not hide the
    // failure, it stops the failure from flattering the rules.
    assert.equal(q.lint_error_rate, 1 / 3);
  });
});

test("a window where nothing could be linted reports no rule shares rather than NaN", () => {
  withStore((store) => {
    // The degenerate case the guard exists for: every document in the window failed to
    // lint, so `documents_linted` is 0. A rule row cannot exist here — a document with no
    // lint has no violations to record — but 0/0 serializes to `null` and would reach the
    // workflow's threshold comparison as a silent false, so the division is guarded rather
    // than trusted, the same way the rates are.
    delivered(store, "broken-1", [{ code: SIGNAL_LINT_ERROR, count: 1 }]);
    delivered(store, "broken-2", [{ code: SIGNAL_LINT_ERROR, count: 1 }]);
    const q = store.qualityStats();
    assert.equal(q.documents_linted, 0);
    assert.equal(q.lint_error_rate, 1);
    assert.deepEqual(q.rules, []);
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

test("a document with a reference that lands nowhere is counted once, however many", () => {
  withStore((store) => {
    // Per document, like every other rate here: the endpoint's consumer copies these
    // into a public issue, and "half the documents ship a dead reference" is the fact
    // it can act on. The per-link total is on the deployment's run log, where the ids
    // that failed are too — those never leave the box (they are document content).
    delivered(store, "a", [{ code: SIGNAL_LINKS_UNRESOLVED, count: 82 }]);
    delivered(store, "b", [{ code: SIGNAL_LINKS_UNRESOLVED, count: 1 }]);
    delivered(store, "c");
    delivered(store, "d");
    const q = store.qualityStats();
    assert.equal(q.links_unresolved_rate, 2 / 4);
    // Not a subset of the dropped-links rate, and the reason both exist: a link the
    // Copy Editor lost and a reference that never had a target are different defects
    // with different fixes, and a document can have either without the other.
    assert.equal(q.links_dropped_rate, 0);
  });
});

test("markup and empty-table findings are separate rates, because one document can have either", () => {
  withStore((store) => {
    // The bench document that produced #240 had both, which is exactly why they must not be
    // one number: an unclosed tag is a defect in the bytes that the parser repairs, and a
    // table with no rows is a defect that survives it. A fix for either leaves the other.
    delivered(store, "a", [
      { code: SIGNAL_MARKUP_UNBALANCED, count: 1 },
      { code: SIGNAL_TABLE_NO_BODY, count: 1 },
    ]);
    delivered(store, "b", [{ code: SIGNAL_MARKUP_UNBALANCED, count: 3 }]);
    delivered(store, "c", [{ code: SIGNAL_TABLE_NO_BODY, count: 4 }]);
    delivered(store, "d");
    const q = store.qualityStats();
    // Per document however many findings it had, like every other rate here.
    assert.equal(q.markup_unbalanced_rate, 2 / 4);
    assert.equal(q.table_no_body_rate, 2 / 4);
    // And neither is visible in the lint numbers, which is the whole argument for measuring
    // them: axe was handed a repaired tree and had no rule for the empty table.
    assert.equal(q.lint_error_rate, 0);
  });
});

test("the structural defects are one rate, and per document however many instances fired", () => {
  withStore((store) => {
    // Three checks behind one signal, deliberately: the rate answers one question — did this
    // document ship promising a reader something that is not there — and the split between a
    // reference to an absent id, a term list with no definitions and an empty landmark is a
    // diagnosis the run's `delivered_structure` line carries, with the elements named. So a
    // document with eleven instances across all three classes counts once here, exactly like the
    // 82-dead-references document above.
    delivered(store, "a", [{ code: SIGNAL_STRUCTURAL_DEFECT, count: 11 }]);
    delivered(store, "b", [{ code: SIGNAL_STRUCTURAL_DEFECT, count: 1 }]);
    delivered(store, "c");
    delivered(store, "d");
    const q = store.qualityStats();
    assert.equal(q.structural_defect_rate, 2 / 4);
    // And nothing else here moved, which is the argument for the signal existing: axe reports a
    // dangling id reference as `incomplete` rather than a violation, passes a `<div>`-wrapped term
    // list, and has no rule for an empty `<nav>`, so both documents lint clean.
    assert.deepEqual(q.rules, []);
    assert.equal(q.lint_error_rate, 0);
    // Not the markup rates either: those are #240's two, measured on the same delivered bytes in
    // the same pass, and a document can have any of these without the others.
    assert.equal(q.markup_unbalanced_rate, 0);
    assert.equal(q.table_no_body_rate, 0);
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
        "documents_linted",
        "editor_truncated_lost_rate",
        "editor_truncated_rate",
        "links_dropped_rate",
        "links_unresolved_rate",
        "lint_error_rate",
        "markup_unbalanced_rate",
        "mean_rounds",
        "review_unread_rate",
        "rules",
        "since",
        "structural_defect_rate",
        "table_no_body_rate",
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

// --- the public subset, `Store.publicQuality` ---
//
// The same rows, read for a different audience: this one goes onto the demo page with
// no authentication in front of it. The failure modes are therefore not "the workflow
// files a wrong issue" but "the front page publishes a claim about identifiable
// people's uploads", which is why the floor below is tested as hard as the arithmetic.

// Enough delivered documents to clear the floor, so a test can be about the number
// being reported rather than about whether anything is reported at all.
function atFloor(store: Store, extra: (i: number) => RunSignal[] = () => [], rounds = 1): void {
  for (let i = 0; i < PUBLIC_QUALITY_MIN_DOCUMENTS; i++) delivered(store, `pub_${i}`, extra(i), rounds);
}

test("a window below the floor says nothing rather than a percentage", () => {
  withStore((store) => {
    assert.equal(store.publicQuality(), null, "an empty deployment");
    for (let i = 0; i < PUBLIC_QUALITY_MIN_DOCUMENTS - 1; i++) delivered(store, `pub_${i}`);
    // One short. This is the assertion that keeps the floor from being quietly lowered
    // to "we have some data": with 19 documents a single bad one is five percentage
    // points, and the page's own document count makes the arithmetic invertible.
    assert.equal(store.publicQuality(), null, `${PUBLIC_QUALITY_MIN_DOCUMENTS - 1} documents`);
    delivered(store, "pub_last");
    assert.ok(store.publicQuality(), "the floor itself must report");
  });
});

test("the clean rate is the share of documents that finished with nothing open", () => {
  withStore((store) => {
    // Four of twenty left something unresolved. Stated the positive way round, so an
    // inverted complement is visible as 20% rather than as a plausible-looking number.
    atFloor(store, (i) => (i < 4 ? [{ code: SIGNAL_UNRESOLVED, count: 2 }] : []));
    const q = store.publicQuality()!;
    assert.equal(q.documents, PUBLIC_QUALITY_MIN_DOCUMENTS);
    assert.equal(q.clean_rate, 16 / 20);
    // Per document, not per open issue: the four documents left 8 issues between them,
    // and a per-issue rate would report 12/20 for the same pipeline.
    //
    // The two halves add to 1 HERE, where every not-clean document is not clean for the one
    // reason. That is not the general invariant and the test below is why: a document whose
    // review could not be read has nothing open and is not clean either.
    assert.equal(q.clean_rate + store.qualityStats().unresolved_rate, 1, "the two must agree");
  });
});

// Issue #186. The demo page published 8% clean beside a mean of 0.9 editor passes, and the
// arithmetic was consistent — which is what made the number worth doubting rather than
// recomputing: both halves are one population, so what was in question was what "clean" was
// counting. `iris:unresolved` is written only when non-zero, so ABSENCE of it was the whole
// evidence of cleanliness, and a document whose reviewer answered nothing has none of it for
// the worst possible reason.
test("a document whose review could not be read is not a clean document", () => {
  withStore((store) => {
    // Four of twenty, none of them with an unresolved row — which is the point: nothing was
    // found in them because nothing was answered about them.
    atFloor(store, (i) => (i < 4 ? [{ code: SIGNAL_REVIEW_UNREAD, count: 1 }] : []));
    assert.equal(store.publicQuality()!.clean_rate, 16 / 20, "silence is not a clean bill of health");
    assert.equal(store.qualityStats().unresolved_rate, 0, "and it is not reported as issues left open");
    assert.equal(store.qualityStats().review_unread_rate, 4 / 20);
  });
});

test("a document that is not clean for both reasons is subtracted once", () => {
  withStore((store) => {
    // The windows that DID answer found issues, and another window said nothing. Two rows,
    // one document — so a clean count that summed rows would report 90% for a deployment
    // that is at 95%, and the clamp in `publicQuality` would hide it at the extreme instead
    // of failing here.
    atFloor(store, (i) =>
      i === 0 ? [{ code: SIGNAL_UNRESOLVED, count: 3 }, { code: SIGNAL_REVIEW_UNREAD, count: 1 }] : [],
    );
    assert.equal(store.publicQuality()!.clean_rate, 19 / 20);
    const q = store.qualityStats();
    assert.equal(q.unresolved_rate, 1 / 20, "the two rates are not disjoint and neither claims to be");
    assert.equal(q.review_unread_rate, 1 / 20);
  });
});

// Issue #159. Two rates over one event, because it has two costs and only the narrower one can
// carry a threshold: the copy editor is asked for the whole document, so its answer is as long
// as the document, and at a large `max_pages` the ceiling is hit by documents with nothing wrong
// with them. That is what the wider rate measures — 10 of the 16 truncations in the bench archive
// came back whole from the sectioned retry, and a threshold on it would have fired three bench
// rounds running on a pipeline that lost nothing.
test("a truncation the sectioned retry rescued is counted as a cost, not as a loss", () => {
  withStore((store) => {
    // Three documents hit the ceiling; one of them did not come back whole.
    atFloor(store, (i) =>
      i < 3
        ? [
            { code: SIGNAL_UNRESOLVED, count: 2 },
            { code: SIGNAL_EDITOR_TRUNCATED, count: 1 },
            ...(i === 0 ? [{ code: SIGNAL_EDITOR_TRUNCATED_LOST, count: 1 }] : []),
          ]
        : [],
    );
    const q = store.qualityStats();
    assert.equal(q.editor_truncated_rate, 3 / 20, "every document that hit the ceiling");
    assert.equal(q.editor_truncated_lost_rate, 1 / 20, "and only the one that lost corrections to it");
    // A strict subset of both rates beside it, which is what makes this attribution rather than
    // a new population: nothing here is a document `unresolved_rate` did not already count.
    assert.ok(q.editor_truncated_lost_rate <= q.editor_truncated_rate, "the lost rate cannot exceed its parent");
    assert.equal(q.unresolved_rate, 3 / 20);
    // And the wider rate is not a loss rate wearing a different name: two of those three
    // documents were corrected in full, by the expensive route. Compared rather than
    // subtracted-and-equated, because 3/20 - 1/20 is 0.09999999999999999 in a double and this
    // assertion is about the pipeline, not about IEEE 754; the two counts are pinned above.
    assert.ok(q.editor_truncated_rate > q.editor_truncated_lost_rate, "a rescued truncation is not a lost one");
  });
});

test("a flawless window reports 1, and a wholly unresolved one reports 0", () => {
  withStore((store) => {
    atFloor(store);
    assert.equal(store.publicQuality()!.clean_rate, 1, "no unresolved rows at all");
    atFloor(store, () => [{ code: SIGNAL_UNRESOLVED, count: 1 }]);
    // The bound worth pinning: `iris:unresolved` is written only when non-zero, so the
    // clean count is a subtraction, and an off-by-one there shows up here as -0.05.
    assert.equal(store.publicQuality()!.clean_rate, 0);
  });
});

test("mean rounds is averaged over documents, and zero is a real answer", () => {
  withStore((store) => {
    // 10 documents at 2 passes and 10 at 0: the zeros are the good ones, and dropping
    // them from the average — the natural mistake, since 0 looks like "nothing to
    // record" — would report 2.0 for a pipeline that averages 1.0.
    atFloor(store, () => [], 0);
    for (let i = 0; i < 10; i++) delivered(store, `pub_${i}`, [], 2);
    assert.equal(store.publicQuality()!.mean_rounds, 1);
    // And a window where every document read clean on the first look is 0, not null:
    // the floor guarantees a denominator, so unlike `qualityStats` there is no
    // "nothing ran" case left for null to mean.
    atFloor(store, () => [], 0);
    assert.equal(store.publicQuality()!.mean_rounds, 0);
  });
});

test("the public window is the default one, and older documents leave both halves", () => {
  withStore((store) => {
    // Enough documents to clear the floor, all of them unresolved and all of them old.
    atFloor(store, () => [{ code: SIGNAL_UNRESOLVED, count: 1 }]);
    assert.equal(store.publicQuality()!.clean_rate, 0, "precondition");
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db;
    const hundredDaysAgo = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.prepare(`UPDATE run_signals SET recorded_at = ?`).run(hundredDaysAgo);
    // Aged out of the window, the deployment is back below the floor and says nothing —
    // rather than reporting a clean rate over a numerator alone, which is how a window
    // applied to one half of a fraction fails.
    assert.equal(store.publicQuality(), null, "an aged-out window is not a measurement");

    atFloor(store, () => []);
    const q = store.publicQuality()!;
    assert.equal(q.window_days, 30, "the window is echoed so the page need not hardcode it");
    assert.equal(q.documents, PUBLIC_QUALITY_MIN_DOCUMENTS, "only the recent documents count");
    assert.equal(q.clean_rate, 1, "and the old unresolved rows do not follow them");
  });
});

test("the public subset carries nothing per document, and no rule ids", () => {
  withStore((store) => {
    // The narrower version of quality.test.ts' leak assertion, and the stricter one:
    // this object reaches an unauthenticated endpoint. A rule id here would put a
    // standing list of what Iris fails at on the front page — a to-do list rather than
    // a claim about the service — and `share` over 20 documents is noise besides.
    atFloor(store, (i) => (i === 0 ? [{ code: "heading-order", impact: "serious", count: 2 }] : []));
    delivered(store, "ses_secret", [{ code: SIGNAL_LINKS_DROPPED, count: 1 }]);
    const q = store.publicQuality()!;
    assert.deepEqual(
      Object.keys(q).sort(),
      ["clean_rate", "documents", "mean_rounds", "window_days"],
      "the shape is pinned, so a field added here is a deliberate public statement",
    );
    const serialized = JSON.stringify(q);
    assert.ok(!serialized.includes("ses_secret"), "no session id");
    assert.ok(!serialized.includes("heading-order"), "no rule id");
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
