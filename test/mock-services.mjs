// Mock GitHub + mock OpenRouter for the end-to-end curl test (test/e2e.sh).
// These stand in for the only two external dependencies so the whole API can be
// exercised offline. Not used in production.
import { createServer } from "node:http";

const GH_PORT = Number(process.env.MOCK_GH_PORT ?? 9301);
const OR_PORT = Number(process.env.MOCK_OR_PORT ?? 9302);

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}
function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ---- Mock GitHub (covers both api.github.com and github.com OAuth paths) ----
const forks = new Set(); // repos that have been forked to the test user
let prNumber = 140;
// Body of the most recent POST /login/device/code, readable via
// GET /__last_device_scope so e2e.sh can assert that the service requested NO scope.
//
// `null` until the route is actually hit, NOT `{}`: with `{}` the reported
// `present:false` would be indistinguishable from "the device flow was never started",
// so the no-scope assertion could pass without the service having sent anything. The
// probe reports `recorded` separately for exactly that reason.
let lastDeviceBody = null;

const gh = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${GH_PORT}`);
  const p = url.pathname;
  const m = req.method;

  // What the last device-flow start asked GitHub for. Recorded rather than
  // asserted here so e2e.sh can check what the SERVICE sends — the request
  // body is otherwise invisible from outside, and a reintroduced scope is a silent
  // problem: the flow succeeds either way.
  //
  // `recorded` is what makes the assertion non-vacuous: "no scope was sent" and "no
  // request was sent" are otherwise the same answer, so a break that stopped the flow
  // reaching here would read as a pass.
  if (m === "GET" && p === "/__last_device_scope")
    return json(res, 200, {
      recorded: lastDeviceBody !== null,
      present: lastDeviceBody !== null && "scope" in lastDeviceBody,
      scope: lastDeviceBody?.scope ?? null,
    });

  // OAuth / device flow
  if (m === "POST" && p === "/login/device/code") {
    try {
      lastDeviceBody = JSON.parse((await readBody(req)) || "{}");
    } catch {
      lastDeviceBody = {};
    }
    return json(res, 200, {
      device_code: "DEVICECODE123",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 1,
    });
  }
  if (m === "POST" && p === "/login/oauth/access_token")
    // No `scope` and no `refresh_token`/`expires_in`: the shape a GitHub App with
    // user-token expiry disabled actually returns.
    return json(res, 200, { access_token: "gho_testtoken", token_type: "bearer" });

  // Authenticated user (api base): identifies the caller AND getAuthenticated()
  if (m === "GET" && p === "/user") return json(res, 200, { id: 4242, login: "iris-tester" });

  // repos.get
  let mm;
  if (m === "GET" && (mm = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
    const [, owner, repo] = mm;
    if (owner === "iris-tester") {
      if (forks.has(repo)) return json(res, 200, { fork: true, default_branch: "main", html_url: `https://github.com/iris-tester/${repo}` });
      return json(res, 404, { message: "Not Found" });
    }
    return json(res, 200, { fork: false, default_branch: "main", html_url: `https://github.com/${owner}/${repo}` });
  }
  // repos.createFork
  if (m === "POST" && (mm = p.match(/^\/repos\/([^/]+)\/([^/]+)\/forks$/))) {
    forks.add(mm[2]);
    return json(res, 202, { fork: true, default_branch: "main", html_url: `https://github.com/iris-tester/${mm[2]}` });
  }
  // git.getRef  GET /repos/:o/:r/git/ref/heads/:branch
  if (m === "GET" && p.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\//))
    return json(res, 200, { ref: "refs/heads/main", object: { sha: "baseSHA0000000000000000000000000000000000" } });
  // git.createRef
  if (m === "POST" && p.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs$/))
    return json(res, 201, { ref: "refs/heads/new", object: { sha: "newSHA00000000000000000000000000000000000" } });
  // repos.getContent -> 404 so createOrUpdate treats it as a new file
  if (m === "GET" && p.match(/^\/repos\/[^/]+\/[^/]+\/contents\//)) return json(res, 404, { message: "Not Found" });
  // repos.createOrUpdateFileContents
  if (m === "PUT" && p.match(/^\/repos\/[^/]+\/[^/]+\/contents\//)) {
    await readBody(req);
    return json(res, 201, { content: { path: p }, commit: { sha: "commitSHA" } });
  }
  // pulls.create
  if (m === "POST" && (mm = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
    await readBody(req);
    prNumber += 1;
    return json(res, 201, { number: prNumber, html_url: `https://github.com/${mm[1]}/${mm[2]}/pull/${prNumber}` });
  }

  json(res, 404, { message: `mock-github: unhandled ${m} ${p}` });
});

// ---- Mock OpenRouter (OpenAI-compatible chat completions) ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The adapter streams, so the mock has to as well. Deliberately not one event
// carrying the whole answer: the content is split across several deltas so the
// adapter's newline framing and accumulation are actually exercised, and the reply
// opens with the keepalive COMMENT that OpenRouter really sends — which the adapter
// must parse without treating it as output.
function sse(res, content, finishReason) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": OPENROUTER PROCESSING\n\n");
  const points = Array.from(content); // split on code points, never mid-character
  const per = Math.max(1, Math.ceil(points.length / 3));
  for (let i = 0; i < points.length; i += per) {
    const piece = points.slice(i, i + per).join("");
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// When set, every completion returns a TRUNCATED response (see below). Toggled at
// runtime via POST /__truncate so one mock process can serve both a normal run and
// a truncation run — the mock boots once for the whole e2e.
let truncateNext = false;

// When set to a page number, ONLY that page's extraction returns a truncated response,
// so a run can end with a document that is missing one page while the others are whole —
// the case per-page containment exists for (issue #135). Set via POST /__fail-page with
// `{"page":2}`, cleared with `{"page":null}`; while it is set a re-extraction of that
// page fails too, and clearing it lets a later feedback round recover the page.
let failPage = null;

// When set, the page agent's response carries a `suggested_agent` with this name,
// so the e2e can drive specialist dispatch. Set to a real library agent to make
// dispatch succeed, or to a name no file matches to make it MISS — the case the
// service used to handle silently. Toggled via POST /__suggest.
let suggestAgent = null;

// When set, page 1's output drops the #240 structural defects below and every page is written
// cleanly. The e2e uses it to prove the run log stays QUIET on a clean document — the
// `delivered_markup` line is gated on having something to say, and with every session's page 1
// dirty there would be nothing behind that gate. Toggled via POST /__clean-markup.
let cleanMarkup = false;

// When set, the Feedback Agent's TASK: classify call fails with a 500 — the first
// model call of the post-delivery training step. Lets the e2e prove that training
// which dies takes nothing with it: the document has already been delivered and the
// session is already `ready_for_review` by the time this runs. Toggled via
// POST /__fail-training.
let failTraining = false;

const or = createServer(async (req, res) => {
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/__truncate") {
    truncateNext = !truncateNext;
    return json(res, 200, { truncate: truncateNext });
  }
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/__fail-page") {
    const raw = await readBody(req);
    const p = JSON.parse(raw || "{}").page;
    failPage = typeof p === "number" ? p : null;
    return json(res, 200, { fail_page: failPage });
  }
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/__suggest") {
    const raw = await readBody(req);
    suggestAgent = JSON.parse(raw || "{}").name ?? null;
    return json(res, 200, { suggest: suggestAgent });
  }
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/__clean-markup") {
    const raw = await readBody(req);
    cleanMarkup = JSON.parse(raw || "{}").clean === true;
    return json(res, 200, { clean_markup: cleanMarkup });
  }
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/__fail-training") {
    const raw = await readBody(req);
    failTraining = JSON.parse(raw || "{}").fail === true;
    return json(res, 200, { fail_training: failTraining });
  }
  const body = await readBody(req);
  let sys = "";
  let user = "";
  let imageParts = 0;
  let wantsStream = false;
  try {
    wantsStream = JSON.parse(body).stream === true;
    const msgs = JSON.parse(body).messages;
    sys = msgs.find((x) => x.role === "system")?.content ?? "";
    const u = msgs.find((x) => x.role === "user")?.content;
    // Vision requests send content as an array of parts: one text part plus one
    // image_url part per attached image.
    user = typeof u === "string" ? u : (u ?? []).map((p) => p.text ?? "").join(" ");
    if (Array.isArray(u)) imageParts = u.filter((p) => p.type === "image_url").length;
  } catch {}
  let content = "{}";
  // Set when THIS call is the armed page's extraction (see failPage), so the truncation
  // below applies to one page of the document rather than to every call in the run.
  let truncateThisPage = false;
  // Feedback Agent, TASK: scope — route feedback to extraction or the review loop.
  // Keyed off the feedback text so the e2e can drive either path: a message naming
  // a page and a misread is source-level, anything else is document-level.
  if (failTraining && user.includes("TASK: classify")) {
    // A provider error on the training step. Not a truncation and not a bad body: a
    // plain 500, the way an overloaded upstream answers.
    return json(res, 500, { error: { message: "e2e: training call refused" } });
  }
  if (user.includes("TASK: scope")) {
    const m = user.match(/misread on page (\d+)/i);
    content = m
      ? JSON.stringify({ target: "extraction", pages: [Number(m[1])], reason: "source misread" })
      : JSON.stringify({ target: "document", pages: [], reason: "document-level wording" });
  } else if (sys.includes("convert an ENTIRE document page")) {
    // Echo the page number back so the assembled document proves page ORDER was
    // preserved. Pages are extracted in parallel, so respond SLOWEST-FIRST:
    // page 1 is delayed the longest, meaning completion order is the reverse of
    // document order. If ordering were driven by completion, the output would
    // come out backwards and the e2e ordering assertion would catch it.
    const m = user.match(/page (\d+) of (\d+)/);
    const page = m ? Number(m[1]) : 1;
    const total = m ? Number(m[2]) : 1;
    await sleep(Math.max(0, (total - page + 1) * 120));
    truncateThisPage = page === failPage;
    // A re-extraction prompt carries the page's previous output. Mark the result
    // so the e2e can prove that ONLY the targeted page was re-extracted.
    const revised = user.includes("## Your previous output for this page");
    content = JSON.stringify({
      html:
        `<h1>Quarterly Report</h1>\n<p>Revenue grew this quarter.</p>\n` +
        `<p>Page marker ${page}.${revised ? " Revised." : ""}</p>\n` +
        // A reference to a section no page transcribes — the #234 defect, on every
        // page, so the delivered document has three references to one dead id. Nothing
        // repairs it: anchors.ts repoints a fragment only when some page claims the id,
        // and there is no axe rule for a same-document link that lands nowhere. It is
        // here to prove the orchestrator MEASURES it, and the repetition is what proves
        // the two units apart — three references, one id.
        `<p><a href="#appendix-a">See Appendix A</a></p>` +
        // The #240 defects, on page 1 only so the counts are exact. Both are invisible to
        // the lint gate by construction, which is the whole point of measuring them on the
        // delivered bytes: the parser closes the `<div>` at end of document before axe sees
        // a tree, and a table with a header block and no rows is perfectly well formed —
        // there is no rule for a table that announces nine columns and holds nothing.
        //
        // The div is unclosed rather than the table: an unclosed `<table>` foster-parents
        // everything after it out of the table, which would reorder the delivered text and
        // break the page-order assertions this same document exists to make.
        (page === 1 && !cleanMarkup
          ? `\n<div>\n<table><caption>Table 1. Revenue by region</caption>\n` +
            `<thead><tr><th scope="col">Region</th><th scope="col">Revenue</th></tr></thead></table>\n`
          : ``),
      log: "",
      // Only when the e2e has armed it, and only on page 1, so the run yields
      // exactly one dispatch attempt to assert on.
      ...(suggestAgent && page === 1
        ? { suggested_agent: { name: suggestAgent, reason: "e2e-driven dispatch" } }
        : {}),
    });
  } else if (user.includes("Extract ONLY the content your contract covers")) {
    // A dispatched library specialist. Returns a marked fragment so the e2e can
    // tell a dispatch that ran from one that was skipped.
    content = JSON.stringify({ no_content: false, html: `<p>Specialist fragment.</p>` });
  } else if (sys.includes("You merge a higher-fidelity HTML fragment")) {
    // The merge step, which folds the specialist fragment back into the page.
    content = JSON.stringify({
      html:
        `<h1>Quarterly Report</h1>\n<p>Revenue grew this quarter.</p>\n` +
        `<p>Page marker 1.</p>\n<p>Specialist fragment.</p>`,
    });
  } else if (sys.includes("Reader Agent")) {
    // Normally clean. When the run carries feedback asking for a copy-edit pass,
    // report ONE issue attributed to page 2 — that drives the editor and lets the
    // e2e prove only page 2's image was attached. Issues are reported on every
    // round (the mock document never changes), so the loop runs to its cap.
    content = user.includes("headings need a copy-edit pass")
      ? JSON.stringify({
          issues: [
            {
              issue: "The revenue table on page 2 has no column headers.",
              pages: [2],
              severity: "high",
              suggested_action: "add <th scope=\"col\"> to the table",
            },
          ],
        })
      : JSON.stringify({ issues: [] });
  } else if (sys.includes("Copy Editor Agent")) {
    // Echo how many page images were attached so the e2e can assert the payload
    // was scoped to the attributed page rather than the whole document.
    const attached = imageParts;
    const rewritten =
      `<h1>Quarterly Report</h1>\n<p>Revenue grew this quarter.</p>\n` +
      `<p>Page marker 1.</p>\n<p>Page marker 2.</p>\n<p>Page marker 3.</p>\n` +
      `<p>Editor saw ${attached} image(s).</p>`;
    // Answered in the shape the request actually asks for (issue #250). An ordinary round shows
    // the body as numbered blocks and wants back only the ones that changed, so the reply is an
    // `edits` array — and this mock is the only place the e2e drives that code at all, which is
    // the point: the guarantees only the e2e checks (axe clean on the served document, no internal
    // comments in the delivered HTML) were being checked against a reply shape the pipeline no
    // longer asks for. A request with no markers in it is the per-section fallback or the table
    // join, and neither has blocks to name, so those still answer with a body.
    const blocks = [...user.matchAll(/<!--\s*@block\s+(\d+)\s*-->/g)].map((m) => Number(m[1]));
    content = blocks.length
      ? JSON.stringify({
          // The whole document rewritten, expressed as a patch: everything into the first block
          // and the rest emptied. That keeps this scenario what it has always been — a round whose
          // correction replaces the body, so an in-fragment marker is gone unless something
          // downstream re-states it — while exercising `applyEditorPatch` on the way.
          edits: blocks.map((n) => ({ block: n, html: n === blocks[0] ? rewritten : "" })),
        })
      : JSON.stringify({ html: rewritten });
  }
  // Truncation: a 200 carrying PARTIAL content plus finish_reason "length" —
  // exactly what a model returns when it stops at the output ceiling. The payload
  // is deliberately plausible-looking JSON cut mid-tag, which is what makes this
  // dangerous: without the provider-level guard it would be assembled into the
  // deliverable as if it were genuine content.
  if (truncateNext || truncateThisPage) {
    const cut = '{"html":"<table><tr><td>cut off mid';
    return wantsStream
      ? sse(res, cut, "length")
      : json(res, 200, { choices: [{ message: { content: cut }, finish_reason: "length" }] });
  }
  if (wantsStream) return sse(res, content, "stop");
  json(res, 200, { choices: [{ message: { content } }] });
});

gh.listen(GH_PORT, () => console.log(`mock-github on ${GH_PORT}`));
or.listen(OR_PORT, () => console.log(`mock-openrouter on ${OR_PORT}`));
