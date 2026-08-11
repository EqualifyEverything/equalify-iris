import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentIssue, createAgentUpdateIssue } from "../src/github/issue.ts";

// Both filing paths dedupe by issue TITLE against an open-issue search, and both
// swallow a failure of that search and file anyway. That trade is deliberate — a
// duplicate issue is cheaper than a lost contribution — but it means the dedupe has
// exactly one failure mode that is invisible: if the search never MATCHES (a changed
// title format, a query GitHub rejects), every path still works and every run files a
// duplicate under a real user's name (PRD §12). Nothing fails, so nothing says so.
//
// The e2e cannot catch it: its mock answers the search with a 404, which lands in the
// swallow branch, so every e2e run exercises "search unavailable" and never "search
// found the duplicate". These tests drive the match itself.
//
// The TITLE is the whole identity of these issues now. They used to carry a label as
// well, and the dedupe used to filter on it — but GitHub silently drops labels set by
// a filer without push access, which is the typical filer, so the label was absent on
// exactly the issues that most needed deduping. Nothing here may reintroduce one: a
// label the filer cannot set is worse than no label, because it reads as present in
// the code and is missing in the repository.

interface Call {
  method: string;
  path: string;
  query: string | null;
  body: unknown;
}

// A GitHub that answers the search with `items` and records what it was asked.
function mockGitHub(items: { title: string }[], opts: { searchStatus?: number } = {}): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  restore: () => void;
} {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = String(init?.body);
    }
    calls.push({ method, path: url.pathname, query: url.searchParams.get("q"), body });

    const j = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/search/issues") {
      if (opts.searchStatus) return j(opts.searchStatus, { message: "nope" });
      return j(200, { total_count: items.length, incomplete_results: false, items });
    }
    // Deliberately NO handler for /labels/ — nothing may touch it any more, and an
    // unhandled path 404s loudly through `calls` if something does.
    if (url.pathname.endsWith("/issues")) return j(201, { html_url: "https://github.com/example/iris/issues/1" });
    return j(404, { message: `unhandled ${method} ${url.pathname}` });
  }) as unknown as typeof globalThis.fetch;
  globalThis.fetch = fetch;
  return { fetch, calls, restore: () => { globalThis.fetch = realFetch; } };
}

const API = "https://api.github.test";
const REPO = "https://github.com/example/iris";

const newAgentArgs = {
  agentName: "chartData",
  agentMarkdown: "# ChartData Agent\n",
  reason: "a chart the page pass flattened",
  sourcePage: "page-001.png",
  sessionId: "ses_test",
};

const updateArgs = {
  agentName: "page.md",
  agentMarkdown: "# Page Agent\n",
  summary: "handle nested lists",
  diffPreview: "- old\n+ new",
  sessionId: "ses_test",
};

test("a new-agent suggestion that already has an open issue is not filed again", async () => {
  // The title the dedupe matches on is built inside createAgentIssue, so this pins the
  // FORMAT as well as the comparison: change the title and this fails, which is the
  // point — a silently-changed title would dedupe against nothing forever.
  const gh = mockGitHub([{ title: "New agent suggestion: chartData" }]);
  try {
    const url = await createAgentIssue("ghu_user", REPO, API, newAgentArgs);
    assert.equal(url, null, "filed a duplicate of an issue that already exists");
    assert.equal(
      gh.calls.some((c) => c.method === "POST" && c.path.endsWith("/issues")),
      false,
      "returned null but created the issue anyway",
    );
    // The query has to be narrow enough to be meaningful: scoped to the repo, to open
    // issues, and to the full title — otherwise it drags in unrelated issues, and
    // while the title comparison still rejects them, a 1000-result search page could
    // push the real match off the end.
    const q = gh.calls.find((c) => c.path === "/search/issues")?.query ?? "";
    assert.match(q, /repo:example\/iris/);
    assert.match(q, /is:issue is:open/);
    assert.match(q, /"New agent suggestion: chartData" in:title/);
    assert.doesNotMatch(q, /label:/, "went back to filtering on a label the filer may not be able to set");
  } finally {
    gh.restore();
  }
});

