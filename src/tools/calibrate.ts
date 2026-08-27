// Measure whether the fidelity verifier discriminates (issue #180).
//
//   node --use-system-ca --env-file-if-exists=.env src/tools/calibrate.ts --session <id-or-path> [...]
//
// Without `--run` this makes NO model calls: it selects the pages, applies every defect
// it would test, and prints what a live run would cost. That is the whole probe, it is
// free, and it is the default because the live run is the part that spends money — one
// verify call per clean page plus one per damaged copy, at a page image and ~16 KB of
// quoted contract each.
//
// This is a measurement tool, not part of a run. Nothing in `src/pipeline` imports it and
// no endpoint reaches it; it exists so that the number in #180 can be produced again after
// `agents/feedback.md` changes.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, sep } from "node:path";
import { loadConfig } from "../config.ts";
import { Paths } from "../store/paths.ts";
import { RunLog } from "../store/runlog.ts";
import { ProviderRouter } from "../providers/index.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import type { InputImage, PipelineContext } from "../pipeline/context.ts";
import type { Fragment } from "../pipeline/fragment.ts";
import {
  calibrateVerifier,
  formatCalibration,
  DEFECTS,
  DEFECT_IDS,
  type CalibrationPage,
} from "../pipeline/calibration.ts";

function usage(): never {
  process.stdout.write(
    [
      "Usage: calibrate.ts --session <id-or-path> [--session ...] [options]",
      "",
      "  --session <id|path>  A session to draw pages from. Repeatable. An id is resolved",
      "                       under the configured data dir; a path is used as given (which",
      "                       is how a worktree reads the main checkout's sessions).",
      "  --pages <n>          Cap the number of pages used, after selection.",
      "  --defects rotate|all One defect per page (rotate, the default and the 2N run) or",
      "                       every applicable defect per page.",
      "  --only <id,id>       Restrict to these defects. One of:",
      `                       ${DEFECT_IDS.join(", ")}`,
      "  --all-pages          Use every page, not only those the verifier passed. Changes",
      "                       what the clean-copy rate means — see below.",
      "  --concurrency <n>    Verify calls in flight. Defaults to the configured",
      "                       extraction_concurrency.",
      "  --out <path>         Write the report here as well as to stdout.",
      "  --json <path>        Write the full per-call rows as JSON (every verdict, quotable).",
      "  --run                Actually call the model. Without it this is a free dry run.",
      "",
      "Pages are selected from `page_verify_ok` in each session's log: the pages this",
      "verifier already passed, which is what makes a rejection of the clean copy a",
      "false positive rather than a disagreement with a different judge. --all-pages drops",
      "that and measures the verifier against pages it may well have been right to fail.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

interface Args {
  sessions: string[];
  pages?: number;
  defects: "rotate" | "all";
  only: string[];
  allPages: boolean;
  concurrency?: number;
  out?: string;
  json?: string;
  run: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sessions: [], defects: "rotate", only: [], allPages: false, run: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--session":
        args.sessions.push(value());
        break;
      case "--pages": {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 1) fail("--pages needs a positive number");
        args.pages = Math.floor(n);
        break;
      }
      case "--defects": {
        const v = value();
        if (v !== "rotate" && v !== "all") fail('--defects must be "rotate" or "all"');
        args.defects = v;
        break;
      }
      case "--only": {
        const ids = value()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        // Checked here rather than silently narrowing the run: a typo that quietly tests
        // nothing would report a clean-copy rate over zero damaged copies.
        for (const id of ids) if (!DEFECT_IDS.includes(id)) fail(`unknown defect "${id}"`);
        args.only.push(...ids);
        break;
      }
      case "--all-pages":
        args.allPages = true;
        break;
      case "--concurrency": {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 1) fail("--concurrency needs a positive number");
        args.concurrency = Math.floor(n);
        break;
      }
      case "--out":
        args.out = value();
        break;
      case "--json":
        args.json = value();
        break;
      case "--run":
        args.run = true;
        break;
      case "--help":
      case "-h":
        usage();
      default:
        fail(`unknown argument "${flag}"`);
    }
  }
  if (!args.sessions.length) usage();
  return args;
}

function fail(message: string): never {
  process.stderr.write(`calibrate: ${message}\n`);
  process.exit(1);
}

