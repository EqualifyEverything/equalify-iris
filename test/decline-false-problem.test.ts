import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declinedSource, parseDeclined, runExtraction } from "../src/pipeline/extraction.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// The corrector's only legal move used to be compliance: a problem naming something about the HTML
// that is not so — an id used twice that is used once, a missing attribute that is present — was
// answered by editing a page that was right. #373 directive 4 gives it one more move, to say which
// problem and why and change nothing, so a false claim becomes a logged disagreement instead of a
// silent edit.
//
// The issue states the risk against its own directive: this is also a way to ignore a true problem.
// Two things answer it, and both are pinned below rather than argued.
//
// The first is that the licence decides nothing. It removes the EDIT and touches no verdict, no
// `keep`, no recheck and not the `uncorrected` set — so a page whose problem was declined wrongly
// ships in exactly the state a correction that failed to fix it ships in: named in `uncorrected`,
// with `@page-uncorrected` on the document. The decline can buy a different explanation of a bad
// page and never silence about it, and the run against a control that declined nothing is what says
// so here.
//
// The second is that the misuse is measurable. Three of the four problem sources are checked in
// code against the source file or the parsed fragment, so a decline over one of THOSE is a refusal
// of a fact rather than of a judgement; `source` on the log line names which source raised the
// problem, and `verification.declined.code_checked` counts them. The licence is defensible over
// `verify` — the Feedback Agent's reading, the thing that can be wrong — and the log says how often
// it is being used anywhere else.

// --- reading the reply --------------------------------------------------------

test("a decline in the shape the prompt asks for is read as a number and a reason", () => {
  assert.deepEqual(
    parseDeclined([{ problem: 2, why: 'only one element carries id="fn-1"' }]),
    [{ problem: 2, why: 'only one element carries id="fn-1"' }],
  );
  // Two of them, and the order they arrived in: the log prints this list as it stands, and a
  // reader matching it against a numbered problem list is reading the numbers, not the positions.
  assert.deepEqual(
    parseDeclined([
      { problem: 3, why: "the alt is a sentence, not a placeholder" },
      { problem: 1, why: "the heading is already an h3" },
    ]),
    [
      { problem: 3, why: "the alt is a sentence, not a placeholder" },
      { problem: 1, why: "the heading is already an h3" },
    ],
  );
});

test("the reply's own words for the same two fields are read too", () => {
  // A model told to send `problem` and `why` sends `number` and `reason` some of the time, and the
  // alternative to accepting those is a decline that parses to nothing — which is a page edited
  // against a claim the model had just refuted, logged as full compliance. The synonyms are cheap
  // and the failure they prevent is silent.
  assert.deepEqual(parseDeclined([{ number: 2, reason: "no such attribute" }]), [
    { problem: 2, why: "no such attribute" },
  ]);
  assert.deepEqual(parseDeclined([{ number: 4, because: "the table has six rows" }]), [
    { problem: 4, why: "the table has six rows" },
  ]);
  // A number that came back as a string, which is what an envelope re-serialized by hand carries.
  assert.deepEqual(parseDeclined([{ problem: " 2 ", why: "not duplicated" }]), [
    { problem: 2, why: "not duplicated" },
  ]);
});

test("`index` is not read as the citation, because nothing says which base it is in", () => {
  // A model does send `index`, and the word conventionally means the 0-based position: `{ index: 1 }`
  // is the first problem to one writer and the second to another, with nothing on the reply to
  // settle it. A citation read off by one is worse than no citation, because `source` is computed
  // from it and then read as evidence about which check was refused — so a `verify` decline lands in
  // `ids` and the run reports the misuse this feature is measured by, manufactured by the parser.
  // The decline is kept; only the number it could not verify is dropped.
  assert.deepEqual(parseDeclined([{ index: 1, why: "the alt is a sentence" }]), [
    { why: "the alt is a sentence" },
  ]);
  assert.deepEqual(parseDeclined([{ problem: 3, index: 2, why: "x" }]), [{ problem: 3, why: "x" }]);
});

