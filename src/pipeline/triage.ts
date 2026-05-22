import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { feedbackPreamble, loadImage, type PipelineContext } from "./context.ts";

const TRIAGE_AGENT = "image_analysis";

const SYSTEM_PROMPT = `You are the Image Analysis Agent for an image-to-accessible-HTML pipeline (PRD §7.2).
For ONE source image you produce triage notes describing (a) the content types present and
(b) which edges may contain fragments continuing onto adjacent images.

Known content types map to these agent files when present:
paragraph.md, heading.md, list.md, table.md, formField.md, image.md, quote.md, caption.md, footnote.md.
If the image contains a content type that none of these cover, name a new lowerCamelCase
type (e.g. "scientificNotation") and reference "<type>.md"; a Builder Agent will create it.

Respond with ONLY a JSON object in this shape:
{
  "content_types": ["table", "paragraph", ...],
  "fragment_indicators": {
    "top": "paragraph appears to continue from previous image" | "none",
    "bottom": "...",
    "left": "...",
    "right": "..."
  },
  "agent_calls": ["table.md", "paragraph.md", ...],
  "notes": ["short note for downstream agents", ...]
}`;

export interface TriageNotes {
  image: string;
  order: number;
  contentTypes: string[];
  agentCalls: string[];
  fragmentIndicators: Record<string, string>;
  notes: string[];
  notesPath: string;
}

interface TriageJson {
  content_types?: string[];
  fragment_indicators?: Record<string, string>;
  agent_calls?: string[];
  notes?: string[];
}

function renderNotesMarkdown(n: TriageNotes): string {
  const fi = n.fragmentIndicators;
  return `---
image: ${n.image}
order: ${n.order}
---

# Content Types
${n.contentTypes.map((t) => `- ${t}`).join("\n") || "- (none detected)"}

# Fragment Indicators
- top-edge: ${fi.top ?? "none"}
- bottom-edge: ${fi.bottom ?? "none"}
- left-edge: ${fi.left ?? "none"}
- right-edge: ${fi.right ?? "none"}

# Agent Calls
${n.agentCalls.map((a) => `- ${a}`).join("\n") || "- (none)"}

# Notes for downstream agents
${n.notes.map((x) => `- ${x}`).join("\n") || "- (none)"}
`;
}

export async function runTriage(ctx: PipelineContext): Promise<TriageNotes[]> {
  const results: TriageNotes[] = [];
  for (const img of ctx.images) {
    const userMsg =
      `Analyze this single source image (filename: ${img.name}, order ${img.order} of ${ctx.images.length}).` +
      feedbackPreamble(ctx);
    const res = await ctx.router.complete(
      TRIAGE_AGENT,
      "vision",
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      { images: [loadImage(img)] },
    );

    const parsed = extractJson<TriageJson>(res.text) ?? {};
    const notes: TriageNotes = {
      image: img.name,
      order: img.order,
      contentTypes: parsed.content_types ?? [],
      agentCalls: (parsed.agent_calls ?? []).map((a) => (a.endsWith(".md") ? a : `${a}.md`)),
      fragmentIndicators: parsed.fragment_indicators ?? {},
      notes: parsed.notes ?? [],
      notesPath: join(ctx.paths.sessionNotes(ctx.sessionId), `${img.name}.md`),
    };
    writeFileSync(notes.notesPath, renderNotesMarkdown(notes));
    ctx.log.agentCall({
      agent: { name: TRIAGE_AGENT, file: `${TRIAGE_AGENT}.md`, content: SYSTEM_PROMPT, capabilities: ["vision"], sha: null, sessionBuilt: false },
      phase: "triage",
      image: img.name,
      output: res.text,
    });
    results.push(notes);
  }
  return results;
}