// The images a session's log says the verifier passed. `page_verify_ok` is written once
// per page whose first verify came back with nothing to correct (extraction.ts), so this
// is exactly the population #180 asks for, taken from the record rather than re-derived.
//
// Except for two cases the event does not distinguish by itself.
//
// Verification is non-blocking, so a page nobody could judge — no Feedback Agent, a reply
// that would not parse — also writes `page_verify_ok`. Those pages are not evidence that the
// verifier passed anything, and selecting them would put pages the verifier never had an
// opinion about into a false-positive rate. Runs from this version on mark them
// `unjudged: true` and they are dropped here; older logs cannot say, and their unjudged pages
// come out as unjudged clean copies in the report, excluded from the rates there instead.
//
// And a page can pass while its own verdict describes a defect in it: `ok` is the verdict's
// flags, and a problem named with both flags true ships the page (issue #210). That page is
// not a clean baseline — the verifier has said in prose that it is wrong — so injecting a
// defect on top of it and asking whether the verifier objects measures two things at once,
// and a "false positive" scored on its clean copy is the verifier being right about the
// original. `page_verify_inconsistent` is what makes those findable, and they are dropped for
// the same reason as the unjudged ones: this corpus is the pages the verifier had nothing to
// say about. Only a log from this version on carries the line, so an older log's such pages
// stay in, exactly as they did when the measurement was first published.
function passedImages(logPath: string): Set<string> {
  const passed = new Set<string>();
  const described = new Set<string>();
  if (!existsSync(logPath)) return passed;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.includes("page_verify_ok") && !line.includes("page_verify_inconsistent")) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; image?: string; unjudged?: boolean };
      if (!entry.image) continue;
      if (entry.type === "page_verify_ok" && !entry.unjudged) passed.add(entry.image);
      else if (entry.type === "page_verify_inconsistent") described.add(entry.image);
    } catch {
      // A truncated last line in a log that was being written is not an error here.
    }
  }
  for (const image of described) passed.delete(image);
  return passed;
}

// The agent versions a session actually ran, from its own log. `agent_call` records the
// blob SHA of every library agent it invoked (loader.ts, PRD §7.3 version pinning), which
// is what makes the drift below detectable at all.
function agentShas(logPath: string): Map<string, string> {
  const shas = new Map<string, string>();
  if (!existsSync(logPath)) return shas;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.includes('"agent_call"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; agent?: string; agent_sha?: string | null };
      if (e.type === "agent_call" && e.agent && e.agent_sha) shas.set(e.agent, e.agent_sha);
    } catch {
      // Same as above: a half-written last line is not an error here.
    }
  }
  return shas;
}

// The contract a session's pages were written to, recovered from git by blob SHA.
//
// This is not a nicety. VERIFY is handed the agent's whole contract and judges the output
// against it, so a page extracted months ago and judged against today's `agents/page.md`
// can be rejected for breaking a rule that did not exist when it was written — and that
// rejection would be counted as a false positive by a measurement whose whole subject is
// false positives. The verifier stays current, because today's judge is what is being
// measured; only the quoted contract goes back.
//
// Returns null when the session used the current version, when its log records no page
// call, or when the blob is not in this checkout (a shallow clone, an agents/ directory
// that is its own repo elsewhere). The caller says which.
function historicalPageAgent(session: SessionDir, current: AgentSpec, paths: Paths): AgentSpec | null {
  const sha = agentShas(join(session.dir, "log.jsonl")).get("page.md");
  if (!sha || sha === current.sha) return null;
  let content: string;
  try {
    content = execFileSync("git", ["-C", paths.agentsDir, "cat-file", "blob", sha], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    }).toString();
  } catch {
    process.stderr.write(
      `calibrate: ${session.id} ran page.md ${sha.slice(0, 12)}, which is not in this checkout — ` +
        `its pages will be judged against the current contract, and a clean copy rejected for a ` +
        `rule added since will look like a false positive\n`,
    );
    return null;
  }
  process.stdout.write(
    `${session.id}: pages were written to page.md ${sha.slice(0, 12)} (current is ` +
      `${current.sha?.slice(0, 12) ?? "unpinned"}) — judging them against that contract.\n`,
  );
  return { ...current, content, sha };
}

// A session directory, wherever it came from. Everything below reads files directly
// rather than through `Paths`, because a session named by path may not live under the
// configured data dir at all.
interface SessionDir {
  id: string;
  dir: string;
}

function resolveSession(spec: string, paths: Paths): SessionDir {
  const dir = spec.includes(sep) || existsSync(spec) ? spec : paths.sessionDir(spec);
  if (!existsSync(dir)) fail(`no such session directory: ${dir}`);
  return { id: basename(dir), dir };
}