test("a decline written as a sentence keeps the number it cites", () => {
  // `declined: ["2. the id appears once"]` — a list of strings rather than of objects. The number
  // is at the front because that is where a model writing prose puts it, and reading it there is
  // the difference between a decline that can be attributed to a problem and one that cannot.
  assert.deepEqual(parseDeclined(["2. the id appears once, on the footnote marker"]), [
    { problem: 2, why: "2. the id appears once, on the footnote marker" },
  ]);
  assert.deepEqual(parseDeclined(["#3) the alt is not a placeholder"]), [
    { problem: 3, why: "#3) the alt is not a placeholder" },
  ]);
  // `why` keeps the citation rather than having it stripped, because the string is the model's own
  // account and this file is not the place to edit it. The number is read out of it, not removed
  // from it.
  const [entry] = parseDeclined(["1 - the heading is an h3 already"]);
  assert.equal(entry.problem, 1);
  assert.match(entry.why, /^1 - /);
});

test("a decline that cites nothing is still a decline", () => {
  // No number to attribute it to. It is kept — the corrector did decline, and the reply is the only
  // record of that — and `problem` is absent rather than guessed, because a guess would attribute a
  // disagreement to a problem the model never named. `declinedSource` returns null for it and
  // `verification.declined.unattributed` is where it lands.
  assert.deepEqual(parseDeclined(["the HTML does not say that"]), [{ why: "the HTML does not say that" }]);
  assert.deepEqual(parseDeclined([{ why: "the HTML does not say that" }]), [
    { why: "the HTML does not say that" },
  ]);
  // Including a number that is not one: a float, a NaN, a number the list has no entry for. The
  // first two lose the field here; the third keeps it and loses its `source` later, since a citation
  // out of range is a claim about the list that this function cannot check.
  assert.deepEqual(parseDeclined([{ problem: 1.5, why: "x" }]), [{ why: "x" }]);
  assert.deepEqual(parseDeclined([{ problem: "two", why: "x" }]), [{ why: "x" }]);
  assert.deepEqual(parseDeclined([{ problem: 99, why: "x" }]), [{ problem: 99, why: "x" }]);
});

test("a reply that declined nothing produces no entries", () => {
  // The ordinary case, on every corrected page in a run: the key is absent. It has to parse to an
  // empty list and not to one entry with an empty reason, because the count of declines is a
  // numerator over the corrections that ran and a phantom entry per page would swamp it.
  assert.deepEqual(parseDeclined(undefined), []);
  assert.deepEqual(parseDeclined(null), []);
  assert.deepEqual(parseDeclined([]), []);
  // An empty or whitespace string is the same nothing said at more length.
  assert.deepEqual(parseDeclined(["", "   "]), []);
  // And the shapes that are neither: a number, a boolean, a nested array member.
  assert.deepEqual(parseDeclined([1, true, null]), []);
});

test("a model that would not omit the key does not thereby decline something", () => {
  // The request says to omit `declined` where it is acting on every problem, and the shapes a model
  // sends instead of omitting a key are these. Each would otherwise write a `page_correction_declined`
  // line and add 1 to `declined.pages`, `problems` and `unattributed` for EVERY corrected page in a
  // run — which does not skew those rates, it replaces them, since they are read against the number
  // of corrections.
  assert.deepEqual(parseDeclined({}), [], "an object with nothing in it declined nothing");
  assert.deepEqual(parseDeclined([{}, {}]), []);
  assert.deepEqual(parseDeclined("none"), []);
  for (const word of ["none", "None", "N/A", "n/a", "na", "nil", "nothing", "null", "-", "—", "None."]) {
    assert.deepEqual(parseDeclined([word]), [], `"${word}" is not a decline`);
  }
  // And the near miss that IS one: a reason that merely begins with one of those words.
  assert.deepEqual(parseDeclined(["none of the ids are duplicated"]), [
    { why: "none of the ids are duplicated" },
  ]);
  // An object carrying only a key that is not a reason is the same nothing.
  assert.deepEqual(parseDeclined([{ note: "looks fine" }]), []);
  // And the same non-answers inside the object shape, which is the likelier half: the request's own
  // example is a list of objects, so a model that will not omit the key sends the object with the
  // word in it rather than the bare word.
  assert.deepEqual(parseDeclined([{ why: "none" }]), []);
  assert.deepEqual(parseDeclined({ reason: "N/A" }), []);
  assert.deepEqual(parseDeclined([{ why: "-" }, { because: "nothing" }]), []);
  // A CITED problem survives whatever its reason says, on the same terms as a number with no reason
  // at all: the number is attributable, and that is what the counts are made of.
  assert.deepEqual(parseDeclined([{ problem: 2, why: "none" }]), [{ problem: 2, why: "none" }]);
});

