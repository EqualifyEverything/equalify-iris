import { extractJson } from "../util/json.ts";
import { feedbackPreamble, loadImage, type PipelineContext } from "./context.ts";
import type { Fragment } from "./fragment.ts";

const RECON_AGENT = "reconciliation";

const SYSTEM_PROMPT = `You are the Reconciliation Agent (PRD §7.6). You decide whether a content block cut off at
the BOTTOM edge of one image continues at the TOP edge of the next image, and if so produce a
single joined HTML fragment.

Be conservative. Only "join" when the content type matches AND the textual/structural
similarity at the edges is high. A false join is silently wrong; a missed join is visibly two
blocks the Reader can flag. When in doubt, prefer "suspected" or "separate".

Respond with ONLY this JSON:
{ "decision": "join" | "suspected" | "separate",
  "joined_html": "<merged accessible HTML, present only when decision is join>" }`;

// PRD §7.6: for each adjacent image pair, attempt to stitch bottom-edge
// fragments of image N onto top-edge fragments of image N+1.
export async function runReconciliation(
  ctx: PipelineContext,
  fragments: Fragment[],
): Promise<Fragment[]> {
  const consumed = new Set<Fragment>();
  const added: Fragment[] = [];

  const orders = [...new Set(fragments.map((f) => f.order))].sort((a, b) => a - b);
  for (let i = 0; i < orders.length - 1; i++) {
    const top = orders[i];
    const bottom = orders[i + 1];
    const aCandidates = fragments.filter(
      (f) => f.order === top && !consumed.has(f) && f.edges.some((e) => e.includes("bottom")),
    );
    const bCandidates = fragments.filter(
      (f) => f.order === bottom && !consumed.has(f) && f.edges.some((e) => e.includes("top")),
    );

    for (const a of aCandidates) {
      const b = bCandidates.find((x) => x.agent === a.agent && !consumed.has(x));
      if (!b) continue;

      const imgA = ctx.images.find((im) => im.name === a.image);
      const imgB = ctx.images.find((im) => im.name === b.image);
      const images = [imgA, imgB].filter((x) => x != null).map((x) => loadImage(x!));

      const user =
        `Agent type: ${a.agent}\n\n` +
        `BOTTOM-edge fragment of ${a.image}:\n${a.innerHtml}\n(log: ${a.log})\n\n` +
        `TOP-edge fragment of ${b.image}:\n${b.innerHtml}\n(log: ${b.log})\n\n` +
        `The two source images are attached in order.` +
        feedbackPreamble(ctx);

      const res = await ctx.router.complete(
        RECON_AGENT,
        "vision",
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        { images },
      );
      ctx.log.agentCall({
        agent: { name: RECON_AGENT, file: `${RECON_AGENT}.md`, content: SYSTEM_PROMPT, capabilities: ["vision"], sha: null, sessionBuilt: false },
        phase: "reconciliation",
        output: res.text,
      });

      const parsed = extractJson<{ decision?: string; joined_html?: string }>(res.text);
      const decision = parsed?.decision ?? "separate";
      if (decision === "join" && parsed?.joined_html) {
        consumed.add(a);
        consumed.add(b);
        added.push({
          image: `${a.image}+${b.image}`,
          order: a.order,
          agent: a.agent,
          region: `${a.region}+${b.region}`,
          innerHtml: parsed.joined_html,
          edges: [],
          log: `reconciled across ${a.image} and ${b.image}`,
          reconciled: true,
        });
      } else if (decision === "suspected") {
        b.suspectedContinuation = true;
      }
    }
  }

  const kept = fragments.filter((f) => !consumed.has(f));
  return [...kept, ...added].sort((x, y) => x.order - y.order);
}