// Pair each stored fragment with the input image it was extracted from. The pairing is by
// filename, which is what `Fragment.image` holds, and a fragment whose image is gone is
// skipped loudly — a page verified against the wrong image would be a defect in the
// measurement that looked like a defect in the verifier.
function pagesFrom(session: SessionDir, allPages: boolean): CalibrationPage[] {
  const fragmentsPath = join(session.dir, "fragments", "fragments.json");
  if (!existsSync(fragmentsPath)) {
    process.stderr.write(`calibrate: ${session.id} has no fragments/fragments.json — skipped\n`);
    return [];
  }
  let fragments: Fragment[] = [];
  try {
    // A bare array, as `runExtraction` writes it (extraction.ts: `JSON.stringify(fragments)`).
    const parsed: unknown = JSON.parse(readFileSync(fragmentsPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("expected an array of fragments");
    fragments = parsed as Fragment[];
  } catch (e) {
    process.stderr.write(`calibrate: ${session.id} fragments.json unreadable (${String(e)}) — skipped\n`);
    return [];
  }

  const inputDir = join(session.dir, "input");
  const inputs = new Map<string, InputImage>();
  if (existsSync(inputDir)) {
    for (const file of readdirSync(inputDir)) {
      if (!file.includes("__")) continue;
      const [prefix, ...rest] = file.split("__");
      const name = rest.join("__");
      inputs.set(name, { order: parseInt(prefix, 10), name, path: join(inputDir, file) });
    }
  }

  const passed = allPages ? null : passedImages(join(session.dir, "log.jsonl"));
  const pages: CalibrationPage[] = [];
  for (const fragment of fragments) {
    if (!fragment.innerHtml?.trim()) continue;
    if (passed && !passed.has(fragment.image)) continue;
    const image = inputs.get(fragment.image);
    if (!image) {
      process.stderr.write(`calibrate: ${session.id}/${fragment.image} has no input file — skipped\n`);
      continue;
    }
    pages.push({ image, html: fragment.innerHtml });
  }
  return pages;
}

// What a live run would do, priced in calls. Applying the defects is pure and free, so the
// dry run answers the two questions that decide whether the live run is worth paying for:
// how many pages survived selection, and which defects the corpus can actually exercise.
function dryRun(pages: CalibrationPage[], args: Args): void {
  const list = args.only.length ? DEFECTS.filter((d) => args.only.includes(d.id)) : DEFECTS;
  // Two different numbers, reported as two columns because conflating them misreads the
  // corpus. `applicable` is how many pages a defect COULD be injected into — a fact about
  // the documents. `assigned` is how many it would actually be tested on, which in rotate
  // mode is far fewer, because a page stops at the first defect that applies to it. A
  // defect with a healthy `applicable` and a zero `assigned` is not a gap in the corpus; it
  // is a defect this mode will not reach, and `--defects all` or `--only` reaches it.
  const applicable: Record<string, number> = {};
  const assigned: Record<string, number> = {};
  for (const d of list) {
    applicable[d.id] = 0;
    assigned[d.id] = 0;
  }
  let calls = pages.length; // the clean copies
  const noDefect: string[] = [];

  pages.forEach((page, i) => {
    let taken = false;
    for (let k = 0; k < list.length; k++) {
      const defect = list[(i + k) % list.length];
      if (!defect.damage(page.html)) continue;
      applicable[defect.id] += 1;
      if (args.defects === "all" || !taken) {
        assigned[defect.id] += 1;
        calls += 1;
        taken = true;
      }
    }
    if (!taken) noDefect.push(page.image.name);
  });

  const out: string[] = [];
  out.push(`Dry run — no model calls made.`);
  out.push(`Pages selected: ${pages.length}`);
  out.push("");
  out.push(`Defect                 applicable  tested (--defects ${args.defects})`);
  for (const d of list) {
    out.push(`${d.id.padEnd(22)} ${String(applicable[d.id]).padStart(10)}  ${String(assigned[d.id]).padStart(6)}`);
  }
  const never = list.filter((d) => applicable[d.id] === 0).map((d) => d.id);
  if (never.length) out.push(`\nNo page in this corpus has the structure for: ${never.join(", ")}`);
  const unreached = list.filter((d) => applicable[d.id] > 0 && assigned[d.id] === 0).map((d) => d.id);
  if (unreached.length) {
    out.push(`Applicable but not tested in this mode: ${unreached.join(", ")} — use --defects all or --only.`);
  }
  if (noDefect.length) out.push(`Pages no defect applies to: ${noDefect.length} (${noDefect.join(", ")})`);
  out.push("");
  out.push(`A live run (--run) would make ${calls} verify calls: ${pages.length} clean + ${calls - pages.length} damaged.`);
  out.push(`Each call sends one page image and the page agent's whole contract.`);
  process.stdout.write(out.join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const paths = new Paths(cfg);

  // Per session, because the contract attached below is per session.
  const drawn = args.sessions.map((spec) => {
    const session = resolveSession(spec, paths);
    return { session, pages: pagesFrom(session, args.allPages) };
  });
  const pages: CalibrationPage[] = drawn.flatMap((d) => d.pages);
  if (!pages.length) {
    fail(
      args.allPages
        ? "no pages found in the named sessions"
        : "no pages the verifier passed in the named sessions (try --all-pages, and read what that changes in --help)",
    );
  }
  // The cap is applied after selection and reported, so a run over 40 available pages
  // capped at 10 never reads as a corpus of 10.
  const used = args.pages ? pages.slice(0, args.pages) : pages;
  if (used.length < pages.length) {
    process.stdout.write(`Using ${used.length} of ${pages.length} selected pages (--pages ${args.pages}).\n`);
  }

  if (!args.run) {
    dryRun(used, args);
    return;
  }

  // A session id of its own, so the calls this tool makes are in their own log rather than
  // appended to the log of the run whose pages it borrowed.
  const sessionId = `calibrate-${basename(args.sessions[0])}`;

  // `tmpAgentsDir` is where a run keeps agents it built for itself, and `loadAgent` prefers
  // it over the library. This tool has none, and pointing it at `agentsDir` would make every
  // library agent load as session-built with a null SHA — which silently disables the drift
  // check below, since a null SHA differs from every recorded one. So: a directory the
  // calibration session does not have.
  const library = { agentsDir: paths.agentsDir, tmpAgentsDir: paths.tmpAgentsDir(sessionId) };
  const agent = loadAgent("page", library);
  if (!agent) fail(`no page agent in ${paths.agentsDir}`);
  // The Feedback Agent has to be there too, and its absence is the failure this tool must
  // not report as a result: `verifyAgentOutput` answers ok=true when it cannot load one,
  // which would come out as a verifier that passes everything.
  const feedback = loadAgent("feedback", library);
  if (!feedback) fail(`no feedback agent in ${paths.agentsDir} — every call would be unjudged`);

  // Each session's pages are judged against the contract they were written to, where this
  // checkout still has it. The verifier is deliberately NOT rolled back — today's judge is
  // the subject of the measurement — and a session that ran an older `feedback.md` is
  // therefore expected, not corrected for.
  for (const { session, pages: sessionPages } of drawn) {
    const historical = historicalPageAgent(session, agent, paths);
    if (historical) for (const page of sessionPages) page.agent = historical;
    const ran = agentShas(join(session.dir, "log.jsonl")).get("feedback.md");
    if (ran && ran !== feedback.sha) {
      process.stdout.write(
        `${session.id}: verified at the time by feedback.md ${ran.slice(0, 12)}; judging with the ` +
          `current ${feedback.sha?.slice(0, 12) ?? "unpinned"}, which is the point of the measurement.\n`,
      );
    }
  }

  const sessionDir = join(cfg.storage.data_dir, "sessions", sessionId);
  // `RunLog` appends and does not create its directory — a real run's directory is made by
  // the upload. Nothing else here writes into the session, so this is the only mkdir.
  mkdirSync(sessionDir, { recursive: true });
  const logPath = join(sessionDir, "log.jsonl");
  const log = new RunLog(logPath);
  const ctx: PipelineContext = {
    sessionId,
    cfg,
    paths,
    router: new ProviderRouter(cfg, (type, data) => log.event(type, data)),
    log,
    images: used.map((p) => p.image),
    maxReviewIterations: cfg.defaults.max_review_iterations,
    extractionConcurrency: cfg.defaults.extraction_concurrency,
  };

  process.stdout.write(
    `Verifying ${used.length} page${used.length === 1 ? "" : "s"} (clean + damaged). Log: ${logPath}\n`,
  );
  const report = await calibrateVerifier(ctx, agent, used, {
    defects: args.defects,
    only: args.only,
    concurrency: args.concurrency,
  });
  const text = formatCalibration(report);
  process.stdout.write(`\n${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
}

await main();
