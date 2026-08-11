import { Octokit } from "@octokit/rest";

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(url: string): RepoRef {
  const m = url.replace(/\.git$/, "").match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (!m) throw new Error(`cannot parse GitHub repo from "${url}"`);
  return { owner: m[1], repo: m[2] };
}

// Label maintainers can sort/filter agent suggestions by.
export const AGENT_LABEL = "iris-agent-suggestion";

// Why an issue-filing failure was probably about permissions, or undefined if it
// was not.
//
// Both filing paths (a new-agent suggestion and an agent-update proposal) fail
// softly — a contribution is a side effect and a GitHub outage must not fail a
// document the user already paid for — so the log line is the only place the cause
// can appear. And the cause is several steps away from the failure: which credential
// was used depends on config, and what it may do was decided elsewhere, on
// github.com, in a place no config file can show.
//
// Under a GitHub App there are two such causes on the user path, which replaced two
// scope-related ones:
//
//   - The app is NOT INSTALLED on `upstream_repo` (or its installation was removed,
//     or `issues` was never granted write). A user-to-server token carries the
//     user's identity but takes its repository permission from the installation, so
//     with no installation there is no permission — for every user at once. This is
//     the misconfiguration to suspect first, and it cannot be caught at startup: the
//     app's install state lives on github.com, not in config.
//
//   - The USER cannot see `upstream_repo`. A user-to-server token is the intersection
//     of the installation's permissions and that user's own access, so on a private
//     upstream, filing works for collaborators and 404s for everyone else however
//     correctly the app is installed. Distinguishable from the case above by shape
//     rather than by status: it is per-user, not deployment-wide.
//
// Both 403 and 404 are diagnosed, and both user-path causes are usually 404: GitHub
// does not reveal repositories a credential cannot see, so neither reads as a
// permissions error. Treating 403 as the only permissions signal would miss the case
// this hint exists for. That leaves 404 genuinely ambiguous three ways — a misspelled
// `upstream_repo` is identical on the wire too — so the wording names the
// possibilities instead of asserting one.
//
// `usingServiceToken` is load-bearing, not decoration: when `github.issue_token` is
// set it is that PAT that failed, and the app's installation has nothing to do with
// it. Sending an operator to re-install the app to fix a PAT failure would waste the
// one clue they have — and the service-token shape is what the README recommends for
// deployments that cannot file as their users.
export function installHintFor(
  e: unknown,
  opts: { usingServiceToken: boolean },
): { hint: string } | undefined {
  // Octokit's RequestError carries the code on `.status`, and only calls that
  // actually reached GitHub produce one. Deliberately NOT falling back to
  // matching the code in the message: a provider error is a plain
  // `Error("openrouter 403: ...")` (src/providers/openrouter.ts), so the text
  // fallback would attach a GitHub-permissions hint to a failure that never
  // reached GitHub. Callers keep non-GitHub work out of the try as well.
  // Optional-chained: a thrown null would otherwise throw from inside the caller's
  // catch, and that catch runs after the document is already delivered.
  const status = (e as { status?: number } | null)?.status;
  if (status !== 403 && status !== 404) return undefined;
  // GitHub also answers 403 for primary and secondary rate limits, where
  // permissions are irrelevant and this hint would send an operator to re-install a
  // working app. Checked on the response headers first (`x-ratelimit-remaining: 0`
  // is the primary-limit signal) and on the message text for the secondary limit,
  // which says so in prose rather than in a header.
  const message = (e as Error | null)?.message ?? "";
  const headers = (e as { response?: { headers?: Record<string, string> } } | null)?.response?.headers ?? {};
  if (headers["x-ratelimit-remaining"] === "0" || /rate limit|abuse|secondary limit/i.test(message)) {
    return undefined;
  }
  // A missing repo is reported the same way whichever credential was used, so this
  // possibility is named in both branches below.
  const notFound = status === 404;
  if (opts.usingServiceToken) {
    return {
      hint:
        `${status} while filing as the service account: github.issue_token is set, so the failing ` +
        `credential is that PAT — check its scopes and its access to upstream_repo on github.com` +
        (notFound ? `, and check that upstream_repo is spelled correctly (GitHub answers 404 for a repo a token cannot see)` : ``) +
        `. The GitHub App's installation is not involved; it only governs tokens issued to users.`,
    };
  }
  return {
    hint:
      (notFound
        ? // The uninstalled case. GitHub hides the repo rather than refusing, so
          // this reads as "no such repo" until you know to suspect the installation.
          //
          // Two other causes produce an identical 404 and are named rather than
          // assumed away. A misspelled `upstream_repo` is the cheap one. The other is
          // that a user-to-server token is the intersection of the installation's
          // permissions and THIS USER's own access: on a private upstream, a user who
          // cannot see the repo 404s no matter how correctly the app is installed —
          // and that one is per-user, not deployment-wide, so it must not be reported
          // with the "affects every user" framing below.
          `404 on a repo that exists means this user's token cannot see it: the GitHub App is probably not ` +
          `installed on upstream_repo. (A misspelled upstream_repo gives the same 404. So does a PRIVATE ` +
          `upstream_repo that this particular user cannot access — a user's token is limited to their own ` +
          `access as well as the installation's, so a private upstream needs github.issue_token to file for ` +
          `everyone; if filing works for some users and not others, that is this.) `
        : `403 usually means the GitHub App's installation lacks Issues write on this repo. `) +
      `Install the app on upstream_repo — or check that its installation still grants Issues: Read and write — ` +
      `at github.com/settings/installations. A user's authorization carries no repository access on its own; ` +
      `permission comes from the installation, so if the installation is the cause this affects every user ` +
      `until it is fixed.`,
  };
}

