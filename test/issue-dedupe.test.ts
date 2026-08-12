import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentIssue, createAgentUpdateIssue } from "../src/github/issue.ts";
import { lessonSlug } from "../src/pipeline/memory.ts";

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

// A GitHub that answers the search with `items` and records what it was asked. Search
// items carry a `number`/`html_url` as the real API's do, because the update path now
// COMMENTS on a match rather than skipping it, and it needs the issue number to do so.
function mockGitHub(
  items: { title: string; number?: number; html_url?: string }[],
  opts: { searchStatus?: number } = {},
): {
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
      const withDefaults = items.map((i, n) => ({
        number: n + 7,
        html_url: `https://github.com/example/iris/issues/${n + 7}`,
        ...i,
      }));
      return j(200, { total_count: withDefaults.length, incomplete_results: false, items: withDefaults });
    }
    // Deliberately NO handler for /labels/ — nothing may touch it any more, and an
    // unhandled path 404s loudly through `calls` if something does.
    if (url.pathname.endsWith("/comments")) {
      return j(201, { html_url: "https://github.com/example/iris/issues/7#issuecomment-1" });
    }
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

// No `lessonSlug`: the fallback shape, for a proposal with no recorded lesson to key on.
const updateArgs = {
  agentName: "page.md",
  agentMarkdown: "# Page Agent\n",
  summary: "handle nested lists",
  diffPreview: "- old\n+ new",
  sessionId: "ses_test",
};

// The normal shape, and the one the dedupe is meant to work on. `createAgentUpdateIssue`
// takes the slug from its caller and never recomputes it, so the literal below pins the
// title FORMAT rather than the slug rule — a change to the title shape fails these tests
// instead of deduping against nothing forever. The fixture is still the genuine output of
// `lessonSlug` for this instruction, which the next test checks rather than assumes.
const LESSON_INSTRUCTION = "Preserve all hyperlinks from the source document, including inline links in body text.";
const LESSON_SLUG = "preserve all hyperlinks from the source document";
const SLUGGED_TITLE = `Agent update proposal: page — ${LESSON_SLUG}`;

const updateArgsWithLesson = {
  ...updateArgs,
  lessonSlug: LESSON_SLUG,
  lesson: {
    instruction: LESSON_INSTRUCTION,
    feedback: "Links from original document need to be inherited. They were not.",
    count: 2,
  },
};

test("the fixtures below use the slug the rule actually produces", () => {
  // Without this, every test here could pass on a slug no real caller would ever pass in,
  // and a slug rule that stopped fitting an issue title would go unnoticed.
  assert.equal(lessonSlug(LESSON_INSTRUCTION), LESSON_SLUG);
});

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

