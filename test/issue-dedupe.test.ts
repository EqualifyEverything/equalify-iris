import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentIssue, createAgentUpdateIssue, AGENT_LABEL, AGENT_UPDATE_LABEL } from "../src/github/issue.ts";

// Both filing paths dedupe by issue TITLE against an open-issue search, and both
// swallow a failure of that search and file anyway. That trade is deliberate — a
// duplicate issue is cheaper than a lost contribution — but it means the dedupe has
// exactly one failure mode that is invisible: if the search never MATCHES (a changed
// title format, a renamed label, a query GitHub rejects), every path still works and
// every run files a duplicate under a real user's name (PRD §12). Nothing fails, so
// nothing says so.
//
// The e2e cannot catch it: its mock answers the search with a 404, which lands in the
// swallow branch, so every e2e run exercises "search unavailable" and never "search
// found the duplicate". These tests drive the match itself.

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
    // Label lookup: present, so ensureLabel is a no-op.
    if (url.pathname.includes("/labels/")) return j(200, { name: "label" });
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
    // issues, and to the label — otherwise it matches unrelated issues and suppresses
    // a real contribution.
    const q = gh.calls.find((c) => c.path === "/search/issues")?.query ?? "";
    assert.match(q, /repo:example\/iris/);
    assert.match(q, /is:issue is:open/);
    assert.match(q, new RegExp(`label:"${AGENT_LABEL}"`));
  } finally {
    gh.restore();
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
    assert.match(q, new RegExp(`label:"${AGENT_UPDATE_LABEL}"`));
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
