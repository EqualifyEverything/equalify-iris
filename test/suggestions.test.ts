// Agent suggestions (#539): the store, the route, and the workflow script's pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { Store, type SuggestionRow } from "../src/store/db.ts";
import { groupSuggestions, suggestionKey, suggestionsRouter } from "../src/routes/suggestions.ts";
// @ts-expect-error — a plain .mjs script with no types.
import * as script from "../.github/scripts/agent-suggestions.mjs";
import { STANDARD } from "../src/pipeline/contribute.ts";

const TOKEN = "fake-quality-token";

function withStore(fn: (store: Store) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "iris-sugg-"));
  return Promise.resolve(fn(new Store(join(dir, "iris.sqlite")))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

const row = (agent: string, session_id: string, page: string, reason?: string): SuggestionRow => ({
  kind: "new_agent", agent, session_id, page, reason,
});

test("suggestionKey merges spellings of one name", () => {
  assert.equal(suggestionKey("scientificFigureAgent"), "scientificfigure");
  assert.equal(suggestionKey("scientific-figure"), "scientificfigure");
  assert.equal(suggestionKey("Map Specialist"), "map");
  assert.equal(suggestionKey("agent"), "agent");
  // The script must agree, or an old issue's title maps to a different key.
  for (const n of ["scientificFigureAgent", "Map Specialist", "agent", "bar_chart"])
    assert.equal(script.suggestionKey(n), suggestionKey(n));
});

test("the store keeps one row per suggestion and page, and groups them", () =>
  withStore((store) => {
    store.addSuggestions([row("barChartAgent", "s1", "p1.png", "bars"), row("bar-chart", "s2", "p3.png", "more bars")]);
    // The same session, agent and page again replaces rather than adds.
    store.addSuggestions([row("barChartAgent", "s1", "p1.png", "bars, again")]);
    store.addSuggestions([
      { kind: "agent_update", agent: "page.md", session_id: "s1", lesson: "keep-footnotes", detail: { lesson_slug: "keep-footnotes", summary: "a" } },
      { kind: "agent_update", agent: "page.md", session_id: "s2", lesson: "keep-footnotes", detail: { lesson_slug: "keep-footnotes", summary: "b" } },
    ]);
    // One session's second lesson is a second row, not a replacement.
    store.addSuggestions([
      { kind: "agent_update", agent: "page.md", session_id: "s1", lesson: "keep-headings", detail: { lesson_slug: "keep-headings", summary: "c" } },
    ]);
    const rows = store.listSuggestions();
    assert.equal(rows.length, 5);
    const g = groupSuggestions(rows);
    assert.equal(g.new_agents.length, 1);
    assert.equal(g.new_agents[0].key, "barchart");
    assert.equal(g.new_agents[0].count, 2);
    assert.equal(g.new_agents[0].sessions, 2);
    assert.deepEqual(g.new_agents[0].reasons.sort(), ["bars, again", "more bars"]);
    assert.equal(g.agent_updates.length, 2);
    assert.equal(g.agent_updates[0].count, 2);
    assert.equal((g.agent_updates[0].latest as { summary: string }).summary, "b");
  }));

test("the route is 404 without a quality token and 401 without the right one", () =>
  withStore(async (store) => {
    store.addSuggestions([row("mapAgent", "s1", "p1.png")]);
    for (const [cfg, header, status] of [
      [{}, `Bearer ${TOKEN}`, 404],
      [{ quality_token: TOKEN }, undefined, 401],
      [{ quality_token: TOKEN }, "Bearer wrong", 401],
      [{ quality_token: TOKEN }, `Bearer ${TOKEN}`, 200],
    ] as const) {
      const app = express();
      app.use("/v1/suggestions", suggestionsRouter(store, cfg));
      const server = app.listen(0);
      await new Promise((r) => server.once("listening", r));
      try {
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/suggestions`, {
          headers: header ? { authorization: header } : {},
        });
        assert.equal(res.status, status);
        if (status === 200) {
          assert.equal(res.headers.get("cache-control"), "no-store");
          assert.equal((await res.json()).new_agents[0].key, "map");
        }
      } finally {
        server.close();
      }
    }
  }));

test("the script owns only its section of an issue body", () => {
  const once = script.withSection("Written by a person.", "counts v1");
  assert.match(once, /^Written by a person\.\n\n<!-- iris-suggestions:start -->\ncounts v1\n/);
  const twice = script.withSection(once + "\n\nAdded later.", "counts v2");
  assert.match(twice, /counts v2/);
  assert.doesNotMatch(twice, /counts v1/);
  assert.match(twice, /^Written by a person\.[\s\S]*Added later\.$/);
});

test("an issue's keys come from its list, or from an old title", () => {
  const listed = { title: "New agent suggestion: Charts", body: "x <!-- iris-suggestion-keys: barchart, linechart -->" };
  assert.deepEqual(script.issueKeys(listed), ["barchart", "linechart"]);
  assert.deepEqual(script.issueKeys({ title: "New agent suggestion: scientificFigureAgent", body: "old" }), ["scientificfigure"]);
});

test("a section records its keys and a reason cannot close it", () => {
  const groups = groupSuggestions([row("mapAgent", "s1", "p1.png", "a map --> --!> <!<!---->-- <b>trick")]).new_agents;
  const section = script.newAgentSection(["map"], groups);
  assert.match(section, /<!-- iris-suggestion-keys: map -->/);
  assert.match(section, /Asked for 1 time,/);
  const rest = section.replace("<!-- iris-suggestion-keys: map -->", "");
  assert.doesNotMatch(rest, /[<>]/, "only the keys marker has an angle bracket");
});

test("the model's grouping reply is checked against the keys it was given", () => {
  const out = script.parseAssignments(
    'Here: {"assign":[{"key":"map","issue":12},{"key":"globe","concept":"Maps"},{"key":"invented","concept":"X"},{"key":"bar","issue":"12"}]}',
    ["map", "globe", "bar"],
  );
  assert.deepEqual([...out], [["map", { issue: 12 }], ["globe", { concept: "Maps" }]]);
  assert.throws(() => script.parseAssignments("no json here", ["map"]), /no JSON/);
});

test("an update's title matches the one Iris used to file, so old issues are found", () => {
  assert.equal(script.updateTitle({ agent: "page.md", lesson_slug: "keep-footnotes" }), "Agent update proposal: page.md — keep-footnotes");
  assert.equal(script.updateTitle({ agent: "page.md", lesson_slug: null }), "Agent update proposal: page.md");
});

test("no session id reaches a public issue, and a name cannot break the section", () => {
  const groups = groupSuggestions([
    row("map|Agent\n<!-- iris-suggestions:end -->", "ses_secret1", "p1.png", "why"),
  ]).new_agents;
  const section = script.newAgentSection([groups[0].key], groups);
  assert.doesNotMatch(section, /ses_secret1/);
  assert.doesNotMatch(section, /<!-- iris-suggestions:end -->/);
  assert.equal(section.split("\n").filter((l: string) => l.startsWith("| map")).length, 1, "the name stays on one table row");
  const update = script.updateSection({
    agent: "page.md", lesson_slug: "x", count: 1, sessions: 1, first_seen: "", last_seen: "",
    latest: { session_id: "ses_secret2", summary: "s", diff_preview: "+ a" },
  });
  assert.doesNotMatch(update, /ses_secret2/);
});

test("a diff that contains the end marker is still replaced whole", () => {
  const g = { agent: "page.md", lesson_slug: "x", count: 1, sessions: 1, first_seen: "", last_seen: "" };
  const v1 = script.withSection("Top.", script.updateSection({ ...g, latest: { summary: "v1", diff_preview: "+ <!-- iris-suggestions:end -->\n+ old tail" } }));
  const v2 = script.withSection(v1 + "\n\nBelow.", script.updateSection({ ...g, latest: { summary: "v2" } }));
  assert.doesNotMatch(v2, /old tail/);
  assert.match(v2, /^Top\.[\s\S]*v2[\s\S]*Below\.$/);
});

test("a row read back keeps its lesson, so writing it again does not collapse two lessons", () =>
  withStore((store) => {
    const u = (lesson: string): SuggestionRow => ({ kind: "agent_update", agent: "page.md", session_id: "s1", lesson, detail: { lesson_slug: lesson } });
    store.addSuggestions([u("a"), u("b")]);
    store.addSuggestions(store.listSuggestions());
    assert.deepEqual(store.listSuggestions().map((r) => r.lesson), ["a", "b"]);
  }));

test("a drafted agent is named the way dispatch will look it up", () => {
  assert.equal(script.agentFile("Scientific Figure And Plot Specialist"), "scientificFigureAndPlotAgent.md");
  assert.equal(script.agentFile("Flowchart"), "flowchartAgent.md");
  assert.equal(script.agentFile("Chart Data Agent"), "chartDataAgent.md");
  const section = script.newAgentSection(["flow"], [], "flowchartAgent.md");
  assert.match(section, /Save the agent as `agents\/flowchartAgent\.md`/);
  assert.doesNotMatch(script.newAgentSection(["flow"], []), /Save the agent/);
});

test("grouping is offered the library's agents, and can assign a key to one", () => {
  const agents = script.libraryAgents("agents", { readdirSync, readFileSync });
  const names = agents.map((a: { name: string }) => a.name);
  assert.ok(names.includes("chartDataAgent"));
  assert.ok(!names.includes("page") && !names.includes("feedback"));
  assert.equal(agents.find((a: { name: string }) => a.name === "chartDataAgent").key, "chartdata");
  const prompt = script.groupingPrompt(
    [
      { number: 5, title: "New agent suggestion: Maps", state: "open", body: "" },
      { number: 6, title: "New agent suggestion: Music", state: "closed", body: "" },
    ],
    [{ key: "chart", names: [{ name: "chart" }], reasons: ["a bar chart"] }],
    agents,
  );
  assert.match(prompt, /Existing agents:\n(- .*\n)*- chartDataAgent: Convert charts/);
  assert.match(prompt, /#5 Maps \(keys/);
  assert.match(prompt, /#6 Music \(rejected\)/);
  const out = script.parseAssignments('{"assign":[{"key":"chart","agent":"chartDataAgent"}]}', ["chart"]);
  assert.deepEqual([...out], [["chart", { agent: "chartDataAgent" }]]);
});

test("the drafter is told how Iris runs a specialist and every saved reason", () => {
  const reasons = Array.from({ length: 10 }, (_, i) => `reason ${i}`);
  const prompt = script.draftPrompt("Flowchart", [{ names: [{ name: "flowchart" }], reasons }], "EXAMPLE", "flowchartAgent.md");
  assert.match(prompt, /saved as agents\/flowchartAgent\.md/);
  assert.match(prompt, /"no_content": true/);
  assert.match(prompt, /replaces the page agent's own rendering/);
  for (const r of reasons) assert.ok(prompt.includes(r), r);
});

test("a key leaves an issue closed as done, and stays on one that was rejected", () => {
  assert.equal(script.keepsKeys({ state: "open" }), true);
  assert.equal(script.keepsKeys({ state: "closed", state_reason: "not_planned" }), true);
  assert.equal(script.keepsKeys({ state: "closed", state_reason: "duplicate" }), true);
  assert.equal(script.keepsKeys({ state: "closed", state_reason: "completed" }), false);
});

test("an agent is matched by key, so a draft never names a file Iris has", () => {
  const agents = script.libraryAgents("agents", { readdirSync, readFileSync });
  for (const n of ["chartDataAgent", "chartDataAgent.md", "chartdataagent", "Chart Data"])
    assert.equal(script.matchAgent(agents, n)?.name, "chartDataAgent", n);
  assert.equal(script.matchAgent(agents, script.agentFile("Chart Data Specialist"))?.name, "chartDataAgent");
  assert.equal(script.matchAgent(agents, "chart"), undefined);
  const text = script.missedSummary([["chart", "chartDataAgent"]]);
  assert.match(text, /- chart → chartDataAgent/);
  assert.match(text, /Nothing was filed/);
});

test("the script's standard types are dispatch's, and are never offered as agents", () => {
  assert.deepEqual([...script.STANDARD].sort(), [...STANDARD].map((s) => s.toLowerCase()).sort());
  const fs = { readdirSync: () => ["page.md", "feedback.md", "Table.md", "chartDataAgent.md"], readFileSync: () => "# T\nabout" };
  assert.deepEqual(script.libraryAgents("x", fs).map((a: { name: string }) => a.name), ["chartDataAgent"]);
});
