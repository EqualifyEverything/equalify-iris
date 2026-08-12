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

// Nothing here labels the issues it files, and the TITLE PREFIX is what identifies
// them instead — `New agent suggestion: <type>` and `Agent update proposal: <agent>`.
//
// There were two labels, `iris-agent-suggestion` and `iris-agent-update`, and they
// could not work for the users this service is built around. GitHub documents that
// "any user with pull access to a repository can create an issue" but that "only users
// with push access can set labels for new issues — labels are silently dropped
// otherwise". Every ordinary contributor is in the second group, so filing returned
// 201 with an unlabeled issue and no indication the label had been discarded. That
// broke the two things the labels existed for, silently and only for the majority of
// users: triage by label missed those issues, and the duplicate search — which
// filtered on the label — could never match one, so every later session refiled the
// same suggestion under another real person's name.
//
// Dropping them removes the failure rather than detecting it. A title prefix is set by
// the same 201 that creates the issue and cannot be stripped by permissions, so it
// behaves identically for a maintainer and a first-time contributor. `is:issue
// is:open "<full title>" in:title` is a slightly wider net than the label filter was
// (GitHub full-text-matches the phrase), which is why the exact-title comparison after
// the search is load-bearing rather than belt-and-braces — see the dedupe sites.
//
// A maintainer who wants labels can add them with a repo-side rule keyed on the title
// prefix, which applies them as the repository rather than as the filer and therefore
// works regardless of who filed.

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

// `ensureLabel` is gone with the labels. It read-or-created the label before filing,
// and both halves needed push access the typical filer does not have — so on the path
// that mattered it was two API calls that could only fail, inside a swallow.

export interface AgentIssue {
  agentName: string;
  agentMarkdown: string;
  reason: string;
  sourcePage: string;
  sessionId: string;
}