async function ensureLabel(
  octokit: Octokit,
  repo: RepoRef,
  name: string = AGENT_LABEL,
  color = "5319e7",
  description = "Agent suggested automatically by Equalify Iris",
): Promise<void> {
  try {
    await octokit.issues.getLabel({ owner: repo.owner, repo: repo.repo, name });
  } catch {
    try {
      await octokit.issues.createLabel({ owner: repo.owner, repo: repo.repo, name, color, description });
    } catch {
      // label may have been created concurrently, or insufficient perms — the
      // issue create below still works if the label already exists.
    }
  }
}

export interface AgentIssue {
  agentName: string;
  agentMarkdown: string;
  reason: string;
  sourcePage: string;
  sessionId: string;
}

// File a labeled issue containing the drafted agent code + context. Returns the
// issue URL, or null if an open issue for this agent already exists (dedupe).
export async function createAgentIssue(
  token: string,
  upstreamUrl: string,
  apiBase: string,
  args: AgentIssue,
): Promise<string | null> {
  const octokit = new Octokit({ auth: token, baseUrl: apiBase });
  const repo = parseRepo(upstreamUrl);
  const title = `New agent suggestion: ${args.agentName}`;

  // Dedupe: skip if an open suggestion issue with this title already exists.
  //
  // The query filters on the LABEL, which is load-bearing and unverified against a
  // typical contributor. GitHub documents that "any user with pull access can create
  // an issue", but that "only users with push access can set labels for new issues —
  // labels are silently dropped otherwise." So a user WITHOUT push access on
  // `upstream_repo` — which is every ordinary contributor, and the case §12 is about —
  // files successfully and gets an UNLABELED issue, at 201, with nothing in the
  // response saying the label was discarded.
  //
  // Two consequences, both silent. Maintainer triage by label misses those issues; and
  // this dedupe never matches them, so every subsequent session refiles the same
  // suggestion under another real person's name. `ensureLabel` below has the same
  // shape: label creation needs push access, and its failure is deliberately swallowed.
  //
  // Not fixed here. It is one call to `GET /repos/:o/:r` to read
  // `permissions.push` and drop the label filter when it is false, but it changes
  // filing behaviour and belongs in its own change with its own e2e case rather than
  // riding along with an auth migration.
  try {
    const found = await octokit.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:issue is:open label:"${AGENT_LABEL}" "${args.agentName}" in:title`,
    });
    if (found.data.items.some((i) => i.title === title)) return null;
  } catch {
    // search unavailable — proceed (a duplicate is acceptable; not worth failing).
  }

  await ensureLabel(octokit, repo);
  const body =
    `**Content type:** \`${args.agentName}\`\n` +
    `**Why a dedicated agent:** ${args.reason}\n` +
    `**First seen on:** ${args.sourcePage} (session ${args.sessionId})\n\n` +
    `_Auto-filed by Equalify Iris when a page contained content a specialist agent would handle better than the general pass._\n\n` +
    `## Proposed agent — \`agents/${args.agentName}.md\`\n\n` +
    "```markdown\n" + args.agentMarkdown + "\n```\n";
  const res = await octokit.issues.create({
    owner: repo.owner,
    repo: repo.repo,
    title,
    body,
    labels: [AGENT_LABEL],
  });
  return res.data.html_url;
}

// Label for feedback-driven improvements to an EXISTING agent (distinct from new
// agent suggestions, so maintainers can triage them separately).
export const AGENT_UPDATE_LABEL = "iris-agent-update";

export interface AgentUpdateIssue {
  agentName: string; // e.g. "page.md"
  agentMarkdown: string; // full proposed updated agent file
  summary: string; // one-line description of the change
  diffPreview: string; // human-readable diff of the proposed change
  sessionId: string;
}

// File a labeled issue proposing an improvement to an existing agent, produced by
// the feedback loop (and already gated by the agent's regression fixtures).
// Returns the issue URL, or null if an open update issue for this agent already
// exists (dedupe by title).
export async function createAgentUpdateIssue(
  token: string,
  upstreamUrl: string,
  apiBase: string,
  args: AgentUpdateIssue,
): Promise<string | null> {
  const octokit = new Octokit({ auth: token, baseUrl: apiBase });
  const repo = parseRepo(upstreamUrl);
  const name = args.agentName.replace(/\.md$/, "");
  const title = `Agent update proposal: ${name}`;

  // Dedupe: skip if an open update issue with this title already exists.
  try {
    const found = await octokit.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:issue is:open label:"${AGENT_UPDATE_LABEL}" "${name}" in:title`,
    });
    if (found.data.items.some((i) => i.title === title)) return null;
  } catch {
    // search unavailable — proceed (a duplicate is acceptable; not worth failing).
  }

  await ensureLabel(
    octokit,
    repo,
    AGENT_UPDATE_LABEL,
    "0e8a16",
    "Agent improvement proposed by Equalify Iris from user feedback",
  );
  const body =
    `**Agent:** \`agents/${name}.md\`\n` +
    `**Proposed change:** ${args.summary}\n` +
    `**Session:** ${args.sessionId}\n\n` +
    `_Auto-filed by Equalify Iris when user feedback produced a generalizable improvement to this agent. ` +
    `Already gated by the agent's regression fixtures._\n\n` +
    `## Diff (preview)\n\n` +
    "```diff\n" + args.diffPreview + "\n```\n\n" +
    `## Proposed full \`agents/${name}.md\`\n\n` +
    "```markdown\n" + args.agentMarkdown + "\n```\n";
  const res = await octokit.issues.create({
    owner: repo.owner,
    repo: repo.repo,
    title,
    body,
    labels: [AGENT_UPDATE_LABEL],
  });
  return res.data.html_url;
}
