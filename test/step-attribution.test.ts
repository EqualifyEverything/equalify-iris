// Issue #280: what a model call was bought FOR, on the line that says what it cost.
//
// The run log has always named the agent that answered. An agent file is a contract, and one
// contract serves several jobs, so an agent name is not a step — and every attempt this sprint to
// price a step off `by_agent` has been wrong by a large factor in one direction or the other:
//
//   * extraction's per-page fidelity check is a `feedback` call, so the extraction step read as
//     41% of a document when its jobs together are 57.2% (#280). A saving quoted against the 41%
//     is quoted against a bucket missing a third of the step.
//   * the table-join step (#243) books to `copy_editor` beside the review round, so the round it
//     first appeared in read as a review loop that had got more expensive. That one was caught
//     before publication by hand-splitting the log; nothing in the product had the answer.
//
// Neither is recoverable from `by_agent` at any effort, because the information is not in it. So
// `step` is required on every `router.complete` (providers/index.ts), the vocabulary is closed
// (`PipelineStep`, providers/types.ts), and diagnostics folds the same seven numbers a second
// time under it (`by_step`).
//
// The tests below assert at the CALL SITES, by driving the real pipeline entry points against a
// router that records what each one asked for. The two conflations above are each pinned by a test
// that drives both halves of the pair through ONE recorder, because the claim is about telling them
// apart.
//
// What that covers, exactly, so no one reads more into a green run than is there: nine steps are
// driven behaviourally — `extract`, `verify`, `correct`, `recheck_sampled`, `feedback_scope`,
// `read`, `edit`, `edit_section`, `table_join`. The remaining eight — `recheck_binding`,
// `specialist`, `specialist_merge`, `feedback_learn`, `agent_update`, `agent_regression`,
// `agent_calibrate`, `contribute` — reach paths that need a multi-page document, a real provider or
// a training round, and are held only by the source scan in the last test. That scan proves a
// literal is passed at SOME call site, so it catches a mislabel that leaves a member unused, and
// test 1 catches a `recheck_binding` ↔ `recheck_sampled` swap; it would NOT catch two of those
// eight being swapped with each other, since both literals would still be present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { runReview } from "../src/pipeline/review.ts";
import { joinContinuedTables } from "../src/pipeline/tables.ts";
import { scopeFeedback, verifyAgentOutput } from "../src/pipeline/feedback.ts";
import { loadAgent } from "../src/agents/loader.ts";
import { ProviderRouter } from "../src/providers/index.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// What a call site asked for. `agent` and `step` side by side, because every assertion here is
// about the two disagreeing.
interface Asked {
  agent: string;
  step: string;
}

interface Recorder {
  asked: Asked[];
  events: { type: string; data: Record<string, unknown> }[];
  steps(agent: string): string[];
}

function recorder(): Recorder {
  const asked: Asked[] = [];
  return {
    asked,
    events: [],
    steps: (agent: string) => asked.filter((a) => a.agent === agent).map((a) => a.step),
  };
}

// A router that answers `reply` and records the (agent, step) pair the caller passed. It reads
// `step` off the SAME argument the real router reads it off, so a call site that stopped passing
// one would fail here rather than be papered over by a default.
function recordingRouter(
  rec: Recorder,
  reply: (agent: string, user: string) => string,
): { complete: (...a: never[]) => Promise<{ text: string }> } {
  return {
    complete: (async (
      agent: string,
      _cap: string,
      messages: { role: string; content: string }[],
      opts: { step: string },
    ) => {
      rec.asked.push({ agent, step: opts.step });
      const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      return { text: reply(agent, user) };
    }) as unknown as (...a: never[]) => Promise<{ text: string }>,
  };
}

// `await fn(dir)`, not `return fn(dir)`: the pipeline reads its agent files and writes its
// fragments after its first await, so a `finally` that fires on the unawaited promise deletes the
// directory out from under the run — which shows up as a missing call rather than as an error.
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-step-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- extraction: four jobs, two agent names ---