test("one decline sent bare, outside a list, is read as one decline", () => {
  // `declined: { problem: 2, why: … }` — the object the prompt's example shows, without the
  // brackets around it. Refusing to read that would discard the disagreement and edit the page.
  assert.deepEqual(parseDeclined({ problem: 2, why: "only one id" }), [{ problem: 2, why: "only one id" }]);
  assert.deepEqual(parseDeclined("2. only one id"), [{ problem: 2, why: "2. only one id" }]);
});

test("a decline that named a problem and no reason keeps the number and says the reason was empty", () => {
  // Not dropped, and this is the asymmetry with the empty string above: `{ problem: 2 }` names
  // something the log can attribute and count, while `""` names nothing at all. What it loses is
  // the argument, and `why: ""` on the line is how a reader sees that it never arrived.
  assert.deepEqual(parseDeclined([{ problem: 2 }]), [{ problem: 2, why: "" }]);
});

// --- which of the five sources a citation lands in ----------------------------

test("a cited number is attributed by the band it falls in", () => {
  // The problem list is five lists concatenated, in this order, and the model is shown one numbered
  // sequence over all of them. So the number it cites is attributable, and nothing else on the
  // reply is: this is what makes a decline of a code-checked fact countable.
  const counts = { verify: 2, links: 1, alt: 1, ids: 3, words: 2 };
  assert.equal(declinedSource(1, counts), "verify");
  assert.equal(declinedSource(2, counts), "verify");
  assert.equal(declinedSource(3, counts), "links");
  assert.equal(declinedSource(4, counts), "alt");
  assert.equal(declinedSource(5, counts), "ids");
  assert.equal(declinedSource(7, counts), "ids");
  // The fifth band (#334 part B), which is appended after `ids` and is the one band where a decline
  // may be right — a page that really prints both spellings. It has to be attributable for that to
  // be countable, and it is the band a wrong `ids` boundary would silently swallow.
  assert.equal(declinedSource(8, counts), "words");
  assert.equal(declinedSource(9, counts), "words");
  // Past the end of the list, and before its start. Both are `null` rather than the nearest band:
  // a citation the list cannot account for has not refused a code-checked fact, and filing it as
  // one would manufacture the evidence the field exists to collect.
  assert.equal(declinedSource(10, counts), null);
  assert.equal(declinedSource(0, counts), null);
  assert.equal(declinedSource(-1, counts), null);
  // No citation at all.
  assert.equal(declinedSource(undefined, counts), null);
});

test("an empty band is skipped, not counted as a position", () => {
  // The common shape by far: a page rejected by the verifier with no missing link, no placeholder
  // alt, no duplicate id and no split word. Problem 1 is the verdict's first problem. A band that
  // took a position while holding nothing would shift every number after it and attribute each
  // decline to the wrong source — silently, since the numbers all still resolve.
  assert.equal(declinedSource(1, { verify: 3, links: 0, alt: 0, ids: 0, words: 0 }), "verify");
  assert.equal(declinedSource(3, { verify: 3, links: 0, alt: 0, ids: 0, words: 0 }), "verify");
  assert.equal(declinedSource(4, { verify: 3, links: 0, alt: 0, ids: 0, words: 0 }), null);
  // And the mirror: a correction bought by a code check on a page the verifier passed, where the
  // verify band is the empty one and problem 1 belongs to `ids`.
  assert.equal(declinedSource(1, { verify: 0, links: 0, alt: 0, ids: 2, words: 0 }), "ids");
  assert.equal(declinedSource(2, { verify: 0, links: 0, alt: 0, ids: 2, words: 0 }), "ids");
  assert.equal(declinedSource(1, { verify: 0, links: 1, alt: 1, ids: 0, words: 0 }), "links");
  assert.equal(declinedSource(2, { verify: 0, links: 1, alt: 1, ids: 0, words: 0 }), "alt");
  // The last band with every band before it empty, which is the shape a page bought by this check
  // alone produces — a page the verifier passed, with all its links, no placeholder alt and no
  // duplicate id, that writes one word two ways. Problem 1 is `words` and not `verify`.
  assert.equal(declinedSource(1, { verify: 0, links: 0, alt: 0, ids: 0, words: 1 }), "words");
  assert.equal(declinedSource(2, { verify: 0, links: 0, alt: 0, ids: 0, words: 1 }), null);
  // A list with nothing in it buys no correction, so nothing can cite into it.
  assert.equal(declinedSource(1, { verify: 0, links: 0, alt: 0, ids: 0, words: 0 }), null);
});

