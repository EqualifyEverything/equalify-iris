// Files a deployment's agent suggestions as GitHub issues (#539). Run by
// .github/workflows/agent-suggestions.yml.
//
// Iris saves every suggestion and serves them grouped at /v1/suggestions. This script:
//   1. maps each new-agent group to an issue. Each issue lists the keys it covers. A key
//      no issue covers yet goes to one model call, which assigns it to an existing issue
//      or names a new concept. Each new concept gets a drafted agent and a new issue.
//   2. gives each agent update proposal its own issue, by agent and lesson.
//   3. rewrites the counts on every issue it touches, open or closed.
//
// Iris owns only the part of a body between the two markers, so people can edit the rest.
//
// Nothing here publishes a session id. An id is all it takes to read or change a session
// on an open deployment, and these issues are public.
//
// Env: QUALITY_URL, QUALITY_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY, BEDROCK_MODEL,
// AWS_REGION, DRY_RUN ("true" files nothing).

export const NEW_PREFIX = "New agent suggestion: ";
export const UPDATE_PREFIX = "Agent update proposal: ";
const START = "<!-- iris-suggestions:start -->";
const END = "<!-- iris-suggestions:end -->";
const FENCE = "````";
const KEYS = /<!-- iris-suggestion-keys: ([^>]*) -->/;

// Same as suggestionKey in src/routes/suggestions.ts, so a title from before this
// workflow maps to the key its suggestions now have.
export function suggestionKey(name) {
  let k = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (;;) {
    const next = k.replace(/(agent|specialist)$/, "");
    if (next === k || !next) return k;
    k = next;
  }
}

// The keys an issue covers. An issue Iris filed before this workflow has no list, so its
// title stands in.
export function issueKeys(issue) {
  const m = KEYS.exec(issue.body ?? "");
  if (m) return m[1].split(",").map((k) => k.trim()).filter(Boolean);
  const k = suggestionKey(issue.title.slice(NEW_PREFIX.length));
  return k ? [k] : [];
}

// Replace the section Iris owns, or add it at the end. The last END closes it: a diff
// preview is the model's text, verbatim, and may contain the marker.
export function withSection(body, section) {
  const block = `${START}\n${section}\n${END}`;
  const s = body ?? "";
  const a = s.indexOf(START);
  const b = s.lastIndexOf(END);
  if (a >= 0 && b > a) return s.slice(0, a) + block + s.slice(b + END.length);
  return s ? `${s}\n\n${block}` : block;
}

