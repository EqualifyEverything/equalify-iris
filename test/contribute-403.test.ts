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

interface Rec {
  events: { type: string; data: Record<string, unknown> }[];
}

// A GitHub that fails: either an HTTP status (Octokit turns it into a RequestError
// carrying `.status`, which is what the production code reads) or a thrown error
// for the transport-failure case. Injected as a Response rather than as a thrown
// RequestError because Octokit re-wraps anything fetch throws and the injected
// `.status` would not survive — which is exactly the detail the code depends on.
type Failure = { status: number; body?: string } | Error;

function makeCtx(dir: string, scope: string, failure: Failure): { ctx: PipelineContext; rec: Rec } {
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
      },
    },
    paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
    router: {
      // Drafting the agent markdown has to succeed for the code to reach the
      // issue-filing call at all.
      complete: async () => ({ text: "# Chart Agent\n\n## Required capability\nvision\n" }),
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
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  (ctx as unknown as { __restore: () => void }).__restore = () => {
    globalThis.fetch = realFetch;
  };
  return { ctx, rec };
}

async function contribute(scope: string, failure: Failure): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "iris-403-"));
  const { ctx, rec } = makeCtx(dir, scope, failure);
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
// "403" — so matching on the text alone would never fire. These tests assert that
// by sending real statuses and never a message containing the code.

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

test("a 403 that only says so in its message still hints", async () => {
  // A non-Octokit throw (or a wrapped one) has no `.status`, so the text is the
  // fallback path.
  const data = await contribute("repo", new Error("HTTP 403 while creating issue"));
  assert.match(String(data.hint), /403/);
});
