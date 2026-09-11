import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContribution } from "../src/pipeline/contribute.ts";
import { installHintFor } from "../src/github/issue.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Issue filing fails softly on purpose — a contribution is a side effect, and a GitHub
// outage must not fail a document the user already paid for. But filing is also the point
// of the design, so a permissions failure means the deployment is silently not contributing
// while looking healthy — and it lands as a single log line, one step from its cause: what
// `github.token` may do was decided on github.com, not in any file the operator has.
//
// There is one credential now, so the hint has one thing to name. What it must still get
// right is WHEN to fire, because a hint on the wrong failure is worse than no hint: an
// operator reads it mid-incident and acts on it. Three ways this one could misfire — a
// rate-limit 403, a "403" that came from the model provider and never reached GitHub, and a
// thrown non-object — and there is a test for each.

interface Rec {
  events: { type: string; data: Record<string, unknown> }[];
}

// A GitHub that fails: either an HTTP status (Octokit turns it into a RequestError
// carrying `.status`, which is what the production code reads) or a thrown error
// for the transport-failure case. Injected as a Response rather than as a thrown
// RequestError because Octokit re-wraps anything fetch throws and the injected
// `.status` would not survive — which is exactly the detail the code depends on.
type Failure = { status: number; body?: string; headers?: Record<string, string> } | Error;

