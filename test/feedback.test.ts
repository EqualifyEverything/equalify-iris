import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentCoverage,
  evalAgent,
  evalAgentScores,
  pairedMeans,
  regressionGate,
  MIN_CONTENT_COVERAGE,
  proposeAgentUpdatesFromFeedback,
} from "../src/pipeline/feedback.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// contentCoverage backs the regression gate's content-preservation check: it
// measures how much of a fixture's accepted output a candidate (re-run with an
// updated agent) still reproduces, by screen-reader-flattened text.

test("identical content scores full coverage", () => {
  const html = "<p>one two three four five six seven eight nine ten</p>";
  assert.equal(contentCoverage(html, html), 1);
});

test("a superset candidate still scores full coverage", () => {
  const accepted = "<p>one two three four five six seven eight nine ten</p>";
  const candidate = "<h2>one two three four five six seven eight nine ten eleven twelve</h2>";
  assert.equal(contentCoverage(accepted, candidate), 1);
});

test("structure-only change (heading vs paragraph) is not a content drop", () => {
  const accepted = "<h2>alpha bravo charlie delta echo foxtrot golf hotel</h2>";
  const candidate = "<p>alpha, bravo. charlie! delta? echo: foxtrot; golf hotel</p>";
  const cov = contentCoverage(accepted, candidate);
  assert.ok(cov !== null && cov >= MIN_CONTENT_COVERAGE, `expected >= ${MIN_CONTENT_COVERAGE}, got ${cov}`);
});

test("dropping half the content falls below the threshold", () => {
  const accepted = "<p>one two three four five six seven eight nine ten</p>";
  const candidate = "<p>one two three four five</p>";
  const cov = contentCoverage(accepted, candidate);
  assert.ok(cov !== null && cov < MIN_CONTENT_COVERAGE, `expected < ${MIN_CONTENT_COVERAGE}, got ${cov}`);
});

test("an empty candidate scores zero coverage against substantial accepted text", () => {
  const accepted = "<p>one two three four five six seven eight nine ten</p>";
  assert.equal(contentCoverage(accepted, ""), 0);
});

test("returns null when the accepted text is too short to judge", () => {
  assert.equal(contentCoverage("<p>tiny bit here</p>", "<p>totally different words instead</p>"), null);
});

// ---------------------------------------------------------------------------
// The eval gate: evalAgent (current prompt) vs regressionGate (candidate)
// ---------------------------------------------------------------------------
//
// These two functions produce the two sides of one subtraction, at the end of
// proposeAgentUpdatesFromFeedback. The property under test is that they score a
// fixture the SAME way, because the gate's decision is the difference between
// their means: any divergence in scoring shows up as a coverage delta that no
// prompt caused.
//
// The case that matters is a fixture contentCoverage abstains on (accepted text
// under MIN_COVERAGE_WORDS). Abstention depends only on `accepted_html`, so it is
// a property of the FIXTURE and applies identically to both prompts.
//
// These tests pin symmetry where both prompts behave the same on a fixture. The case
// where they DON'T — the current prompt produces no output on a fixture the candidate
// abstains on, so the two sides measure different fixture sets — is the wave-through
// the gate used to allow, and is covered by the paired-comparison tests at the end of
// this section.

// Accepted text long enough for contentCoverage to judge (>= 8 distinct words).
const JUDGEABLE = "<p>alpha bravo charlie delta echo foxtrot golf hotel india</p>";
// Short enough that contentCoverage abstains, whatever the candidate produces.
const UNJUDGEABLE = "<p>tiny bit here</p>";

interface Fixture {
  accepted: string;
  // What the re-run agent returns for this fixture. `null` = no usable output.
  produces: string | null;
}