// A table cell: one line, no pipes or backticks to break the table.
const cell = (s) => quote(s).replace(/[|`]/g, "");
const day = (iso) => (iso || "").slice(0, 10);
// Model text, one line, with no angle brackets, so it can open no tag or comment and close
// no section. Stripping only `<!--` once is not enough: `<!<!---->--` rebuilds it.
const quote = (s) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

export function newAgentSection(keys, groups) {
  const mine = groups.filter((g) => keys.includes(g.key));
  const total = mine.reduce((n, g) => n + g.count, 0);
  const first = mine.map((g) => g.first_seen).sort()[0];
  const last = mine.map((g) => g.last_seen).sort().at(-1);
  const lines = [
    `<!-- iris-suggestion-keys: ${keys.join(",")} -->`,
    "## How often Iris asked for this",
    "",
    total
      ? `Asked for ${total} time${total === 1 ? "" : "s"}, from ${day(first)} to ${day(last)}.`
      : "No saved suggestions match this issue yet.",
  ];
  if (mine.length) {
    lines.push("", "| Name Iris used | Times | Sessions |", "| --- | --- | --- |");
    for (const g of mine)
      for (const n of g.names) lines.push(`| ${cell(n.name)} | ${n.count} | ${n === g.names[0] ? g.sessions : ""} |`);
    const reasons = mine.flatMap((g) => g.reasons).slice(-10);
    if (reasons.length) lines.push("", "Recent reasons:", "", ...reasons.map((r) => `- ${quote(r)}`));
  }
  lines.push("", "_Iris updates this section on each run. Edit anything outside it._");
  return lines.join("\n");
}

export function updateTitle(g) {
  return `${UPDATE_PREFIX}${g.agent}${g.lesson_slug ? ` — ${g.lesson_slug}` : ""}`;
}

export function updateSection(g) {
  const p = g.latest ?? {};
  const lines = [
    "## How often this was proposed",
    "",
    `Proposed ${g.count} time${g.count === 1 ? "" : "s"} in ${g.sessions} session${g.sessions === 1 ? "" : "s"}, from ${day(g.first_seen)} to ${day(g.last_seen)}.`,
    "",
    "## Latest proposal",
    "",
    quote(p.summary ?? ""),
  ];
  if (p.lesson) {
    lines.push("", `Lesson: ${quote(p.lesson.instruction ?? "")}`, "", `Feedback: ${quote(p.lesson.feedback ?? "")}`);
  }
  if (p.diff_preview) lines.push("", FENCE + "diff", p.diff_preview, FENCE);
  // The full prompt (page.md is ~85 KB) does not fit in an issue body, which GitHub caps
  // at 65,536 characters. It is `latest.content` at /v1/suggestions.
  if (p.content) lines.push("", "The full proposed prompt is `latest.content` at the deployment's `/v1/suggestions`.");
  lines.push("", "_Iris updates this section on each run. Edit anything outside it._");
  return lines.join("\n");
}

// The model's job: put each unassigned key under an existing issue or a new concept.
export function groupingPrompt(issues, unassigned) {
  return [
    "Iris is a PDF-to-accessible-HTML tool. While reading pages it suggests specialist agents it wishes it had.",
    "Some suggestions below are not yet grouped. Put each under an existing issue if it means the same kind",
    "of content, otherwise under a new concept. Merge new keys that mean the same thing into one concept.",
    "",
    "Existing issues:",
    ...issues.map((i) => `- #${i.number} ${i.title.slice(NEW_PREFIX.length)} (keys: ${issueKeys(i).join(", ")})`),
    "",
    "Unassigned suggestions:",
    ...unassigned.map((g) => `- key ${g.key}: names ${g.names.map((n) => n.name).join(", ")}; reasons: ${g.reasons.slice(-3).map(quote).join(" | ")}`),
    "",
    'Reply with JSON only: {"assign":[{"key":"...","issue":123}|{"key":"...","concept":"Short Title Case Name"}]}',
  ].join("\n");
}

export function parseAssignments(text, keys) {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("the grouping reply had no JSON");
  const out = new Map();
  for (const a of JSON.parse(m[0]).assign ?? []) {
    if (!keys.includes(a.key)) continue;
    if (Number.isInteger(a.issue)) out.set(a.key, { issue: a.issue });
    else if (typeof a.concept === "string" && a.concept.trim()) out.set(a.key, { concept: a.concept.trim() });
  }
  return out;
}

export function draftPrompt(concept, groups, example) {
  return [
    `Draft an Iris specialist agent for this content: ${concept}.`,
    "Iris asked for it with these names and reasons:",
    ...groups.flatMap((g) => [`- ${g.names.map((n) => n.name).join(", ")}`, ...g.reasons.slice(-5).map((r) => `  - ${quote(r)}`)]),
    "",
    "Follow the shape of this existing agent file. Reply with the markdown file only.",
    "",
    example,
  ].join("\n");
}

// ---- I/O below. Not run on import, so the tests can load the functions above. ----

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status}`);
  return res.json();
}

async function allIssues() {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/issues?state=all&per_page=100&page=${page}`);
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return out;
  }
}

async function ask(prompt) {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
  const res = await client.send(
    new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 8000 },
    }),
  );
  return (res.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
}