test("neither path sends a label, or touches the labels API", async () => {
  // The actual fix, and the regression that matters. A label set by a filer without
  // push access is DROPPED by GitHub at 201 with nothing in the response to say so —
  // and that is the typical filer here (PRD §12: any authenticated user contributes).
  // So a reintroduced label would be absent in the repository while looking present in
  // the code, and it would take the dedupe down with it: the search filtered on the
  // label, so unlabeled issues were invisible to it and every later session refiled
  // the same suggestion under another real person's name.
  //
  // Both paths are checked because they had a label each, and `ensureLabel`'s two
  // calls (get-then-create, both needing push access) are gone with them.
  for (const [what, file] of [
    ["suggestion", () => createAgentIssue("ghu_user", REPO, API, newAgentArgs)],
    ["update", () => createAgentUpdateIssue("ghu_user", REPO, API, updateArgs)],
  ] as const) {
    const gh = mockGitHub([]);
    try {
      assert.notEqual(await file(), null, `${what}: did not file at all`);
      const created = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues"));
      assert.ok(created, `${what}: no issue was created`);
      const sent = created.body as { title?: string; labels?: unknown };
      assert.equal("labels" in sent, false, `${what}: sent a labels field GitHub may silently drop`);
      assert.equal(
        gh.calls.some((c) => c.path.includes("/labels")),
        false,
        `${what}: called the labels API, which needs push access the filer may not have`,
      );
      // The title prefix is what replaced the label as the identity of these issues, so
      // it is now load-bearing for both triage and dedupe.
      assert.match(String(sent.title), /^(New agent suggestion|Agent update proposal): /, `${what}: title prefix lost`);
    } finally {
      gh.restore();
    }
  }
});

test("a near-miss title is not treated as a duplicate", async () => {
  // The search is a full-text `in:title` match, so it returns near misses —
  // `chartDataAgent` when asked about `chartData`, a closed-and-reopened variant, or
  // another agent whose name contains this one. The exact-title comparison is what
  // makes those file rather than silently vanish, and it is easy to relax by accident
  // into `.includes`.
  const gh = mockGitHub([
    { title: "New agent suggestion: chartDataAgent" },
    { title: "New agent suggestion: chartdata" },
    { title: "Agent update proposal: chartData" },
  ]);
  try {
    const url = await createAgentIssue("ghu_user", REPO, API, newAgentArgs);
    assert.equal(url, "https://github.com/example/iris/issues/1", "a near-miss title suppressed a real suggestion");
  } finally {
    gh.restore();
  }
});

test("an update proposal that already has an open issue is not filed again", async () => {
  // Same contract on the other path, and its title drops the `.md` the caller passes.
  const gh = mockGitHub([{ title: "Agent update proposal: page" }]);
  try {
    const url = await createAgentUpdateIssue("ghu_user", REPO, API, updateArgs);
    assert.equal(url, null, "filed a duplicate update proposal");
    assert.equal(
      gh.calls.some((c) => c.method === "POST" && c.path.endsWith("/issues")),
      false,
      "returned null but created the issue anyway",
    );
    const q = gh.calls.find((c) => c.path === "/search/issues")?.query ?? "";
    assert.match(q, /"Agent update proposal: page" in:title/);
    assert.doesNotMatch(q, /label:/, "went back to filtering on a label the filer may not be able to set");
  } finally {
    gh.restore();
  }
});

test("the two paths do not dedupe against each other", async () => {
  // Distinct labels and distinct title prefixes, deliberately: a proposal to UPDATE
  // page.md must not be suppressed by an open suggestion for a NEW page agent, and
  // maintainers triage the two separately.
  const gh = mockGitHub([{ title: "New agent suggestion: page" }]);
  try {
    const url = await createAgentUpdateIssue("ghu_user", REPO, API, { ...updateArgs, agentName: "page.md" });
    assert.notEqual(url, null, "a new-agent suggestion suppressed an update proposal");
  } finally {
    gh.restore();
  }
});

test("an unavailable search files anyway rather than failing", async () => {
  // The deliberate trade, pinned so it stays deliberate: a duplicate issue is cheaper
  // than a lost contribution. Search is the most rate-limited GitHub endpoint there
  // is (30/min), so this branch is reached in normal operation, not just in outages.
  for (const status of [403, 404, 422, 503]) {
    const gh = mockGitHub([], { searchStatus: status });
    try {
      const url = await createAgentIssue("ghu_user", REPO, API, newAgentArgs);
      assert.equal(url, "https://github.com/example/iris/issues/1", `a ${status} from search lost the contribution`);
    } finally {
      gh.restore();
    }
  }
});
