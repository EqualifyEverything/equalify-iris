import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContribution, STANDARD } from "../src/pipeline/contribute.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// A suggestion naming a content type the general page pass already covers must
// never become an upstream issue. That filter is `STANDARD`, and until recently a
// hole in it was harmless: a padded name like `"table.md "` normalized to
// `"table.md"`, which `STANDARD` does not contain, but the `loadAgent` check right
// after it resolved `agents/table.md` and skipped the suggestion anyway.
//
// The nine standard agent files are gone (§7.4 v1.2, they were unreachable), so
// that second net is gone with them. The same hole now drafts an agent with a model
// call and FILES an issue on the upstream repo proposing a `table` agent — under the
// user's own GitHub identity, since that is whose token files contributions (§12).
// A maintainer sees a proposal for a type the page pass has always handled, and the
// user gets the credit for it.
//
// So this is now the only thing standing between a sloppy model string and a
// spurious public issue, which is why it is asserted directly rather than through
// the file-existence behavior it used to lean on.

interface Rec {
  events: { type: string; data: Record<string, unknown> }[];
  drafted: number;
  // Which agent the draft was dispatched as, recorded because `providers.per_agent` is keyed by
  // exactly this string: a rename here silently un-routes a deployment's override for the
  // builder, and there is no other call site to notice it (docs/models.md §1).
  agents: string[];
}

// No `fetch` stub: the point of these cases is that GitHub is never reached. The
// api_base_url is a closed port, so an attempt to file would surface as an
// `agent_issue_failed` event rather than passing quietly.
function makeCtx(dir: string): { ctx: PipelineContext; rec: Rec } {
  const agentsDir = join(dir, "agents");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

  const rec: Rec = { events: [], drafted: 0, agents: [] };
  const ctx = {
    sessionId: "ses_test",
    githubToken: "gho_user",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }],
    cfg: {
      github: {
        upstream_repo: "https://github.com/example/iris",
        api_base_url: "http://127.0.0.1:1/never-listening",
      },
    },
    paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
    router: {
      // Counted, not just stubbed: drafting is a vision call on the source image, so
      // a suggestion that gets this far has already cost real money before anything
      // is filed. Reaching the draft is a failure even if the filing then fails.
      complete: async (agent: string) => {
        rec.drafted++;
        rec.agents.push(agent);
        return { text: "# Agent\n\n## Required capability\nvision\n" };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

async function contribute(names: string[]): Promise<Rec> {
  const dir = mkdtempSync(join(tmpdir(), "iris-standard-"));
  const { ctx, rec } = makeCtx(dir);
  try {
    await runContribution(
      ctx,
      names.map((name) => ({ name, reason: "test", image: "page-001.png" })),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rec;
}

test("no standard content type is ever drafted or filed", async () => {
  // Every name in the set, not a sample: the set is the whole policy, and a typo in
  // one entry would let exactly one type through.
  const rec = await contribute([...STANDARD]);
  assert.equal(rec.drafted, 0, "a standard type reached the model");
  assert.deepEqual(rec.events, [], "a standard type produced a contribution event");
});

test("whitespace and a .md extension around a standard type are still filtered", async () => {
  // The regression, with the net that used to hide it removed. Normalizing as
  // `.replace(/\.md$/, "").trim()` leaves "table.md " as "table.md", which STANDARD
  // does not contain — and there is no longer an `agents/table.md` for the loadAgent
  // check to find, so it goes on to draft and file.
  const rec = await contribute([" table.md \n", "  formField.md  ", " list "]);
  assert.equal(rec.drafted, 0, "a padded standard name got past the filter and was drafted");
  assert.deepEqual(rec.events, [], "a padded standard name produced a contribution event");
});

test("a case variant of a standard type is filtered too", async () => {
  // The names in a suggestion are prose descriptions of content types, not filenames,
  // so a model writing `"Table"` or `"FormField"` is entirely ordinary — `STANDARD`
  // itself spells one entry `formField`. An exact-match filter lets every one of these
  // through to a vision call and a public issue on the upstream repo, filed under the
  // user's own GitHub identity, proposing a specialist for a type the page pass has
  // always handled.
  //
  // Until §7.4 v1.2 this was invisible: `loadAgent` looked up `agents/Table.md`, which
  // resolves on a case-insensitive volume (macOS, the usual dev machine), so the
  // suggestion was skipped for the wrong reason and only a Linux deployment filed the
  // issue. The nine files are gone now and nothing resolves anywhere.
  const rec = await contribute(["Table", "FormField", "FOOTNOTE", " Heading.md "]);
  assert.equal(rec.drafted, 0, "a case variant of a standard name was drafted");
  assert.deepEqual(rec.events, [], "a case variant of a standard name produced a contribution event");
});

test("two spellings of one new type are drafted once, not twice", async () => {
  // Deduplication is case-insensitive for the same reason the filter is: a run that
  // suggested `"chartData"` on one page and `"chartdata"` on another would otherwise pay
  // for two vision calls and file two issues proposing the same agent.
  const rec = await contribute(["chartData", "chartdata", "CHARTDATA.md"]);
  assert.equal(rec.drafted, 1, "one type spelled three ways was drafted more than once");
  assert.deepEqual(
    rec.events.map((e) => [e.type, e.data.agent]),
    [["agent_issue_failed", "chartData"]],
    "the issue was filed under a name other than the first spelling seen",
  );
});

test("no suggestion means no builder call, which is why its cost and the specialist's are one number", async () => {
  // A run whose pages named no specialist spends nothing here. That is not a measurement of the
  // builder: it is the same gate that leaves the specialist at zero, one step downstream
  // (`runContribution` is called with the page pass's suggestions — orchestrator.ts). A cost
  // report that lists the two separately is reporting one cause twice, which is what
  // docs/models.md §4 says and what this pins.
  const rec = await contribute([]);
  assert.equal(rec.drafted, 0, "a run with no suggestions still called a model");
  assert.deepEqual(rec.agents, []);
  assert.deepEqual(rec.events, []);
});

test("a genuinely new type is still drafted, so the filter is not just refusing everything", async () => {
  // The control. Without it, a filter that dropped every suggestion would pass both
  // tests above while silently ending contributions altogether — the failure §12
  // cares about most.
  const rec = await contribute(["chartDataAgent"]);
  assert.equal(rec.drafted, 1, "a new content type was not drafted");
  // Under the `builder` name, and asserted at the call site rather than grepped for: this string
  // is the `providers.per_agent` key a deployment writes to put a different model on drafting,
  // and nothing else dispatches it.
  assert.deepEqual(rec.agents, ["builder"]);
  // Filing then fails (the API base is a closed port), which is itself the proof it
  // was attempted rather than filtered out.
  assert.deepEqual(
    rec.events.map((e) => [e.type, e.data.agent, e.data.stage]),
    [["agent_issue_failed", "chartDataAgent", "file"]],
  );
});