async function main() {
  const dry = process.env.DRY_RUN === "true";
  const origin = (process.env.QUALITY_URL ?? "").replace(/\/+$/, "");
  if (!origin.startsWith("https://")) throw new Error("QUALITY_URL must be an https origin");
  const res = await fetch(`${origin}/v1/suggestions`, {
    headers: { authorization: `Bearer ${process.env.QUALITY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`/v1/suggestions answered ${res.status}`);
  const report = await res.json();
  console.log(`new-agent groups: ${report.new_agents.length}, agent-update groups: ${report.agent_updates.length}`);

  const issues = await allIssues();
  const concepts = issues.filter((i) => i.title.startsWith(NEW_PREFIX));
  const keyed = new Map();
  for (const i of concepts) for (const k of issueKeys(i)) if (!keyed.has(k)) keyed.set(k, i);

  const write = async (what, fn) => {
    console.log(`${dry ? "would " : ""}${what}`);
    if (!dry) await fn();
  };
  const touched = new Map(); // issue number -> keys

  const unassigned = report.new_agents.filter((g) => !keyed.has(g.key));
  if (unassigned.length) {
    const keys = unassigned.map((g) => g.key);
    const assigned = parseAssignments(await ask(groupingPrompt(concepts, unassigned)), keys);
    const fresh = new Map(); // concept name -> groups
    for (const g of unassigned) {
      const a = assigned.get(g.key);
      const target = a?.issue ? concepts.find((i) => i.number === a.issue) : undefined;
      if (target) {
        touched.set(target.number, [...(touched.get(target.number) ?? issueKeys(target)), g.key]);
      } else {
        const name = quote(a?.concept ?? g.names[0].name);
        fresh.set(name, [...(fresh.get(name) ?? []), g]);
      }
    }
    const { readFileSync } = await import("node:fs");
    const example = readFileSync("agents/chartDataAgent.md", "utf8");
    for (const [concept, groups] of fresh) {
      const keys = groups.map((g) => g.key);
      // A concept the model named again, rather than assigning to its issue.
      const same = concepts.find((i) => i.title.slice(NEW_PREFIX.length).toLowerCase() === concept.toLowerCase());
      if (same) {
        touched.set(same.number, [...(touched.get(same.number) ?? issueKeys(same)), ...keys]);
        continue;
      }
      const draft = await ask(draftPrompt(concept, groups, example));
      const body = withSection(
        [
          "Iris asked for an agent for this content. Below is a draft for a maintainer to review.",
          "",
          "<details><summary>Drafted agent</summary>",
          "",
          FENCE + "markdown",
          draft.trim(),
          FENCE,
          "",
          "</details>",
        ].join("\n"),
        newAgentSection(keys, report.new_agents),
      );
      await write(`create "${NEW_PREFIX}${concept}" (${keys.join(", ")})`, () =>
        gh("/issues", { method: "POST", body: JSON.stringify({ title: `${NEW_PREFIX}${concept}`, body }) }),
      );
    }
  }
  for (const [k, i] of keyed) if (report.new_agents.some((g) => g.key === k)) touched.set(i.number, touched.get(i.number) ?? issueKeys(i));

  for (const [number, keys] of touched) {
    const issue = concepts.find((i) => i.number === number);
    const body = withSection(issue.body, newAgentSection(keys, report.new_agents));
    if (body !== issue.body) await write(`update #${number}`, () => gh(`/issues/${number}`, { method: "PATCH", body: JSON.stringify({ body }) }));
  }

  for (const g of report.agent_updates) {
    const title = updateTitle(g);
    const issue = issues.find((i) => i.title === title);
    if (issue) {
      const body = withSection(issue.body, updateSection(g));
      if (body !== issue.body) await write(`update #${issue.number}`, () => gh(`/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ body }) }));
    } else {
      const body = withSection("Feedback on a document produced a change to this agent that passed its own fixtures.", updateSection(g));
      await write(`create "${title}"`, () => gh("/issues", { method: "POST", body: JSON.stringify({ title, body }) }));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
