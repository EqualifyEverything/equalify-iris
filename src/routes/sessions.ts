import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { Octokit } from '@octokit/rest';
import type { IrisConfig } from '../config.ts';
import type { Store, SessionRecord } from '../store/db.ts';
import { Paths } from '../store/paths.ts';
import { runPipeline } from '../pipeline/orchestrator.ts';
import type { AuthedRequest } from '../auth/middleware.ts';
import { sendError } from './errors.ts';
import { gatherNewAgents, gatherAgentUpdates } from '../github/contributions.ts';
import { createIssue } from '../github/issue.ts';
import { parseRepo } from '../github/pr.ts';
import { summarizeRun } from '../diagnostics.ts';

const upload = multer({ storage: multer.memoryStorage() });

const ALLOWED_EXT = /\.(png|jpe?g|tiff?|webp)$/i;
const ISSUE_BODY_OUTPUT_CAP = 10000; // Issue bodies cap at ~65k chars, but keep samples reasonable

// One-line axe-core summary for the issue description (from sessions/<id>/lint.json).
function summarizeLint(lintPath: string): string {
  if (!existsSync(lintPath)) return '(no report)';
  try {
    const lint = JSON.parse(readFileSync(lintPath, 'utf8')) as {
      ok?: boolean;
      violations?: unknown[];
      error?: string;
    };
    const n = lint.violations?.length ?? 0;
    if (lint.error) return `could not run (${lint.error})`;
    return lint.ok ? `passed — 0 violations` : `${n} violation${n === 1 ? '' : 's'}`;
  } catch {
    return '(unreadable report)';
  }
}