// --- through the pipeline -----------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

interface PageSpec {
  // The first verdict's problems. Empty or absent is a page that passed.
  problems?: string[];
  // A placeholder alt in the render, which raises a problem checked in CODE — the band a decline
  // is not defensible over, and the one this file has to be able to see a decline land in.
  genericAlt?: true;
  // One word written two ways, which raises a problem checked in code where a decline IS defensible
  // (#334 part B). The band that has to be visible separately from `genericAlt`'s, because folding
  // the two together would put compliance in the field that counts misuse.
  splitWord?: true;
  // What the correction answers with. `undefined` is the repaired page; `""` is a reply with no
  // usable page in it at all.
  corrected?: string;
  // What it puts in `declined`, exactly as the model would send it.
  declined?: unknown;
}

const body = (order: number): string =>
  `<h2>Page ${order}</h2><p>page ${order} ${"content ".repeat(20)}</p>`;
const withAlt = (order: number): string => `${body(order)}<p><img src="f.png" alt="image"></p>`;
// `non-farm` beside `nonfarm`, which is the pair to test with rather than a made-up one: it is one of
// the shipped model's six on #334's census, and it is a case where the printing keeps the hyphen — so
// a corrector saying "the page really prints both" is exactly the answer the problem invites.
const withSplitWord = (order: number): string =>
  `${body(order)}<p>The non-farm series is here, and the nonfarm total is in the column beside it.</p>`;
const repaired = (order: number): string => body(order).replace("<h2>", "<h3>").replace("</h2>", "</h3>");

function makeCtx(
  dir: string,
  pages: number,
  spec: Record<number, PageSpec>,
): { ctx: PipelineContext; events: Event[]; prompts: string[] } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const images: { name: string; order: number; path: string; links: never[] }[] = [];
  for (let order = 1; order <= pages; order++) {
    const name = `page-00${order}.png`;
    writeFileSync(join(inputDir, name), "not-a-real-png");
    images.push({ name, order, path: join(inputDir, name), links: [] });
  }
  const events: Event[] = [];
  // The correction requests, in the order they were made: the licence's own wording is under test
  // here as much as what the pipeline does with a reply to it.
  const prompts: string[] = [];
  const ctx = {
    sessionId: "ses_test",
    images,
    extractionConcurrency: pages,
    recheckSampleSize: 1,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      // Calls are told apart by `step` rather than by pattern-matching the prompt, so a verify and
      // the render it judges cannot be confused. The page is found by the content of the prompt,
      // because the correction request names no filename — it carries the page's previous output.
      complete: async (
        _agent: string,
        _cap: string,
        messages: { role: string; content: string }[],
        opts?: { step?: string },
      ) => {
        const prompt = messages.map((m) => m.content).join("\n");
        const step = opts?.step;
        if (step === "verify" || step === "recheck_binding" || step === "recheck_sampled") {
          const img = images.find((i) => prompt.includes(`source image "${i.name}"`))!;
          const problems = step === "verify" ? (spec[img.order]?.problems ?? []) : [];
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: true, problems }) };
        }
        if (step === "correct") {
          const img = images.find((i) => prompt.includes(`page ${i.order} content`))!;
          const s = spec[img.order] ?? {};
          prompts.push(messages.find((m) => m.role === "user")?.content ?? "");
          return {
            text: JSON.stringify({
              html: s.corrected ?? repaired(img.order),
              ...(s.declined === undefined ? {} : { declined: s.declined }),
            }),
          };
        }
        const img = images.find((i) => prompt.includes(`filename: ${i.name}`))!;
        const s = spec[img.order] ?? {};
        const html = s.genericAlt ? withAlt(img.order) : s.splitWord ? withSplitWord(img.order) : body(img.order);
        return { text: JSON.stringify({ html, log: "" }) };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown> = {}) => events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, events, prompts };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-decline-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);
