import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContribution } from "../src/pipeline/contribute.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Issue filing fails softly on purpose — a contribution is a side effect, and a
// GitHub outage must not fail a document the user already paid for. But that means
// a scope misconfiguration lands as a single log line, several steps from its
// cause: the scope was decided at consent time, by a config key, possibly by a
// previous operator. `loadConfig` rejects the one combination it can see
// (`oauth_scope: none` with no `issue_token`); the two it cannot are a PRIVATE
// upstream under the `public_repo` default, and a token issued before the scope
// was narrowed. For those, the log line has to carry the diagnosis.
//
// A hint that fires on the wrong failure is worse than no hint, because an
// operator reading it mid-incident acts on it. Three ways this one could: a
// rate-limit 403, a 403 from the SERVICE token (whose scopes have nothing to do
// with `oauth_scope`), and a "403" that came from the model provider and never
// reached GitHub at all. There is a test for each.

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
  scope: string,
  failure: Failure,
  opts: { issueToken?: string; draftError?: Error } = {},
): { ctx: PipelineContext; rec: Rec } {
  const agentsDir = join(dir, "agents");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

  const rec: Rec = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    githubToken: "gho_user",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }],
    cfg: {
      github: {
        upstream_repo: "https://github.com/example/iris",
        api_base_url: "http://127.0.0.1:1/never-listening",
        oauth_scope: scope,
        issue_token: opts.issueToken,
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
  scope: string,
  failure: Failure,
  opts: { issueToken?: string; draftError?: Error } = {},
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "iris-403-"));
  const { ctx, rec } = makeCtx(dir, scope, failure, opts);
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

test("a 403 from issue filing names the scope as the likely cause", async () => {
  const data = await contribute("public_repo", { status: 403, body: "Resource not accessible by personal access token" });
  assert.match(String(data.error), /Resource not accessible/);
  assert.doesNotMatch(String(data.error), /403/, "GitHub's message carries the code after all — see the note above");
  const hint = String(data.hint ?? "");
  assert.match(hint, /403/);
  // The configured value, so an operator reading the log does not have to go and
  // look it up to know whether it is the problem.
  assert.match(hint, /public_repo/, "the hint did not report the configured scope");
  assert.match(hint, /private/, "the hint did not mention the private-upstream case");
  // The other cause a config file cannot show: an already-issued token.
  assert.match(hint, /re-authoriz/i, "the hint did not mention pre-existing tokens");
});

test("a scopeless deployment reports `none` rather than an empty string", async () => {
  // `oauth_scope` is "" internally — the normalized form of `none`. Interpolating
  // it raw would print `github.oauth_scope is ""`, which reads as unset rather
  // than as the deliberate setting the operator wrote.
  const data = await contribute("", { status: 403, body: "Resource not accessible" });
  assert.match(String(data.hint), /is "none"/, "the hint printed an empty scope instead of `none`");
});

test("a non-403 failure gets no scope hint", async () => {
  // A 500, a timeout or a DNS failure has nothing to do with the scope, and a
  // hint on every failure would train an operator to ignore it.
  const data = await contribute("public_repo", { status: 500, body: "Internal Server Error" });
  assert.equal(data.hint, undefined, "hinted at the scope for a server error");
  assert.match(String(data.error), /Internal Server Error/);

  const network = await contribute("public_repo", new Error("fetch failed"));
  assert.equal(network.hint, undefined, "hinted at the scope for a network failure");
});

test("a rate-limit 403 gets no scope hint", async () => {
  // GitHub answers 403 for primary and secondary rate limits too, where the scope
  // is irrelevant. A confident "your oauth_scope is wrong" would send a throttled
  // operator to the wrong config key.
  // The body deliberately does NOT say "rate limit", so this exercises the header
  // and not the text fallback — otherwise the two checks would be indistinguishable
  // and one of them could be dead.
  const primary = await contribute("public_repo", {
    status: 403,
    body: "Resource not accessible by personal access token",
    headers: { "x-ratelimit-remaining": "0" },
  });
  assert.equal(primary.hint, undefined, "blamed the scope for a primary rate limit");

  // The secondary limit says so in prose rather than in a header.
  const secondary = await contribute("public_repo", {
    status: 403,
    body: "You have exceeded a secondary rate limit. Please wait a few minutes.",
  });
  assert.equal(secondary.hint, undefined, "blamed the scope for a secondary rate limit");

  // And a genuine scope 403 with rate-limit budget REMAINING still hints — the
  // header is only disqualifying when it reads 0.
  const scoped = await contribute("public_repo", {
    status: 403,
    body: "Resource not accessible by personal access token",
    headers: { "x-ratelimit-remaining": "4999" },
  });
  assert.match(String(scoped.hint), /403/, "a real scope failure lost its hint");
});

test("a service-token 403 blames the PAT, not oauth_scope", async () => {
  // With `issue_token` set, the failing credential is a service PAT whose scopes
  // live on github.com. `oauth_scope` governs only tokens issued to users, so
  // naming it here would send an operator to widen the user grant this service
  // exists to keep narrow — to fix a failure widening it cannot touch. And this is
  // the shape the README recommends for production (`issue_token` + `none`), so it
  // is the most likely 403 an operator will ever read.
  const data = await contribute("", { status: 403, body: "Resource not accessible by integration" }, {
    issueToken: "ghp_service",
  });
  const hint = String(data.hint ?? "");
  assert.match(hint, /issue_token/, "did not name the credential that actually failed");
  // The user path's phrasing is `github.oauth_scope is "<value>"`, i.e. the key
  // reported as the thing to change. This branch must not produce it — it may
  // mention the key only to rule it out, which the next assertion pins.
  assert.doesNotMatch(hint, /oauth_scope is "/, "pointed at oauth_scope for a service-token failure");
  assert.match(hint, /oauth_scope is not involved/, "left the reader to wonder about the other key");
});

test("a 403 that only says so in its message is NOT treated as a GitHub failure", async () => {
  // The message fallback used to exist for a re-wrapped Octokit throw. It cost
  // more than it bought: a provider error is a plain
  // `Error("openrouter 403: ...")` (src/providers/openrouter.ts), which matched it
  // and produced a GitHub-permissions hint for a call that never reached GitHub.
  const data = await contribute("repo", new Error("HTTP 403 while creating issue"));
  assert.equal(data.hint, undefined, "matched 403 in the message text, which a provider error can carry");
});

test("a provider 403 while drafting is not diagnosed as a GitHub scope problem", async () => {
  // draftAgent is a model call. OpenRouter formats the status into the message, so
  // a blocked key or a moderation refusal arrives as "openrouter 403: ...". It is
  // reported under its own stage and gets no scope hint.
  const data = await contribute("public_repo", { status: 403, body: "unused" }, {
    draftError: new Error("openrouter 403: {\"error\":{\"message\":\"key disabled\"}}"),
  });
  assert.match(String(data.error), /openrouter 403/);
  assert.equal(data.hint, undefined, "blamed github.oauth_scope for a model-provider failure");
  assert.equal(data.stage, "draft", "a provider failure was not distinguishable from a filing failure");
});