// A context whose router replays a scripted answer per agent call. Fixtures are
// keyed by image filename so each one can produce different output; the feedback
// agent's verify/train calls are answered generically.
function gateCtx(
  dir: string,
  agentFile: string,
  fixtures: Fixture[],
  opts: { proposal?: string; githubToken?: string } = {},
): { ctx: PipelineContext; events: { type: string; data: Record<string, unknown> }[] } {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\ntext\n");
  writeFileSync(join(agentsDir, agentFile), "# Target Agent\n\nCurrent prompt.\n");

  const fixDir = join(dir, "fixtures", agentFile.replace(/\.md$/, ""));
  mkdirSync(fixDir, { recursive: true });
  const byImage = new Map<string, Fixture>();
  fixtures.forEach((f, i) => {
    // Sorted+reversed by regressionGate, so name them to keep a stable order.
    const image = `case${String(i).padStart(3, "0")}.png`;
    writeFileSync(join(fixDir, `case${String(i).padStart(3, "0")}.json`), JSON.stringify({
      agent: agentFile,
      image_file: image,
      source_image: image,
      accepted_html: f.accepted,
      captured_at: "2026-01-01T00:00:00Z",
      session: "ses_test",
    }));
    writeFileSync(join(fixDir, image), "not-a-real-png");
    byImage.set(image, f);
  });

  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    sessionId: "ses_test",
    githubToken: opts.githubToken,
    cfg: {
      github: {
        // A full URL, not "o/r": parseRepo only accepts the github.com form, and
        // the shorthand throws before the filing path ever reaches GitHub — which
        // would make the 403 test below pass on the wrong error.
        upstream_repo: "https://github.com/example/iris",
        api_base_url: "https://api.github.test",
      },
    },
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentFixtures: (a: string) => join(dir, "fixtures", a.replace(/\.md$/, "")),
      sessionAgentUpdates: () => join(dir, "agent-updates.md"),
    } as unknown as Paths,
    images: [],
    maxReviewIterations: 1,
    extractionConcurrency: 1,
    router: {
      complete: async (agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const user = messages.map((m) => m.content).join("\n");
        if (agent === "feedback") {
          // The train call proposes a new prompt; the verify call always passes,
          // so the only thing that can block is coverage.
          if (/TASK: train/.test(user)) {
            return {
              text: JSON.stringify({
                changed: true,
                summary: "improved",
                agent_markdown: opts.proposal ?? "# Target Agent\n\nUpdated prompt.\n",
              }),
            };
          }
          return { text: JSON.stringify({ faithful: true, accessible: true, problems: [] }) };
        }
        // The agent under test, re-run on a fixture image.
        const image = [...byImage.keys()].find((k) => user.includes(k));
        const fix = image ? byImage.get(image)! : null;
        if (!fix || fix.produces === null) return { text: JSON.stringify({ no_content: true }) };
        return { text: JSON.stringify({ html: fix.produces }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, events };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-feedback-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an unjudgeable fixture does not inflate the current-prompt score", async () => {
  await withTemp(async (dir) => {
    // Two judgeable fixtures reproduced perfectly, plus one fixture too short to
    // judge. Scoring the abstention as 1 would also give 1 here, so the assertion
    // that bites is the partial-coverage case below; this one pins the shape:
    // the mean is taken over the judgeable fixtures only.
    const { ctx } = gateCtx(dir, "table.md", [
      { accepted: JUDGEABLE, produces: JUDGEABLE },
      { accepted: JUDGEABLE, produces: JUDGEABLE },
      { accepted: UNJUDGEABLE, produces: "<p>anything at all</p>" },
    ]);
    const score = await evalAgent(ctx, "table.md", "# Target Agent\n\nCurrent prompt.\n");
    assert.equal(score, 1);
  });
});

test("evalAgent and regressionGate score the same fixtures identically", async () => {
  await withTemp(async (dir) => {
    // One judgeable fixture that loses a word (8 of 9 -> 0.889) and one that
    // abstains. Scoring the abstention as 1 pushed evalAgent to 0.944 while
    // regressionGate reported 0.889 for the very same outputs — a 0.056 gap
    // invented by the scoring rule, wider than EVAL_REGRESSION_EPS (0.02).
    const partial = "<p>alpha bravo charlie delta echo foxtrot golf hotel</p>"; // drops "india"
    const fixtures: Fixture[] = [
      { accepted: JUDGEABLE, produces: partial },
      { accepted: UNJUDGEABLE, produces: "<p>anything at all</p>" },
    ];
    const { ctx } = gateCtx(dir, "table.md", fixtures);
    const evalScore = await evalAgent(ctx, "table.md", "# Target Agent\n\nCurrent prompt.\n");
    const gate = await regressionGate(ctx, "table.md", "# Target Agent\n\nCurrent prompt.\n");
    assert.equal(gate.meanCoverage, evalScore, "the two sides of the eval gate disagree on identical output");
    assert.ok(evalScore !== null && evalScore < 0.9, `expected the dropped word to show, got ${evalScore}`);
  });
});

test("an unchanged prompt is not blocked as an eval regression", async () => {
  await withTemp(async (dir) => {
    // The end-to-end gate. Both prompts produce the same partial output, so there
    // is no regression to find. With the abstention scored 1 on the current side
    // only, current (0.944) exceeded candidate (0.889) by more than
    // EVAL_REGRESSION_EPS and the update was discarded as "eval_regression".
    const partial = "<p>alpha bravo charlie delta echo foxtrot golf hotel</p>";
    const { ctx, events } = gateCtx(dir, "table.md", [
      { accepted: JUDGEABLE, produces: partial },
      { accepted: UNJUDGEABLE, produces: "<p>anything at all</p>" },
    ]);
    const out = await proposeAgentUpdatesFromFeedback(ctx, {
      agentFile: "table.md",
      before: "<p>old body</p>",
      after: "<p>new body</p>",
      feedback: "keep the table headers",
    });
    const blocked = events.find((e) => e.type === "agent_update_blocked");
    assert.equal(blocked, undefined, `blocked with no regression: ${JSON.stringify(blocked?.data)}`);
    assert.equal(out.length, 1, "the proposal was dropped");
  });
});

test("a real coverage regression is still blocked", async () => {
  await withTemp(async (dir) => {
    // The gate must keep working: the candidate here drops most of the content.
    // Guards against "fixing" the false block above by weakening the gate.
    //
    // Either the MIN_CONTENT_COVERAGE floor or the eval-gate comparison catches
    // this on its own, so disabling just one of them leaves this test passing —
    // that is defense in depth, not a vacuous assertion. Disabling both does fail
    // it, which is the property worth having.
    const { ctx, events } = gateCtx(
      dir,
      "table.md",
      [{ accepted: JUDGEABLE, produces: JUDGEABLE }, { accepted: UNJUDGEABLE, produces: "<p>anything</p>" }],
      { proposal: "# Target Agent\n\nUpdated prompt.\n" },
    );
    // Re-point the router: the UPDATED prompt produces almost nothing. The two
    // prompts differ by content, so keying on the prompt text distinguishes them.
    const inner = ctx.router.complete;
    // Parameters are borrowed from the real signature rather than re-declared, so
    // this stub cannot drift from the interface it stands in for.
    ctx.router.complete = (async (
      agent: string,
      cap: Parameters<typeof inner>[1],
      messages: Parameters<typeof inner>[2],
      extra?: Parameters<typeof inner>[3],
    ) => {
      const user = messages.map((m) => m.content).join("\n");
      if (agent !== "feedback" && /Updated prompt/.test(user) && user.includes("case000.png")) {
        return { text: JSON.stringify({ html: "<p>alpha</p>" }) };
      }
      return inner(agent, cap, messages, extra);
    }) as typeof inner;

    const out = await proposeAgentUpdatesFromFeedback(ctx, {
      agentFile: "table.md",
      before: "<p>old body</p>",
      after: "<p>new body</p>",
      feedback: "keep the table headers",
    });
    assert.equal(out.length, 0, "a content regression was allowed through");
    assert.ok(
      events.some((e) => e.type === "agent_update_blocked"),
      "the block was not logged",
    );
  });
});

test("a fixture the agent cannot process at all scores zero, not a pass", async () => {
  await withTemp(async (dir) => {
    // No usable output is a failure, not an abstention: dropping it from the mean
    // would let a prompt that produces NOTHING on a fixture score the same as one
    // that handles it. regressionGate already scores no-output 0, so 0 is also the
    // symmetric choice.
    //
    // The fixture here is deliberately the UNJUDGEABLE one, because that is the
    // only shape where the no-output rule is load-bearing: with judgeable accepted
    // text an empty candidate already scores 0 through contentCoverage (nothing of
    // 9 words reproduced), so the rule would be untested against it.
    const { ctx } = gateCtx(dir, "table.md", [
      { accepted: JUDGEABLE, produces: JUDGEABLE },
      { accepted: UNJUDGEABLE, produces: null },
    ]);
    const score = await evalAgent(ctx, "table.md", "# Target Agent\n\nCurrent prompt.\n");
    assert.equal(score, 0.5, "a no-output fixture was not counted as a zero");
  });
});

test("no-output scores zero on both sides of the gate", async () => {
  await withTemp(async (dir) => {
    // The same symmetry property as the judgeable case, on the no-output path:
    // regressionGate pushes 0 for a fixture that produced nothing, and evalAgent
    // must agree or the subtraction drifts.
    const fixtures: Fixture[] = [
      { accepted: JUDGEABLE, produces: JUDGEABLE },
      { accepted: UNJUDGEABLE, produces: null },
    ];
    const { ctx } = gateCtx(dir, "table.md", fixtures);
    const prompt = "# Target Agent\n\nCurrent prompt.\n";
    const gate = await regressionGate(ctx, "table.md", prompt);
    assert.equal(gate.meanCoverage, await evalAgent(ctx, "table.md", prompt));
  });
});

test("no judgeable fixture means no score, not a perfect one", async () => {
  await withTemp(async (dir) => {
    // Every fixture abstains. A mean over zero measurements is null — the caller
    // treats that as "nothing to compare" and defers to the regression gate.
    // Returning 1 here would assert a perfect score no fixture demonstrated;
    // returning 0 would block every update.
    const { ctx } = gateCtx(dir, "table.md", [
      { accepted: UNJUDGEABLE, produces: "<p>anything at all</p>" },
      { accepted: UNJUDGEABLE, produces: "<p>something else</p>" },
    ]);
    assert.equal(await evalAgent(ctx, "table.md", "# Target Agent\n\nCurrent prompt.\n"), null);
  });
});

// ---------------------------------------------------------------------------
// The paired comparison: the gate's two means must cover the same fixtures
// ---------------------------------------------------------------------------
//
// `fixtureScore` is right that a prompt producing NOTHING has failed the fixture
// rather than abstained — but whether a fixture is scored is then partly a property
// of the prompt, and the gate averaged each side over whatever it happened to
// measure. So one flake on the CURRENT prompt deflated the bar the candidate had to
// clear. These pin the fix at both levels: the pure function, and the end-to-end gate
// that used to wave the regression through.

test("pairedMeans compares only fixtures both prompts could be scored on", () => {
  // The worked example from #30: the current prompt flakes to no output (0) on a
  // fixture the candidate abstains on, plus a judgeable fixture where the candidate
  // is genuinely 0.10 worse.
  const current = { "flake.png": 0, "real.png": 0.98 };
  const candidate = { "flake.png": null, "real.png": 0.88 };
  const m = pairedMeans(current, candidate);

  // Unpaired: 0.49 vs 0.88 — the candidate looks BETTER than the prompt it regresses.
  assert.deepEqual(m.paired, ["real.png"]);
  assert.deepEqual(m.unpaired, ["flake.png"]);
  assert.equal(m.current, 0.98, "the current mean still includes the flaked fixture");
  assert.equal(m.candidate, 0.88);
  assert.ok(m.candidate < m.current - 0.02, "the paired comparison no longer hides the regression");
});

test("pairedMeans reports no comparison rather than a false one", () => {
  // Nothing is measurable on both sides. Null is not a pass and not a regression —
  // the caller defers to the regression gate. Returning 0 for either side here would
  // block every update; returning a mean over one side alone is the original bug.
  const m = pairedMeans({ a: 0, b: null }, { a: null, b: null });
  assert.equal(m.current, null);
  assert.equal(m.candidate, null);
  assert.deepEqual(m.paired, []);
  assert.deepEqual(m.unpaired, ["a", "b"]);
});

test("pairedMeans counts a fixture only one side ever read as unpaired", () => {
  // A fixture missing from one map entirely (unreadable json, missing image) is as
  // uncomparable as one that abstained, and belongs in `unpaired` so it is visible.
  const m = pairedMeans({ both: 0.9, onlyCurrent: 0.5 }, { both: 0.9 });
  assert.deepEqual(m.paired, ["both"]);
  assert.deepEqual(m.unpaired, ["onlyCurrent"]);
  assert.equal(m.current, 0.9);
  assert.equal(m.candidate, 0.9);
});

test("a real regression is blocked even when the current prompt flakes on another fixture", async () => {
  await withTemp(async (dir) => {
    // The end-to-end wave-through, with the fixture mix that produced it:
    //   case000 — judgeable; the candidate drops content (a real regression)
    //   case001 — UNJUDGEABLE accepted text, and the CURRENT prompt returns nothing
    //
    // Unpaired, the current side scored (0 + 0.98)/2 = 0.49 against the candidate's
    // 0.88 — so `0.88 < 0.49 - eps` was false, 0.88 cleared MIN_CONTENT_COVERAGE, and
    // a real coverage regression passed both gates. Paired, case001 drops out of both
    // means and the regression is compared on its own terms.
    //
    // The candidate's output on case000 is chosen to sit ABOVE the 0.85 floor, so this
    // test can only pass by way of the eval comparison: the floor cannot catch it.
    const nineWords = "<p>alpha bravo charlie delta echo foxtrot golf hotel india</p>";
    const eightOfNine = "<p>alpha bravo charlie delta echo foxtrot golf hotel</p>"; // 0.889

    const { ctx, events } = gateCtx(
      dir,
      "table.md",
      [
        { accepted: nineWords, produces: nineWords }, // case000, current: 1.0
        { accepted: UNJUDGEABLE, produces: null }, // case001, current: no output -> 0
      ],
      { proposal: "# Target Agent\n\nUpdated prompt.\n" },
    );

    // The candidate handles case001 (so it ABSTAINS there rather than scoring 0) and
    // is worse than the current prompt on case000.
    const inner = ctx.router.complete;
    ctx.router.complete = (async (
      agent: string,
      cap: Parameters<typeof inner>[1],
      messages: Parameters<typeof inner>[2],
      extra?: Parameters<typeof inner>[3],
    ) => {
      const user = messages.map((m) => m.content).join("\n");
      if (agent !== "feedback" && /Updated prompt/.test(user)) {
        if (user.includes("case000.png")) return { text: JSON.stringify({ html: eightOfNine }) };
        if (user.includes("case001.png")) return { text: JSON.stringify({ html: "<p>anything at all</p>" }) };
      }
      return inner(agent, cap, messages, extra);
    }) as typeof inner;

    const out = await proposeAgentUpdatesFromFeedback(ctx, {
      agentFile: "table.md",
      before: "<p>old body</p>",
      after: "<p>new body</p>",
      feedback: "keep the table headers",
    });

    const blocked = events.find((e) => e.type === "agent_update_blocked");
    assert.ok(blocked, "a real regression passed the gate because the current prompt flaked elsewhere");
    assert.equal(blocked.data.reason, "eval_regression");
    // Paired over case000 alone: 1.0 vs 0.889. If this reported 0.5 the comparison is
    // unpaired again and the test would be passing for the wrong reason.
    assert.equal(blocked.data.current, 1);
    assert.deepEqual(blocked.data.paired, ["case000.png"]);
    assert.equal(out.length, 0, "the regressing proposal was filed anyway");

    // The flaked fixture is not silently dropped — it is reported, because a current
    // library agent that returns nothing is itself worth an operator's attention.
    const gate = events.find((e) => e.type === "eval_gate");
    assert.ok(gate, "the eval gate did not log its comparison");
    assert.deepEqual(gate.data.unpaired, ["case001.png"]);
  });
});

test("evalAgentScores reports per-fixture scores, not just their mean", async () => {
  await withTemp(async (dir) => {
    // The map is what makes the pairing possible, so its shape is the contract: an
    // abstention must be present as `null` rather than absent, otherwise "abstained"
    // and "never read" become indistinguishable to pairedMeans.
    const { ctx } = gateCtx(dir, "table.md", [
      { accepted: JUDGEABLE, produces: JUDGEABLE },
      { accepted: UNJUDGEABLE, produces: "<p>anything at all</p>" },
      { accepted: UNJUDGEABLE, produces: null },
    ]);
    const { mean, scores } = await evalAgentScores(ctx, "table.md", "# Target Agent\n\nCurrent prompt.\n");
    assert.deepEqual(scores, {
      "case000.png": 1, // reproduced exactly
      "case001.png": null, // accepted text too short to judge -> abstain
      "case002.png": 0, // produced nothing -> a failure on this fixture
    });
    // The mean skips the abstention but counts the zero: (1 + 0) / 2.
    assert.equal(mean, 0.5);
  });
});

// The agent-update proposal is filed as a GitHub issue on the same soft-failure
// terms as runContribution's new-agent issue, so a 403 caused by the GitHub App
// missing Issues write on `upstream_repo` reaches an operator only through the log
// line. This asserts that path carries the diagnosis too — it was added to the
// suggestion path first and this one was missed, which is easy to repeat since the
// two are in different files with no shared call site.
test("a 403 filing an agent-update issue carries the install hint", async () => {
  await withTemp(async (dir) => {
    const { ctx, events } = gateCtx(dir, "table.md", [{ accepted: JUDGEABLE, produces: JUDGEABLE }], {
      // A token is required to reach the filing call at all; without one the code
      // logs agent_update_issue_skipped and never tries.
      githubToken: "gho_user",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      await proposeAgentUpdatesFromFeedback(ctx, {
        agentFile: "table.md",
        before: "<p>old body</p>",
        after: "<p>new body</p>",
        feedback: "keep the table headers",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const failed = events.find((e) => e.type === "agent_update_issue_failed");
    assert.ok(failed, `no agent_update_issue_failed event: ${events.map((e) => e.type).join(", ")}`);
    const hint = String(failed.data.hint ?? "");
    assert.match(hint, /install/i, "the update path logged no install hint");
    assert.match(hint, /settings\/installations/, "the hint did not say where to fix it");
  });
});