function makeCtx(
  dir: string,
  failure: Failure,
  opts: { draftError?: Error } = {},
): { ctx: PipelineContext; rec: Rec } {
  const agentsDir = join(dir, "agents");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

  const rec: Rec = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    githubToken: "ghp_deployment",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }],
    cfg: {
      github: {
        upstream_repo: "https://github.com/example/iris",
        api_base_url: "http://127.0.0.1:1/never-listening",
      },
    },
    paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
    router: {
      // Drafting the agent markdown has to succeed for the code to reach the
      // issue-filing call at all — unless the test is about the draft failing.
      complete: async () => {
        if (opts.draftError) throw opts.draftError;
        return { text: "# Chart Agent\n\n## Required capability\nvision\n" };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  // The failure under test comes from the issue call, which reaches GitHub through
  // Octokit's fetch. Every request fails the same way — the label lookup and the
  // duplicate search are already swallowed by createAgentIssue's own try/catch, so
  // the one that surfaces is `issues.create`.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (failure instanceof Error) throw failure;
    return new Response(JSON.stringify({ message: failure.body ?? "failed" }), {
      status: failure.status,
      headers: { "content-type": "application/json", ...failure.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  (ctx as unknown as { __restore: () => void }).__restore = () => {
    globalThis.fetch = realFetch;
  };
  return { ctx, rec };
}

async function contribute(
  failure: Failure,
  opts: { draftError?: Error } = {},
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "iris-403-"));
  const { ctx, rec } = makeCtx(dir, failure, opts);
  try {
    await runContribution(ctx, [{ name: "chartDataAgent", reason: "test", image: "page-001.png" }]);
  } finally {
    (ctx as unknown as { __restore: () => void }).__restore();
    rmSync(dir, { recursive: true, force: true });
  }
  const failed = rec.events.filter((e) => e.type === "agent_issue_failed");
  assert.equal(failed.length, 1, `expected one agent_issue_failed, got ${JSON.stringify(rec.events)}`);
  return failed[0].data;
}

// Octokit's RequestError carries the code on `.status`; its `message` is GitHub's
// prose ("Resource not accessible by personal access token") and does not contain
// "403" — so matching on the text alone would never fire, and matching on it as a
// FALLBACK catches the wrong things (see the provider test at the bottom). The
// status is the only signal. These tests assert that by sending real statuses and
// never a message containing the code.

test("a 403 from issue filing names github.token and the permission it needs", async () => {
  const data = await contribute({ status: 403, body: "Resource not accessible by personal access token" });
  assert.match(String(data.error), /Resource not accessible/);
  assert.doesNotMatch(String(data.error), /403/, "GitHub's message carries the code after all — see the note above");
  const hint = String(data.hint ?? "");
  assert.match(hint, /403/);
  // The config key, because that is where the operator has to go, and the permission,
  // because a PAT with the wrong one produces exactly this.
  assert.match(hint, /github\.token/, "the hint did not name the credential that failed");
  assert.match(hint, /Issues: read and write/i, "the hint did not say which permission is needed");
  assert.match(hint, /expired/i, "the hint omitted expiry, which fails here identically");
  // How much is broken decides how urgently an operator reads this, and under one
  // identity the answer is always "everything".
  assert.match(hint, /every filing/i, "the hint did not convey that this affects all filings");
});

test("a 404 is diagnosed too, because that is how GitHub reports no access", async () => {
  // The likeliest cause does NOT produce a 403: GitHub does not reveal repositories a
  // credential cannot see, so a token without access reads as "no such repo". Diagnosing
  // only 403 would miss it entirely.
  const data = await contribute({ status: 404, body: "Not Found" });
  const hint = String(data.hint ?? "");
  assert.match(hint, /404/, "a 404 from issue filing got no diagnosis at all");
  assert.match(hint, /github\.token/, "the hint did not name the credential that failed");
  // 404 is genuinely ambiguous — a typo in upstream_repo looks identical — so the hint
  // must offer that rather than asserting permissions confidently.
  assert.match(hint, /misspelled|spelled/i, "the hint asserted permissions for an ambiguous 404");
  // And the 403 branch must NOT carry the ambiguity clause: a 403 is not GitHub hiding a
  // repository, so offering "or you misspelled it" there would send an operator to check
  // a name that is demonstrably correct.
  const forbidden = await contribute({ status: 403, body: "Resource not accessible by personal access token" });
  assert.doesNotMatch(String(forbidden.hint), /misspelled/i, "offered the 404 ambiguity for a 403");
});

test("a non-permissions failure gets no permissions hint", async () => {
  // A 500, a timeout or a DNS failure has nothing to do with permissions, and a
  // hint on every failure would train an operator to ignore it.
  const data = await contribute({ status: 500, body: "Internal Server Error" });
  assert.equal(data.hint, undefined, "hinted at permissions for a server error");
  assert.match(String(data.error), /Internal Server Error/);

  const network = await contribute(new Error("fetch failed"));
  assert.equal(network.hint, undefined, "hinted at permissions for a network failure");
});

test("a rate-limit 403 gets no permissions hint", async () => {
  // GitHub answers 403 for primary and secondary rate limits too, where permissions are
  // irrelevant. A confident "check that PAT" would send a throttled operator to rotate a
  // perfectly good token.
  // The body deliberately does NOT say "rate limit", so this exercises the header
  // and not the text fallback — otherwise the two checks would be indistinguishable
  // and one of them could be dead.
  const primary = await contribute({
    status: 403,
    body: "Resource not accessible by personal access token",
    headers: { "x-ratelimit-remaining": "0" },
  });
  assert.equal(primary.hint, undefined, "blamed permissions for a primary rate limit");

  // The secondary limit says so in prose rather than in a header.
  const secondary = await contribute({
    status: 403,
    body: "You have exceeded a secondary rate limit. Please wait a few minutes.",
  });
  assert.equal(secondary.hint, undefined, "blamed permissions for a secondary rate limit");

  // And a genuine permissions 403 with rate-limit budget REMAINING still hints — the
  // header is only disqualifying when it reads 0.
  const real = await contribute({
    status: 403,
    body: "Resource not accessible by personal access token",
    headers: { "x-ratelimit-remaining": "4999" },
  });
  assert.match(String(real.hint), /403/, "a real permissions failure lost its hint");
});

test("the hint sends nobody to a GitHub App installation, which is no longer involved", async () => {
  // The removed design authenticated users through a GitHub App, so both branches of the
  // old hint pointed at github.com/settings/installations. Nothing installs anything now —
  // the credential is a PAT — and re-installing an app is not a harmless thing to suggest
  // mid-incident. Both statuses are checked because the stale advice used to live in both.
  for (const status of [403, 404]) {
    const data = await contribute({ status, body: "Not Found" });
    const hint = String(data.hint ?? "");
    assert.doesNotMatch(hint, /install/i, `${status}: told the operator to install a GitHub App`);
    assert.doesNotMatch(hint, /issue_token|anonymous_token/, `${status}: named a config key that no longer exists`);
  }
});

test("a 403 that only says so in its message is NOT treated as a GitHub failure", async () => {
  // The message fallback used to exist for a re-wrapped Octokit throw. It cost
  // more than it bought: a provider error is a plain
  // `Error("openrouter 403: ...")` (src/providers/openrouter.ts), which matched it
  // and produced a GitHub-permissions hint for a call that never reached GitHub.
  const data = await contribute(new Error("HTTP 403 while creating issue"));
  assert.equal(data.hint, undefined, "matched 403 in the message text, which a provider error can carry");
});

test("a provider 403 while drafting is not diagnosed as a GitHub permissions problem", async () => {
  // draftAgent is a model call. OpenRouter formats the status into the message, so
  // a blocked key or a moderation refusal arrives as "openrouter 403: ...". It is
  // reported under its own stage and gets no permissions hint.
  const data = await contribute({ status: 403, body: "unused" }, {
    draftError: new Error("openrouter 403: {\"error\":{\"message\":\"key disabled\"}}"),
  });
  assert.match(String(data.error), /openrouter 403/);
  assert.equal(data.hint, undefined, "blamed the GitHub credential for a model-provider failure");
  assert.equal(data.stage, "draft", "a provider failure was not distinguishable from a filing failure");
});

test("a thrown non-object cannot make the diagnosis itself throw", async () => {
  // Called directly: Octokit re-wraps whatever fetch throws, so a bare `throw null`
  // cannot be injected through the pipeline. The guard still matters — this runs
  // INSIDE the caller's catch, after the document has been delivered and
  // `run_complete` logged, so throwing here would flip a finished session to
  // `failed` (the orchestrator's outer catch). Cheap to make impossible.
  for (const thrown of [null, undefined, "just a string", 403]) {
    assert.equal(installHintFor(thrown), undefined, `threw or hinted for ${JSON.stringify(thrown)}`);
  }
});