function sessionSummary(s: SessionRecord) {
  return {
    session_id: s.session_id,
    status: s.status,
    image_count: s.image_count,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// Owned-by-caller lookup. Returns undefined (caller sends 404) when missing or
// owned by another user, so a token cannot probe others' sessions (§9.1).
function ownedSession(store: Store, id: string, userId: number): SessionRecord | undefined {
  const s = store.getSession(id);
  if (!s || s.github_user_id !== userId) return undefined;
  return s;
}

export function sessionsRouter(cfg: IrisConfig, store: Store): Router {
  const r = Router();
  const paths = new Paths(cfg);

  // GET /v1/sessions — list this user's sessions, newest first.
  r.get('/', (req: AuthedRequest, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const status = req.query.status ? String(req.query.status) : undefined;
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const rows = store.listSessions(req.user!.github_user_id, { limit: limit + 1, status, cursor });
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page[page.length - 1].created_at : null;
    res.json({ sessions: page.map(sessionSummary), next_cursor: next });
  });

  // POST /v1/sessions — create a session, store images in submitted order.
  r.post('/', upload.array('images'), (req: AuthedRequest, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      sendError(res, 400, 'invalid_request', "At least one image part named 'images' is required");
      return;
    }
    for (const f of files) {
      if (!ALLOWED_EXT.test(f.originalname)) {
        sendError(res, 400, 'invalid_request', `Unsupported image type: ${f.originalname}`);
        return;
      }
    }

    let maxIter = req.user!.max_review_iterations;
    const configPart = (req.body as { config?: string } | undefined)?.config;
    if (configPart) {
      try {
        const parsed = JSON.parse(configPart) as { max_review_iterations?: number };
        if (typeof parsed.max_review_iterations === 'number')
          maxIter = parsed.max_review_iterations;
      } catch {
        sendError(res, 400, 'invalid_request', 'config part is not valid JSON');
        return;
      }
    }

    const sessionId = `ses_${ulid()}`;
    paths.initSession(sessionId);
    // Persist images with an order prefix so submitted order survives (§9.2).
    files.forEach((f, i) => {
      const order = String(i + 1).padStart(4, '0');
      writeFileSync(join(paths.sessionInput(sessionId), `${order}__${f.originalname}`), f.buffer);
    });

    const record = store.createSession({
      session_id: sessionId,
      github_user_id: req.user!.github_user_id,
      image_count: files.length,
      iterations_max: maxIter,
    });

    // Kick off the pipeline asynchronously; clients poll GET /v1/sessions/{id}.
    void runPipeline({ cfg, store, sessionId, maxReviewIterations: maxIter });

    res.status(201).json({
      session_id: record.session_id,
      status: record.status,
      image_count: record.image_count,
      created_at: record.created_at,
    });
  });

  // GET /v1/sessions/{id} — status, plus pending_prs preview when ready.
  r.get('/:id', (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, 'session_not_found', 'No such session');
      return;
    }
    const body: Record<string, unknown> = {
      session_id: s.session_id,
      status: s.status,
      phase: s.phase,
      iterations_completed: s.iterations_completed,
      iterations_max: s.iterations_max,
      image_count: s.image_count,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
    if (s.status === 'failed' && s.error) body.error = s.error;
    if (s.status === 'ready_for_review') {
      const newAgents = gatherNewAgents(paths, s.session_id);
      const updates = gatherAgentUpdates(paths, s.session_id);
      body.pending_prs = {
        new_agents: newAgents.map((a) => ({
          agent_name: a.agent_name,
          summary: a.summary,
          triggered_by: a.triggered_by,
        })),
        agent_updates: updates.map((u) => ({
          agent_name: u.agent_name,
          summary: u.summary,
          diff_preview: u.diff_preview,
        })),
      };
    }
    res.json(body);
  });

  // GET /v1/sessions/{id}/output — the HTML document.
  r.get('/:id/output', (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, 'session_not_found', 'No such session');
      return;
    }
    if (s.status !== 'ready_for_review' && s.status !== 'closed') {
      sendError(
        res,
        409,
        'invalid_state',
        'Output not available until session is ready_for_review',
      );
      return;
    }
    const outPath = paths.sessionOutput(s.session_id);
    if (!existsSync(outPath)) {
      sendError(res, 409, 'invalid_state', 'Output not available');
      return;
    }
    res.type('text/html').send(readFileSync(outPath, 'utf8'));
  });

  // GET /v1/sessions/{id}/logs — the run log as ndjson.
  r.get('/:id/logs', (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, 'session_not_found', 'No such session');
      return;
    }
    const logPath = paths.sessionLog(s.session_id);
    res.type('application/x-ndjson').send(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
  });

  // GET /v1/sessions/{id}/diagnostics — machine-readable timing/health summary
  // for maintainers (human or AI): phase + per-call durations, the slowest
  // calls, and any in-flight call (the likely culprit when a run seems hung).
  r.get('/:id/diagnostics', (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, 'session_not_found', 'No such session');
      return;
    }
    const logPath = paths.sessionLog(s.session_id);
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    res.json(
      summarizeRun(text, {
        sessionId: s.session_id,
        status: s.status,
        phase: s.phase,
        now: Date.now(),
      }),
    );
  });

  // POST /v1/sessions/{id}/feedback — re-run within the same session (§7.12).
  r.post('/:id/feedback', (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, 'session_not_found', 'No such session');
      return;
    }
    if (s.status !== 'ready_for_review') {
      sendError(res, 409, 'invalid_state', 'Feedback can only be submitted when ready_for_review');
      return;
    }
    const feedback = (req.body as { feedback?: string } | undefined)?.feedback;
    if (!feedback || typeof feedback !== 'string') {
      sendError(res, 400, 'invalid_request', 'feedback (string) is required');
      return;
    }
    store.updateSession(s.session_id, { status: 'running', phase: 'triage' });
    void runPipeline({
      cfg,
      store,
      sessionId: s.session_id,
      maxReviewIterations: s.iterations_max,
      feedback,
    });
    res.status(202).json({ session_id: s.session_id, status: 'running', phase: 'triage' });
  });

  // POST /v1/sessions/{id}/close — finalize, open PRs, clean tmp (§7.13, §9.2).
  r.post('/:id/close', async (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, 'session_not_found', 'No such session');
      return;
    }
    if (s.status !== 'ready_for_review') {
      sendError(res, 409, 'invalid_state', 'Session is not ready_for_review');
      return;
    }

    const skipIssues = String(req.query.skip_issues ?? '') === 'true';
    const issuesOpened: {
      kind: string;
      agent_name: string;
      issue_url: string;
      issue_number: number;
    }[] = [];

    if (!skipIssues) {
      const newAgents = gatherNewAgents(paths, s.session_id);
      const updates = gatherAgentUpdates(paths, s.session_id);
      if (newAgents.length || updates.length) {
        try {
          const octokit = new Octokit({ auth: req.token, baseUrl: cfg.github.api_base_url });
          const upstream = parseRepo(cfg.github.upstream_repo);

          // Output and lint summary to include in issue descriptions.
          const outputHtml = existsSync(paths.sessionOutput(s.session_id))
            ? readFileSync(paths.sessionOutput(s.session_id), 'utf8')
            : '';
          const lintLine = summarizeLint(paths.sessionLint(s.session_id));

          for (const a of newAgents) {
            try {
              const opened = await createIssue(octokit, upstream, {
                type: 'new_agent',
                agentName: a.agent_name,
                summary: a.summary,
                outputHtml,
                triggeredBy: a.triggered_by || undefined,
                lintResult: lintLine,
              });
              issuesOpened.push({ kind: 'new_agent', agent_name: a.agent_name, ...opened });
            } catch (e) {
              appendFileSync(
                paths.sessionPrs(s.session_id),
                `- FAILED new_agent ${a.agent_name}: ${(e as Error).message}\n`,
              );
            }
          }

          for (const u of updates) {
            try {
              const opened = await createIssue(octokit, upstream, {
                type: 'agent_update',
                agentName: u.agent_name,
                summary: u.summary,
                diffPreview: u.diff_preview,
                outputHtml: undefined,
              });
              issuesOpened.push({ kind: 'agent_update', agent_name: u.agent_name, ...opened });
            } catch (e) {
              appendFileSync(
                paths.sessionPrs(s.session_id),
                `- FAILED agent_update ${u.agent_name}: ${(e as Error).message}\n`,
              );
            }
          }
        } catch (e) {
          sendError(res, 502, 'issue_failed', `Failed to open issues: ${(e as Error).message}`);
          return;
        }
      }
    }

    // Record opened issues, then delete tmp/<session-id> entirely (§8.2).
    if (issuesOpened.length) {
      appendFileSync(
        paths.sessionPrs(s.session_id),
        issuesOpened
          .map((i) => `- [${i.kind}] ${i.agent_name}: ${i.issue_url} (#${i.issue_number})`)
          .join('\n') + '\n',
      );
    }
    const tmp = paths.tmpDir(s.session_id);
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });

    store.updateSession(s.session_id, { status: 'closed' });
    res.json({ session_id: s.session_id, status: 'closed', issues_opened: issuesOpened });
  });

  return r;
}
