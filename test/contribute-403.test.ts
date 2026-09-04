import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContribution } from "../src/pipeline/contribute.ts";
import { installHintFor } from "../src/github/issue.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Issue filing fails softly on purpose — a contribution is a side effect, and a
// GitHub outage must not fail a document the user already paid for. But filing is
// also the point of the design (every session gives back under the user's
// own identity), so a permissions failure means the deployment is silently not
// contributing while looking healthy — and it lands as a single log line, several
// steps from its cause: the permission was granted on github.com, when the GitHub
// App was installed, possibly by a different person than the one reading the log.
//
// Under a GitHub App there is one cause on the user path and config cannot show it:
// the app is not installed on `upstream_repo` (or its installation no longer grants
// Issues write). A user-to-server token carries the user's identity but takes its
// repository permission from the installation, so with no installation no user can
// file — and nothing at startup can tell, because the install state is not in config.
// The log line has to carry that diagnosis.
//
// A hint that fires on the wrong failure is worse than no hint, because an
// operator reading it mid-incident acts on it. Three ways this one could: a
// rate-limit 403, a 403 from the SERVICE token (whose scopes live on github.com and
// have nothing to do with the app's installation), and a "403" that came from the
// model provider and never reached GitHub at all. There is a test for each.

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
  failure: Failure,
  opts: { issueToken?: string; draftError?: Error } = {},
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

test("a 403 from issue filing names the app's installation as the likely cause", async () => {
  const data = await contribute({ status: 403, body: "Resource not accessible by personal access token" });
  assert.match(String(data.error), /Resource not accessible/);
  assert.doesNotMatch(String(data.error), /403/, "GitHub's message carries the code after all — see the note above");
  const hint = String(data.hint ?? "");
  assert.match(hint, /403/);
  assert.match(hint, /install/i, "the hint did not name the installation as the cause");
  assert.match(hint, /Issues/i, "the hint did not say which permission is needed");
  // Where to go and fix it. The permission is not in any file the operator has.
  assert.match(hint, /settings\/installations/, "the hint did not say where to fix it");
  // Why it is not one user's problem — the failure is deployment-wide, which is the
  // part that decides how urgently an operator treats it.
  assert.match(hint, /every user/i, "the hint did not convey that this affects all users");
});

test("a missing installation is diagnosed on its 404, which is how GitHub reports it", async () => {
  // The cause this hint exists for does NOT produce a 403. GitHub does not reveal
  // repositories a credential cannot see, so an app that was never installed reads as
  // "no such repo". Diagnosing only 403 would miss it entirely.
  const data = await contribute({ status: 404, body: "Not Found" });
  const hint = String(data.hint ?? "");
  assert.match(hint, /404/, "a 404 from issue filing got no diagnosis at all");
  assert.match(hint, /not\s+installed/i, "the hint did not name the uninstalled-app cause");
  assert.match(hint, /settings\/installations/, "the hint did not say where to fix it");
  // 404 is genuinely ambiguous — a typo in upstream_repo looks identical — so the
  // hint must offer that too rather than asserting the installation confidently.
  assert.match(hint, /misspelled|spelled/i, "the hint asserted the installation for an ambiguous 404");
  // And the third cause, which is NOT a misconfiguration of the app at all: a user's
  // token is the intersection of the installation's permissions and that user's own
  // access, so a private upstream 404s for a user who cannot see it however correctly
  // the app is installed. Without this the hint sends a private-upstream operator to
  // re-install a working installation, and never names the fix (issue_token).
  assert.match(hint, /private/i, "the hint omitted the private-upstream cause of a 404");
  assert.match(hint, /issue_token/, "named the private-upstream cause without its remedy");
  // The "affects every user" framing is shared with the 403 branch, so on a 404 it has
  // to be CONDITIONAL rather than dropped: an operator told flatly that every user is
  // broken, while some of their users file fine, discards the whole hint as wrong.
  assert.match(
    hint,
    /if the installation is the cause/,
    "asserted a deployment-wide failure for a 404 that can be one user's own access",
  );
});

test("a 404 under a service token still points at the PAT", async () => {
  // The app's installation is irrelevant to the outcome here, which is the point:
  // with `issue_token` set, the PAT is the credential that made the call.
  const data = await contribute({ status: 404, body: "Not Found" }, { issueToken: "ghp_service" });
  const hint = String(data.hint ?? "");
  assert.match(hint, /issue_token/, "did not name the credential that actually failed");
  assert.match(hint, /404/);
  assert.doesNotMatch(hint, /Install the app/, "told the operator to install the app for a PAT failure");
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
  // GitHub answers 403 for primary and secondary rate limits too, where permissions
  // are irrelevant. A confident "install the app" would send a throttled operator to
  // re-install a perfectly good installation.
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

test("a service-token 403 blames the PAT, not the app's installation", async () => {
  // With `issue_token` set, the failing credential is a service PAT whose scopes live
  // on github.com. The app's installation governs only tokens issued to users, so
  // naming it here would send an operator to change something that cannot affect this
  // failure — and re-installing is not a harmless no-op to suggest mid-incident.
  const data = await contribute({ status: 403, body: "Resource not accessible by integration" }, {
    issueToken: "ghp_service",
  });
  const hint = String(data.hint ?? "");
  assert.match(hint, /issue_token/, "did not name the credential that actually failed");
  // The user path's phrasing is the imperative "Install the app on upstream_repo".
  // This branch must not produce it — it may mention the installation only to rule it
  // out, which the next assertion pins.
  assert.doesNotMatch(hint, /Install the app/, "told the operator to install the app for a PAT failure");
  assert.match(hint, /installation is not involved/, "left the reader to wonder about the app");
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
  assert.equal(data.hint, undefined, "blamed the app's installation for a model-provider failure");
  assert.equal(data.stage, "draft", "a provider failure was not distinguishable from a filing failure");
});

test("a thrown non-object cannot make the diagnosis itself throw", async () => {
  // Called directly: Octokit re-wraps whatever fetch throws, so a bare `throw null`
  // cannot be injected through the pipeline. The guard still matters — this runs
  // INSIDE the caller's catch, after the document has been delivered and
  // `run_complete` logged, so throwing here would flip a finished session to
  // `failed` (the orchestrator's outer catch). Cheap to make impossible.
  for (const thrown of [null, undefined, "just a string", 403]) {
    assert.equal(
      installHintFor(thrown, { usingServiceToken: false }),
      undefined,
      `threw or hinted for ${JSON.stringify(thrown)}`,
    );
  }
});