test("the same lesson comments on its open issue instead of vanishing", async () => {
  // The update path's dedupe, which no longer skips. A repeat report of the SAME lesson
  // reaches the issue that already tracks it, carrying its session and its corroboration
  // count — the thing a maintainer wants from a second report.
  //
  // Skipping was the old behaviour, and on this path it was silence: the only trace was
  // a log line reading `url: "(duplicate — skipped)"` inside a session log nobody reads
  // until they go looking for the issue that never appeared.
  const gh = mockGitHub([{ title: SLUGGED_TITLE, number: 67 }]);
  try {
    const filed = await createAgentUpdateIssue("ghu_user", REPO, API, updateArgsWithLesson);
    assert.equal(filed.action, "commented");
    assert.equal(
      gh.calls.some((c) => c.method === "POST" && c.path.endsWith("/issues")),
      false,
      "opened a second issue for a lesson that already had one",
    );
    const comment = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/comments"));
    assert.ok(comment, "the repeat report was dropped: no comment and no issue");
    assert.match(comment.path, /\/issues\/67\/comments$/, "commented on the wrong issue");
    const body = String((comment.body as { body?: string }).body);
    // A comment that does not say WHICH session reported it again is not corroboration,
    // it is noise — the session id is how a maintainer gets back to the run.
    assert.match(body, /ses_test/, "the comment does not name the session");
    assert.match(body, /2 sessions/, "the comment does not carry the corroboration count");
    assert.match(body, /- old\n\+ new/, "the comment does not carry the proposed diff");
    assert.match(body, /# Page Agent/, "the comment does not carry the proposed agent text");
  } finally {
    gh.restore();
  }
});

test("a different lesson for the same agent gets its own issue", async () => {
  // The structural bug this whole slug exists for. `agentFile` on the feedback path is
  // hardcoded to `page.md`, so before the title carried the lesson, EVERY proposal from
  // every user computed one title — `Agent update proposal: page` — and one open issue
  // suppressed all of them indefinitely. Two unrelated lessons must not collide.
  const gh = mockGitHub([{ title: SLUGGED_TITLE, number: 67 }]);
  try {
    const filed = await createAgentUpdateIssue("ghu_user", REPO, API, {
      ...updateArgsWithLesson,
      lessonSlug: "keep table headers on every page",
    });
    assert.equal(filed.action, "created", "an unrelated lesson was folded into another lesson's issue");
    const created = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues"));
    assert.ok(created, "the lesson was neither filed nor commented");
    assert.equal(
      String((created.body as { title?: string }).title),
      "Agent update proposal: page — keep table headers on every page",
    );
  } finally {
    gh.restore();
  }
});

test("an open bare-titled issue does not suppress a slugged proposal", async () => {
  // The state the fix has to unblock, not just avoid recreating: issues filed BEFORE the
  // title carried a lesson are still open on the upstream repo (#67 there), and every one
  // of them matches the bare title every future proposal used to compute. A slugged
  // proposal must file past them rather than treat them as its own duplicate.
  const gh = mockGitHub([{ title: "Agent update proposal: page", number: 67 }]);
  try {
    const filed = await createAgentUpdateIssue("ghu_user", REPO, API, updateArgsWithLesson);
    assert.equal(filed.action, "created", "a legacy bare-titled issue still swallows new lessons");
  } finally {
    gh.restore();
  }
});

test("the update search asks for the slugged title, and no label", async () => {
  // The dedupe can only match what it searches for, so the query has to carry the same
  // title the create does — a slug in the title and a bare title in the query would
  // never match anything, which is the failure mode this file exists to catch (it fails
  // nothing and files a duplicate every time).
  const gh = mockGitHub([]);
  try {
    await createAgentUpdateIssue("ghu_user", REPO, API, updateArgsWithLesson);
    const q = gh.calls.find((c) => c.path === "/search/issues")?.query ?? "";
    assert.match(q, /repo:example\/iris/);
    assert.match(q, /is:issue is:open/);
    assert.equal(q.includes(`"${SLUGGED_TITLE}" in:title`), true, `query did not ask for the slugged title: ${q}`);
    assert.doesNotMatch(q, /label:/, "went back to filtering on a label the filer may not be able to set");
  } finally {
    gh.restore();
  }
});

test("a proposal with no lesson still files, under the bare title", async () => {
  // The fallback path: a correction that trained the prompt without recording a lesson
  // has nothing stable to slug. It files rather than being dropped — the bare title
  // dedupes badly, which is a worse issue list, not a lost contribution.
  const gh = mockGitHub([]);
  try {
    const filed = await createAgentUpdateIssue("ghu_user", REPO, API, updateArgs);
    assert.equal(filed.action, "created");
    const created = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues"));
    assert.equal(String((created?.body as { title?: string }).title), "Agent update proposal: page");
  } finally {
    gh.restore();
  }
});

test("the user's own words reach the issue", async () => {
  // Feedback used to reach GitHub only as a model-written summary and a diff, so a
  // maintainer could not see what the user actually asked for. The verbatim feedback is
  // capped and collapsed to one line (it is untrusted-length form input on a public
  // issue), but it is present.
  const gh = mockGitHub([]);
  try {
    await createAgentUpdateIssue("ghu_user", REPO, API, updateArgsWithLesson);
    const created = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues"));
    const body = String((created?.body as { body?: string }).body);
    assert.match(body, /Links from original document need to be inherited/, "the user's feedback is not on the issue");
    assert.match(body, /2 sessions/, "the corroboration count is not on the issue");
  } finally {
    gh.restore();
  }
});

test("feedback cannot ping strangers or publish links from the issue it lands in", async () => {
  // This is the first thing that puts a user's typed text into an upstream issue body,
  // and GitHub renders markdown there. `@name` pings a real person, `#12` cross-links an
  // unrelated issue, and a link is published — under whichever identity filed, which
  // `github.issue_token` can make a service account rather than the person who typed it.
  // A code span renders none of them, so the feedback has to stay inside one.
  const gh = mockGitHub([]);
  try {
    await createAgentUpdateIssue("ghu_user", REPO, API, {
      ...updateArgsWithLesson,
      lesson: {
        ...updateArgsWithLesson.lesson,
        // The escape attempt is the ``` in the middle: with a fixed one-backtick fence it
        // closes the span and everything after it renders as markdown.
        feedback: "hey @octocat see #1 ``` @everyone [click](http://evil.test)",
      },
    });
    const created = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues"));
    const body = String((created?.body as { body?: string }).body);
    const quoted = body.match(/\*\*In the user's words:\*\* (.*)/)?.[1] ?? "";
    assert.ok(quoted, `the feedback line is missing entirely: ${body}`);
    // The whole thing is one code span: it opens and closes with the SAME run of
    // backticks, and that run is longer than any run the user typed.
    const fence = quoted.match(/^`+/)?.[0] ?? "";
    assert.ok(fence.length >= 4, `fence is not longer than the user's own backtick run: ${quoted}`);
    assert.ok(quoted.endsWith(fence), `the span is not closed with its own fence: ${quoted}`);
    assert.equal(
      quoted.slice(fence.length, -fence.length).includes(fence),
      false,
      "the user's text closes the code span early and escapes into rendered markdown",
    );
    // Present, not stripped: a maintainer needs the words, mentions and all.
    assert.match(quoted, /@octocat/);
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