// File an issue containing the drafted agent code + context. Returns the issue URL,
// or null if an open issue for this agent already exists (dedupe).
export async function createAgentIssue(
  token: string,
  upstreamUrl: string,
  apiBase: string,
  args: AgentIssue,
): Promise<string | null> {
  const octokit = new Octokit({ auth: token, baseUrl: apiBase });
  const repo = parseRepo(upstreamUrl);
  const title = `New agent suggestion: ${args.agentName}`;

  // Dedupe: skip if an open issue with this exact title already exists.
  //
  // Searched by the full title rather than by a label, because a label is not there to
  // search on — see the note at the top of this file. The whole title is used rather
  // than just the agent name so the phrase match stays tight (`"New agent suggestion:
  // chartData"` does not match a `chartDataAgent` issue), but GitHub's `in:title` is a
  // full-text phrase match and not an equality test, so the exact comparison below is
  // what actually decides. Verified against real GitHub: the label-free query returns
  // the intended issue plus unrelated ones the title comparison then rejects.
  //
  // Known limitation, measured rather than assumed: GitHub's search index is not
  // immediate, so an issue filed seconds ago is not yet findable and a session running
  // in that window files a duplicate. Two calls one second apart both filed; a third,
  // two minutes later, deduped. This is inherent to dedupe-by-search and was equally
  // true of the label-filtered query — the search was always the weak link, not the
  // filter on it. Accepted for the same reason the catch below is empty: a duplicate
  // suggestion is cheap and a failed document is not.
  try {
    const found = await octokit.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:issue is:open "${title}" in:title`,
    });
    if (found.data.items.some((i) => i.title === title)) return null;
  } catch {
    // search unavailable — proceed (a duplicate is acceptable; not worth failing).
  }

  const body =
    `**Content type:** \`${args.agentName}\`\n` +
    `**Why a dedicated agent:** ${args.reason}\n` +
    `**First seen on:** ${args.sourcePage} (session ${args.sessionId})\n\n` +
    `_Auto-filed by Equalify Iris when a page contained content a specialist agent would handle better than the general pass._\n\n` +
    `## Proposed agent — \`agents/${args.agentName}.md\`\n\n` +
    "```markdown\n" + args.agentMarkdown + "\n```\n";
  // No `labels`. GitHub drops them silently for a filer without push access, which is
  // the typical filer here — see the note at the top of this file.
  const res = await octokit.issues.create({
    owner: repo.owner,
    repo: repo.repo,
    title,
    body,
  });
  return res.data.html_url;
}

export interface AgentUpdateIssue {
  agentName: string; // e.g. "page.md"
  agentMarkdown: string; // full proposed updated agent file
  summary: string; // one-line description of the change
  diffPreview: string; // human-readable diff of the proposed change
  sessionId: string;
  // Stable slug of the lesson behind this proposal (pipeline/memory.ts lessonSlug),
  // which discriminates the title. Omitted only when no lesson and no summary could be
  // slugged at all; the title then collapses to the bare form that could not dedupe.
  lessonSlug?: string;
  // The lesson in full, for the body: what was learned, how many sessions have now
  // reported it, and the words the user actually typed. The last of those is the only
  // place a user's feedback reaches GitHub at all.
  lesson?: { instruction: string; feedback: string; count: number };
}

// What filing did. `commented` is not a failure — it is the same-lesson path, where the
// proposal lands on the open issue that already tracks that lesson instead of opening a
// second one. `url` points at whichever of the two the caller should look at.
export interface FiledUpdateIssue {
  url: string;
  action: "created" | "commented";
}

// Cap the user's verbatim feedback in the body. It is untrusted-length free text
// arriving from a form field, and this is a public issue.
const MAX_FEEDBACK = 500;

// File an issue proposing an improvement to an existing agent, produced by the feedback
// loop (and already gated by the agent's regression fixtures).
//
// Its title prefix differs from createAgentIssue's ("Agent update proposal:" vs "New
// agent suggestion:"), which is what keeps the two kinds distinguishable and separately
// dedupable now that the two labels are gone. The prefix alone was not enough to
// dedupe ON, though — see `lessonSlug` for why the title carries the lesson too, and
// why this path (unlike the other) could otherwise only ever skip.
//
// Never returns null, and that is the behaviour change: a matching open issue used to
// mean "return null, file nothing", which on this path meant a lesson vanished with
// only a log line to say so. A match now COMMENTS on that issue, so a repeat report
// adds its session and its corroboration count to the thread a maintainer is already
// looking at. Throws if both the comment and the create fail, for the caller's soft
// failure to log (a contribution must not fail a delivered document).
export async function createAgentUpdateIssue(
  token: string,
  upstreamUrl: string,
  apiBase: string,
  args: AgentUpdateIssue,
): Promise<FiledUpdateIssue> {
  const octokit = new Octokit({ auth: token, baseUrl: apiBase });
  const repo = parseRepo(upstreamUrl);
  const name = args.agentName.replace(/\.md$/, "");
  // An em dash rather than a colon: the prefix's colon is what `New agent suggestion:`
  // and this one are told apart by, and a second colon in the title reads as a second
  // prefix.
  const title = args.lessonSlug ? `Agent update proposal: ${name} — ${args.lessonSlug}` : `Agent update proposal: ${name}`;

  // Dedupe by full title, for the reason createAgentIssue's does — and with the same
  // search-index lag caveat documented there. The exact-title comparison is what
  // decides (`in:title` is a phrase match, not equality), which matters more here now
  // that the title is long: a search for one lesson's title phrase-matches other
  // lessons' issues for the same agent, and those must not be mistaken for this one.
  let open: { number: number; html_url: string } | undefined;
  try {
    const found = await octokit.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:issue is:open "${title}" in:title`,
    });
    open = found.data.items.find((i) => i.title === title);
  } catch {
    // search unavailable — file a fresh issue (a duplicate is acceptable; not worth
    // failing, and not worth losing the lesson over either).
  }

  const lessonLines = args.lesson
    ? `**Lesson:** ${args.lesson.instruction}\n` +
      `**Reported in:** ${args.lesson.count} session${args.lesson.count === 1 ? "" : "s"} so far\n` +
      `**In the user's words:** ${quoteFeedback(args.lesson.feedback)}\n`
    : "";

  if (open) {
    // Same lesson, reported again. The agent markdown goes in a <details> because the
    // point of the comment is the corroboration and the session id, not a second copy
    // of a prompt the issue already shows — but a maintainer merging this wants the
    // LATEST proposed text, so it has to be here rather than only in the first post.
    const comment =
      `Another session produced this same lesson.\n\n` +
      `**Session:** ${args.sessionId}\n` +
      `**Proposed change:** ${args.summary}\n` +
      lessonLines +
      `\n<details>\n<summary>Diff (preview) and full proposed <code>agents/${name}.md</code></summary>\n\n` +
      "```diff\n" + args.diffPreview + "\n```\n\n" +
      "```markdown\n" + args.agentMarkdown + "\n```\n\n</details>\n";
    const res = await octokit.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: open.number,
      body: comment,
    });
    // Prefer the comment's own url (it anchors to the comment), but a response without
    // one must not lose the fact that filing succeeded.
    return { url: res.data.html_url || open.html_url, action: "commented" };
  }

  const body =
    `**Agent:** \`agents/${name}.md\`\n` +
    `**Proposed change:** ${args.summary}\n` +
    `**Session:** ${args.sessionId}\n` +
    lessonLines +
    `\n_Auto-filed by Equalify Iris when user feedback produced a generalizable improvement to this agent. ` +
    `Already gated by the agent's regression fixtures._\n\n` +
    `## Diff (preview)\n\n` +
    "```diff\n" + args.diffPreview + "\n```\n\n" +
    `## Proposed full \`agents/${name}.md\`\n\n` +
    "```markdown\n" + args.agentMarkdown + "\n```\n";
  // No `labels`, same reason as the other path.
  const res = await octokit.issues.create({
    owner: repo.owner,
    repo: repo.repo,
    title,
    body,
  });
  return { url: res.data.html_url, action: "created" };
}

// The user's feedback as a markdown blockquote: collapsed to one line so it cannot
// break out of the quote, and capped.
function quoteFeedback(feedback: string): string {
  const one = feedback.replace(/\s+/g, " ").trim();
  if (!one) return "_(none recorded)_";
  const shown = one.length > MAX_FEEDBACK ? `${one.slice(0, MAX_FEEDBACK)}…` : one;
  return `“${shown}”`;
}