const diagnose = (events: Event[]) =>
  summarizeRun(
    events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
    { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
  );

const rejected = ["The table on this page lost its six aggregate rows."];

test("the problems Iris checked itself are marked, and the licence excludes the marked ones", async () => {
  // What keeps `declined.code_checked` meaning one thing. The licence is written around claims about
  // the markup, and the code-checked problems are phrased as exactly that — "More than one element on
  // this page has id=…", "your output does not link to it", "has a placeholder for alt text" — so a
  // corrector following the licence AS WRITTEN would decline into them, and the field that exists to
  // count the misuse would be counting compliance. One number, two behaviours, and no way to tell
  // them apart afterwards. So the entries Iris raised in code say so, and the licence says a marked
  // problem is not one to decline.
  await withTemp(async (dir) => {
    const { ctx, prompts } = makeCtx(dir, 2, { 1: { problems: rejected, genericAlt: true } });
    await runExtraction(ctx);
    assert.equal(prompts.length, 1);
    const [problem1, problem2] = prompts[0]
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => l.replace(/\s+/g, " "));
    // The verifier's problem, as it wrote it, unmarked: it is a reading, and a reading is what may
    // be false. #373's instance C is this entry saying an id is duplicated on a page that has none.
    assert.match(problem1, /^1\. The table on this page lost its six aggregate rows\.$/);
    assert.doesNotMatch(problem1, /checked this one in code/);
    // The alt rule's problem, which was matched against a closed word list in the fragment before the
    // call was made.
    assert.match(problem2, /^2\. The image described as alt="image" has a placeholder/);
    assert.match(problem2, /\(Iris checked this one in code\.\)$/, "and it says so, at the end");
    // The licence names the mark, in the mark's own words, so the two cannot drift apart.
    const licence = prompts[0].replace(/\s+/g, " ");
    assert.match(licence, /A problem marked "\(Iris checked this one in code\.\)" is not one of these/);
    assert.match(licence, /settled against the source file or this page's own markup/);
  });
});

test("a decline is logged with the problem it names, the reason, and how many were on offer", async () => {
  await withTemp(async (dir) => {
    const { ctx, events } = makeCtx(dir, 2, {
      2: {
        problems: rejected,
        declined: [{ problem: 1, why: "the table has six aggregate rows and they are all present" }],
      },
    });
    await runExtraction(ctx);

    const declined = of(events, "page_correction_declined");
    assert.equal(declined.length, 1, "one page declined, so one line");
    assert.equal(declined[0].image, "page-002.png");
    assert.equal(declined[0].page, 2);
    assert.equal(declined[0].trigger, "verify", "the same word its `page_corrected` line uses");
    // The denominator, on the line. 1 declined of 1 problem is a reply that refused the whole
    // correction; 1 of 9 is the pass working, and a count with no total cannot tell them apart.
    assert.equal(declined[0].problems, 1);
    assert.deepEqual(declined[0].declined, [
      {
        problem: 1,
        source: "verify",
        why: "the table has six aggregate rows and they are all present",
      },
    ]);
  });
});

test("a page whose only problem was declined ships exactly as a page nothing repaired", async () => {
  // The answer to the risk #373 states against its own directive, and it is a comparison rather
  // than an argument: the declining run and a control that returned the same unrepaired page
  // without declining anything are checked against each other on every outcome that reaches a
  // reader. If a decline ever bought silence, these two would differ here.
  await withTemp(async (dir) => {
    const declining = makeCtx(dir, 3, {
      2: {
        problems: rejected,
        // Declined, and the page came back untouched — which is what the prompt asks for, since a
        // reply with no `html` is a reply the run cannot use.
        corrected: body(2),
        declined: [{ problem: 1, why: "the six rows are present" }],
      },
    });
    const withDecline = await runExtraction(declining.ctx);
    assert.deepEqual(withDecline.uncorrectedPages, [2], "still named as a page that was never repaired");
    assert.equal(withDecline.fragments.find((f) => f.order === 2)!.innerHtml, body(2));
    assert.deepEqual(withDecline.failedPages, [], "and not confused with a page that has no content");
    const doc = wrapDocument("<p>x</p>", { uncorrectedPages: withDecline.uncorrectedPages });
    assert.match(doc, /@page-uncorrected 2\b/, "the delivered document still admits to it");
    const declinedEvents = of(declining.events, "page_correction_declined");
    assert.equal(declinedEvents.length, 1, "the disagreement is on the record");

    // The control: the same reply, without the `declined` key.
    const silent = makeCtx(dir, 3, { 2: { problems: rejected, corrected: body(2) } });
    const withoutDecline = await runExtraction(silent.ctx);
    assert.equal(of(silent.events, "page_correction_declined").length, 0);

    assert.deepEqual(withDecline.uncorrectedPages, withoutDecline.uncorrectedPages);
    assert.deepEqual(withDecline.failedPages, withoutDecline.failedPages);
    assert.deepEqual(
      withDecline.fragments.map((f) => f.innerHtml),
      withoutDecline.fragments.map((f) => f.innerHtml),
      "the same document, page for page",
    );
    // Including the page's own verdict line and the word `page_corrected` gives its outcome. The
    // only difference between the two runs is the extra event, so it is filtered out of both.
    const comparable = (events: Event[]) =>
      events.filter((e) => e.type !== "page_correction_declined").map((e) => e.type);
    assert.deepEqual(comparable(declining.events), comparable(silent.events));
    assert.equal(of(declining.events, "page_corrected")[0].result, of(silent.events, "page_corrected")[0].result);
    assert.equal(of(declining.events, "page_corrected")[0].result, "identical");
    assert.deepEqual(of(declining.events, "extraction_complete")[0].uncorrected, [2]);
    assert.deepEqual(of(silent.events, "extraction_complete")[0].uncorrected, [2]);
  });
});

test("a decline over a fact Iris checked in code is counted as one", async () => {
  // The misuse this licence has to be watchable for. A placeholder alt is not a reading of the
  // image — `genericAlt` matched the attribute in the fragment — so a decline over it is a refusal
  // of something Iris can see for itself. It is not blocked, because a page-level guard here would
  // have to decide the disagreement, and Iris is not in a position to; it is labelled, so a run
  // where the corrector has learned to decline its way out of the code checks says so.
  await withTemp(async (dir) => {
    const { ctx, events } = makeCtx(dir, 2, {
      1: {
        problems: rejected,
        genericAlt: true,
        // Problem 1 is the verdict's; problem 2 is the alt the code check raised. The verdict is
        // declined defensibly and the code check is not, on the same reply.
        declined: [
          { problem: 1, why: "the six rows are present" },
          { problem: 2, why: "the alt is fine" },
          { why: "and something else is wrong with the list" },
        ],
      },
    });
    await runExtraction(ctx);

    const line = of(events, "page_correction_declined")[0];
    assert.equal(line.trigger, "both", "a verdict and a code check on the same page");
    assert.equal(line.problems, 2);
    assert.deepEqual(
      (line.declined as { source: string | null }[]).map((d) => d.source),
      ["verify", "alt", null],
      "each decline attributed to the source that raised the problem, or to none",
    );

    const d = diagnose(events);
    assert.equal(d.verification.declined.pages, 1);
    assert.equal(d.verification.declined.problems, 3);
    assert.equal(d.verification.declined.code_checked, 1, "the alt, and not the verdict");
    assert.equal(d.verification.declined.unattributed, 1, "the one that cited no problem");
    // The denominator is every problem the run put to a corrector, not the declining page's own
    // bill: dividing by the numerator's own subject would report a rate the run cannot be wrong
    // about. Page 1 was offered two problems and page 2 was offered none.
    assert.equal(d.verification.declined.problems_offered, 2);
    assert.equal(d.verification.corrections, 1);
  });
});

test("a decline over a word written two ways is counted apart from the misuse", async () => {
  // The one code-checked band where a decline may be RIGHT, and therefore the one that must not be
  // added to `code_checked`. What Iris checked is that the page carries both `non-farm` and
  // `nonfarm`, which is not arguable; which spelling the printing shows is, and the problem's own
  // last sentences invite the corrector to say the page prints both and change nothing. Counting
  // that as misuse would put compliance in the field whose whole job is to count the licence being
  // stretched — the same mistake `CHECKED_IN_CODE` exists to stop, one field along.
  //
  // What this test does NOT check is that the request permits the refusal it counts: the decline
  // comes from a mock. That is `SPELLINGS_CHECKED_IN_CODE`'s own mark and the licence sentence naming
  // it, pinned in `test/split-words.test.ts` — and the first draft of this change had the two texts
  // contradicting each other while this test passed.
  await withTemp(async (dir) => {
    const { ctx, events } = makeCtx(dir, 2, {
      1: {
        problems: rejected,
        splitWord: true,
        // Problem 1 is the verdict's and is declined defensibly; problem 2 is the split word and is
        // declined defensibly too. Two declines, and they belong in two different fields.
        declined: [
          { problem: 1, why: "the six rows are present" },
          { problem: 2, why: "the page prints both: the series is non-farm and the total is nonfarm" },
        ],
      },
    });
    await runExtraction(ctx);

    const line = of(events, "page_correction_declined")[0];
    assert.equal(line.trigger, "both", "a verdict and a code check on the same page");
    assert.deepEqual(
      (line.declined as { source: string | null }[]).map((d) => d.source),
      ["verify", "words"],
      "the fifth band reads off its own position, after verify/links/alt/ids",
    );

    const d = diagnose(events);
    assert.equal(d.verification.declined.problems, 2);
    assert.equal(d.verification.declined.words, 1, "the split word, in its own count");
    assert.equal(d.verification.declined.code_checked, 0, "and NOT in the field that counts misuse");
    assert.equal(d.verification.declined.unattributed, 0);
    // And the finding itself is on the record with both spellings, which is what a reader checking
    // this decline against the document needs: the claim was that the page contains the pair.
    assert.deepEqual(of(events, "page_split_words")[0].words, ["non-farm / nonfarm"]);
  });
});

test("a run where nothing declined leaves the block at zero and still says what was on offer", async () => {
  // A zero row that prints. `declined.pages: 0` against `problems_offered: 3` is the measurement
  // this feature is worth judging on, and a block that appeared only once something declined would
  // make the ordinary run indistinguishable from a run whose logs predate the field.
  await withTemp(async (dir) => {
    const { ctx, events } = makeCtx(dir, 2, {
      1: { problems: rejected },
      2: { problems: [...rejected, "the heading level is wrong"] },
    });
    await runExtraction(ctx);
    assert.equal(of(events, "page_correction_declined").length, 0);
    const d = diagnose(events);
    assert.equal(d.verification.declined.pages, 0);
    assert.equal(d.verification.declined.problems, 0);
    assert.equal(d.verification.declined.code_checked, 0);
    assert.equal(d.verification.declined.unattributed, 0);
    assert.equal(d.verification.declined.problems_offered, 3, "two corrections, three problems between them");
  });
});

test("a reply that declined everything and returned no page is both facts on one line", async () => {
  // The shape the prompt argues against by name ("a reply with no `html` is a reply this run cannot
  // use"), and therefore the one to be able to see: the corrector treated the decline as the whole
  // answer. `page_correction_no_output` is the existing line for a call that produced nothing, and
  // the decline count goes on it, because a reader looking at a page that came back empty needs to
  // know whether the model was refusing or failing.
  await withTemp(async (dir) => {
    const { ctx, events } = makeCtx(dir, 2, {
      2: { problems: rejected, corrected: "", declined: [{ problem: 1, why: "the rows are there" }] },
    });
    const { uncorrectedPages } = await runExtraction(ctx);
    const empty = of(events, "page_correction_no_output");
    assert.equal(empty.length, 1);
    assert.equal(empty[0].declined, 1, "one decline, on the line that says the page came back empty");
    // And it is still a correction that repaired nothing.
    assert.deepEqual(uncorrectedPages, [2]);
    assert.equal(of(events, "page_corrected")[0].result, "empty");
    // The decline is on its own line too, with its reason — the count above is a flag, not the
    // record.
    const line = of(events, "page_correction_declined")[0];
    assert.deepEqual(line.declined, [{ problem: 1, source: "verify", why: "the rows are there" }]);
    const d = diagnose(events);
    assert.equal(d.verification.declined.pages, 1);
    assert.equal(d.verification.declined.problems, 1);
  });
});

test("a decline in prose, with no number in it, is logged rather than dropped", async () => {
  // What a model that ignored the JSON shape sends. There is nothing to attribute it to, and the
  // alternative to logging it is a page corrected against a claim the model had refuted with no
  // record that it said so.
  await withTemp(async (dir) => {
    const { ctx, events } = makeCtx(dir, 2, {
      2: { problems: rejected, corrected: body(2), declined: "the table's six rows are all present" },
    });
    await runExtraction(ctx);
    const line = of(events, "page_correction_declined")[0];
    assert.deepEqual(line.declined, [
      { source: null, why: "the table's six rows are all present" },
    ]);
    assert.equal("problem" in (line.declined as object[])[0], false, "no number was cited, so none is invented");
    const d = diagnose(events);
    assert.equal(d.verification.declined.unattributed, 1);
    assert.equal(d.verification.declined.code_checked, 0);
  });
});