test("extraction's jobs each get their own step, and each agent answers more than one", async () => {
  await withTemp(async (dir) => {
    const agentsDir = join(dir, "agents");
    const inputDir = join(dir, "input");
    const fragDir = join(dir, "fragments");
    for (const d of [agentsDir, inputDir, fragDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

    const rec = recorder();
    const ctx = {
      sessionId: "ses_test",
      images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png"), links: [] }],
      extractionConcurrency: 1,
      recheckSampleSize: 1,
      maxReviewIterations: 1,
      paths: {
        agentsDir,
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: (a: string) => join(dir, `mem-${a.replace(/\.md$/, "")}.json`),
        sessionFragments: () => fragDir,
      } as unknown as Paths,
      router: recordingRouter(rec, (_agent, user) => {
        // The page fails its first check, so the run buys a correction and then the sampled
        // re-check of it. The reply is chosen by sniffing the prompt, which is how the existing
        // harnesses tell these jobs apart and is exactly the guesswork `step` removes — the model
        // sees a prompt, but the LEDGER should not have to infer the job from one.
        if (user.includes("TASK: verify")) {
          const firstCheck = rec.asked.filter((a) => a.step === "verify").length === 1;
          return JSON.stringify({
            faithful: !firstCheck,
            accessible: true,
            problems: firstCheck ? [{ kind: "structure_wrong", problem: "the table has no header row" }] : [],
          });
        }
        if (user.includes("had fidelity/accessibility problems")) {
          return JSON.stringify({ html: "<h2>Findings</h2><table><tr><th>A</th></tr></table>" });
        }
        return JSON.stringify({ html: "<h2>Findings</h2><table><tr><td>A</td></tr></table>", log: "" });
      }),
      log: {
        event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;

    await runExtraction(ctx);

    // The step names the job. Order matters and is asserted: a document pays for the check before
    // it pays for the correction, which is what makes `correct` conditional on `verify`. The
    // fourth call is the sampled re-check of the corrected page — one per batch
    // (correction.ts `recheckSampler`), a measurement that decides nothing — and its presence
    // here is the case for splitting it out: it is bought under the same agent as the `verify`
    // above it, and a document with more corrected pages does not buy proportionally more of it.
    assert.deepEqual(
      rec.asked,
      [
        { agent: "page", step: "extract" },
        { agent: "feedback", step: "verify" },
        { agent: "page", step: "correct" },
        { agent: "feedback", step: "recheck_sampled" },
      ],
      JSON.stringify(rec.asked),
    );

    // And the agent name does not name the job. Two agents answered four jobs, and BOTH of them
    // answered two: `page` did the first render every page buys and the re-render only a rejected
    // page buys, `feedback` did the per-page check and the capped sample. A reader given either
    // agent's row cannot say which of its two jobs grew.
    assert.deepEqual(rec.steps("page"), ["extract", "correct"]);
    assert.deepEqual(rec.steps("feedback"), ["verify", "recheck_sampled"]);
    assert.equal(new Set(rec.asked.map((a) => a.agent)).size, 2);
    assert.equal(new Set(rec.asked.map((a) => a.step)).size, 4, "four jobs, four steps");
  });
});

// --- the two conflations, each pinned by driving both halves through one recorder ---

test("a page's fidelity check and a user's feedback routing are one agent and two steps (#280)", async () => {
  await withTemp(async (dir) => {
    const agentsDir = join(dir, "agents");
    const inputDir = join(dir, "input");
    for (const d of [agentsDir, inputDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

    const rec = recorder();
    const ctx = {
      sessionId: "ses_test",
      feedback: "the second table lost its header row",
      images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png"), links: [] }],
      paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
      router: recordingRouter(rec, () =>
        JSON.stringify({ faithful: true, accessible: true, problems: [], target: "document" }),
      ),
      log: {
        event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;

    const page = loadAgent("page", { agentsDir, tmpAgentsDir: join(dir, "tmp-agents") });
    assert.ok(page);
    const img = { name: "page-001.png", order: 1, path: join(inputDir, "page-001.png"), links: [] };
    await verifyAgentOutput(ctx, page, img, [{ html: "<p>x</p>" }], "verify");
    await scopeFeedback(ctx, [{ order: 1, innerHtml: "<p>x</p>" }] as never);

    // The whole of #280's attribution finding, in two lines. Same agent for both calls...
    assert.deepEqual(
      rec.asked.map((a) => a.agent),
      ["feedback", "feedback"],
      "both are the Feedback Agent, which is why `by_agent` cannot separate them",
    );
    // ...and one of them is a cost every page of every document pays while the other is bought
    // once, only when a user has said something. Summed under one name, the per-page check
    // disappears into a bucket named after the rarer job.
    assert.deepEqual(rec.steps("feedback"), ["verify", "feedback_scope"]);
  });
});

// The join's two halves word their column headers differently, which is the case `joinInCode`
// declines (`header_differs`) — so the model is actually asked and there is a call to attribute.
// With both halves worded the same, #278's code path joins the pair and this test would assert
// nothing about a request.
const tablePiece = (caption: string, labels: string[], colName = "Col"): string =>
  `<table><caption>${caption}</caption><thead><tr>` +
  `<th scope="col">${colName} 1</th><th scope="col">${colName} 2</th>` +
  `</tr></thead><tbody>` +
  labels.map((l) => `<tr><th scope="row">${l}</th><td>1.0</td></tr>`).join("") +
  `</tbody></table>`;

test("a table join and a review round are one agent and two steps (#243)", async () => {
  await withTemp(async (dir) => {
    mkdirSync(join(dir, "agents"), { recursive: true });
    const rec = recorder();
    const first = tablePiece("Table 1.—Income by State", ["Alabama", "Alaska"]);
    const second = tablePiece("Table 1.—Income by State—Continued", ["Vermont", "Virginia"], "Column");
    const joined = tablePiece("Table 1.—Income by State", ["Alabama", "Alaska", "Vermont", "Virginia"]);

    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 1,
      extractionConcurrency: 2,
      recheckSampleSize: 1,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: recordingRouter(rec, (agent, user) => {
        if (agent === "reader") {
          return JSON.stringify({
            issues: [{ issue: "the caption is unclear", severity: "low", suggested_action: "reword", pages: [] }],
          });
        }
        // Both of the copy editor's jobs answer here, and the reply shapes differ: the join
        // returns a whole table under `html`, the review round returns the blocks it changed.
        if (user.includes("Continued")) return JSON.stringify({ html: joined, log: "merged" });
        return JSON.stringify({ edits: [{ block: 0, html: "<p>reworded</p>" }] });
      }),
      log: {
        event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;

    await joinContinuedTables(ctx, first + second);
    await runReview(ctx, { body: "<h2>Income</h2><p>Per capita.</p>", lint: { ok: true, violations: [] } });

    // Three calls, two agents, and the interesting pair is inside one of them: `copy_editor`
    // answered a table join and a review round, which share neither prompt nor contract and
    // whose costs the sprint needs apart. src/pipeline/tables.ts already worked around this in
    // the prompt-output log by giving the join a distinct `file` name — the COST log, which is
    // the one a per-step figure is read off, had no such field until `step`.
    assert.deepEqual(rec.steps("copy_editor"), ["table_join", "edit"]);
    // Every Reader call is the same job, however many rounds the loop runs — the review loop
    // re-reads after an edit, and how often it does that is not this test's claim.
    const reads = rec.steps("reader");
    assert.ok(reads.length >= 1, "the Reader ran");
    assert.deepEqual([...new Set(reads)], ["read"]);
  });
});

// --- the router puts it on the line that carries the cost ---

test("step is on both model_call events, including the one a failed call writes", async () => {
  for (const outcome of ["ok", "throws"] as const) {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const router = new ProviderRouter(
      { providers: { default: "openrouter", openrouter: { default_model: "m", api_key: "k" } } } as never,
      (type, data) => events.push({ type, data }),
    );
    const provider = (router as unknown as { build(n: string): { complete: unknown } }).build("openrouter");
    (provider as { complete: unknown }).complete = async () => {
      if (outcome === "throws") throw new Error("ThrottlingException");
      return { text: "ok", model: "m", provider: "openrouter" };
    };

    const run = router.complete("copy_editor", "text", [{ role: "user", content: "hi" }], { step: "edit_section" });
    if (outcome === "throws") await assert.rejects(run);
    else await run;

    assert.deepEqual(
      events.map((e) => e.type),
      ["model_call_start", "model_call"],
      outcome,
    );
    for (const e of events) {
      // On the start line because that is the in-flight report, and a hung call's job is more
      // actionable than its agent; on the end line because that is where the tokens are. The
      // failing case is the one that matters most: a truncated editor round has already paid for
      // a full ceiling of output, and it is the call least likely to be attributable any other way.
      assert.equal(e.data.step, "edit_section", `${outcome}: ${e.type}`);
      assert.equal(e.data.agent, "copy_editor", `${outcome}: ${e.type}`);
    }
  }
});

// --- diagnostics ---

const T = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const line = (o: Record<string, unknown>): string => JSON.stringify(o);
const done = { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(60)) };

test("by_step and by_agent are the same calls grouped two ways, and they add up the same", () => {
  const log = [
    line({ ts: T(1), type: "model_call", agent: "page", step: "extract", duration_ms: 100, input_tokens: 10, output_tokens: 1 }),
    line({ ts: T(2), type: "model_call", agent: "page", step: "correct", duration_ms: 200, input_tokens: 20, output_tokens: 2 }),
    line({ ts: T(3), type: "model_call", agent: "feedback", step: "verify", duration_ms: 300, input_tokens: 30, output_tokens: 3 }),
    line({
      ts: T(4),
      type: "model_call",
      agent: "feedback",
      step: "feedback_scope",
      duration_ms: 400,
      input_tokens: 40,
      output_tokens: 4,
    }),
  ].join("\n");
  const d = summarizeRun(log + "\n", done as never);

  // The two splits are two groupings of the same four calls, so both sum to `tokens` — a report
  // that quoted a step's share against a differently-collected whole would be wrong in a way no
  // reader could see, and this is what makes that impossible rather than merely unlikely.
  const sum = (rows: Record<string, { input_tokens: number; count: number }>): [number, number] => [
    Object.values(rows).reduce((a, r) => a + r.input_tokens, 0),
    Object.values(rows).reduce((a, r) => a + r.count, 0),
  ];
  assert.deepEqual(sum(d.by_step), [100, 4]);
  assert.deepEqual(sum(d.by_agent), [100, 4]);
  assert.equal(d.tokens.input, 100);

  // What `by_agent` says, and why it is not an answer about a step: the Feedback Agent's row is
  // a per-page check summed with a once-per-run routing call.
  assert.equal(d.by_agent.feedback.input_tokens, 70);
  assert.equal(d.by_agent.feedback.count, 2);
  // What `by_step` says instead.
  assert.equal(d.by_step.verify.input_tokens, 30);
  assert.equal(d.by_step.feedback_scope.input_tokens, 40);
  assert.equal(d.by_step.extract.total_ms, 100);
  assert.equal(d.by_step.correct.max_ms, 200);
});

test("a log line written before step existed is counted under `?`, not dropped", () => {
  const log = [
    line({ ts: T(1), type: "model_call", agent: "page", duration_ms: 100, input_tokens: 10 }),
    line({ ts: T(2), type: "model_call", agent: "page", step: "extract", duration_ms: 100, input_tokens: 30 }),
  ].join("\n");
  const d = summarizeRun(log + "\n", done as never);

  // The router requires a step and the type is closed, so a live run cannot produce this — an
  // archived log can. Named rather than dropped: a bucket that silently omitted those calls would
  // make `by_step` sum to less than `tokens` and say nothing about why.
  assert.equal(d.by_step["?"].input_tokens, 10);
  assert.equal(d.by_step.extract.input_tokens, 30);
  assert.equal(
    Object.values(d.by_step).reduce((a, r) => a + r.input_tokens, 0),
    d.tokens.input,
    "an old log still adds up",
  );
});

test("in_flight and slowest_calls name the step, since that is what a stuck run is asked about", () => {
  // Both calls get a start, and the page call gets its end: an end event with no matching start
  // closes the oldest open call by design (diagnostics.ts pairs by agent+step+model+capability and
  // falls back to the oldest), so a page end with no page start would close the feedback call and
  // report nothing in flight.
  const running = [
    line({ ts: T(1), type: "model_call_start", agent: "page", step: "extract", model: "m", capability: "vision" }),
    line({ ts: T(2), type: "model_call_start", agent: "feedback", step: "verify", model: "m", capability: "vision" }),
    line({
      ts: T(3),
      type: "model_call",
      agent: "page",
      step: "extract",
      model: "m",
      capability: "vision",
      duration_ms: 900,
    }),
  ].join("\n");
  const d = summarizeRun(running + "\n", {
    sessionId: "s",
    status: "running",
    phase: "extraction",
    now: Date.parse(T(30)),
  } as never);
  assert.equal(d.in_flight?.step, "verify", "`feedback` in flight is a page being checked or a user's feedback routed");
  assert.equal(d.slowest_calls[0].step, "extract");
});

test("in_flight names the job actually outstanding when two of the same agent's jobs overlap", () => {
  // The case the previous test sidesteps by using two different agents. Extraction's `verify`,
  // `recheck_binding` and `recheck_sampled` are all the Feedback Agent, the same resolved model and
  // the same capability, and they run across pages at `extractionConcurrency` — so two of them open
  // at once is routine, not contrived. Page 3's verify starts first and is still open; page 1's
  // recheck starts second and finishes. Pairing on agent+model+capability alone made those two
  // starts interchangeable, so the recheck's end closed the verify's start and `in_flight` reported
  // the recheck — naming a finished job as what the run is stuck on, with the wrong `since`.
  const running = [
    line({ ts: T(1), type: "model_call_start", agent: "feedback", step: "verify", model: "m", capability: "vision" }),
    line({
      ts: T(2),
      type: "model_call_start",
      agent: "feedback",
      step: "recheck_binding",
      model: "m",
      capability: "vision",
    }),
    line({
      ts: T(3),
      type: "model_call",
      agent: "feedback",
      step: "recheck_binding",
      model: "m",
      capability: "vision",
      duration_ms: 1000,
    }),
  ].join("\n");
  const d = summarizeRun(running + "\n", {
    sessionId: "s",
    status: "running",
    phase: "extraction",
    now: Date.parse(T(30)),
  } as never);

  assert.equal(d.in_flight_count, 1);
  assert.equal(d.in_flight?.step, "verify", "the recheck ended; the verify is what is outstanding");
  // The clock too, not just the label: reporting the later start's `since` understates the wait,
  // which is the number an operator reads to decide a call has hung.
  assert.equal(d.in_flight?.since, T(1));
  assert.equal(d.in_flight?.waiting_ms, 29_000);
});

test("an end still closes something when neither side of the run carried a step", () => {
  // Narrowing the pairing key must not strand an archived log's calls as phantom hangs: a start and
  // its end spread the same `meta`, so a pre-#281 log has `step` on neither and both read as `?`.
  const log = [
    line({ ts: T(1), type: "model_call_start", agent: "page", model: "m", capability: "vision" }),
    line({ ts: T(2), type: "model_call", agent: "page", model: "m", capability: "vision", duration_ms: 500 }),
  ].join("\n");
  const d = summarizeRun(log + "\n", {
    sessionId: "s",
    status: "running",
    phase: "extraction",
    now: Date.parse(T(30)),
  } as never);
  assert.equal(d.in_flight, null);
  assert.equal(d.in_flight_count, 0);
});

// --- the vocabulary and the call sites cannot drift apart ---

test("every step in the vocabulary is passed by a call site, and every call site's step is in it", () => {
  const src = (p: string): string => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  // The union members, read from the type rather than restated here: a list copied into a test is
  // a second place to forget. Line comments come off BEFORE looking for the declaration's
  // terminating `;`, because the members are documented inline and English prose uses semicolons —
  // reading to the first `;` in the raw text stopped after three members.
  const union = src("src/providers/types.ts")
    .split("export type PipelineStep =")[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n")
    .split(";")[0];
  const declared = new Set([...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  assert.ok(declared.size >= 16, `parsed ${declared.size} steps, so the regex stopped matching the type`);

  // The literals actually passed, in the two forms a call site can pass one: `{ step: "x" }` on
  // `router.complete`, and the narrowed positional argument on `verifyAgentOutput`.
  const passed = new Set<string>();
  const files = [
    "src/pipeline/extraction.ts",
    "src/pipeline/review.ts",
    "src/pipeline/tables.ts",
    "src/pipeline/feedback.ts",
    "src/pipeline/calibration.ts",
    "src/pipeline/contribute.ts",
  ];
  for (const f of files) {
    const text = src(f);
    for (const m of text.matchAll(/\bstep:\s*"([a-z_]+)"/g)) passed.add(m[1]);
    // A trailing comma before the `)` because a wrapped call site gets one from the formatter.
    for (const m of text.matchAll(/verifyAgentOutput\([^;]{0,300}?,\s*"([a-z_]+)",?\s*\)/g)) passed.add(m[1]);
  }

  // A member nobody passes is a bucket that will never appear in `by_step`, which leaves a reader
  // looking for a step the product does not report. Both directions, because the two failures are
  // different: an unpassed member is dead vocabulary, and a passed literal outside the union
  // cannot happen while the union is the parameter type — asserted anyway so that widening the
  // type to `string` for convenience fails here.
  assert.deepEqual(
    [...declared].filter((s) => !passed.has(s)),
    [],
    "declared but never passed by any call site",
  );
  assert.deepEqual([...passed].filter((s) => !declared.has(s)), [], "passed but not in the vocabulary");
});
