// Numbers on a page that the source PDF's own text layer does not contain (#585).
//
// A page is rendered to an image and read by a vision model, so a digit can be misread — "9:45 pm"
// became "4:45 pm" in #585 and both verification passes let it through, since a checker reading the
// same image can misread it the same way. A PDF with a text layer already holds the page's numbers
// as text. So every number in the page's HTML is looked up in that page's text layer, and one that
// is not there goes to the correction as a problem, for the image to settle.
//
// Numbers only — digits, times, dates, money, percents. Words are left to the image: a text layer's
// words carry ligatures, hyphenation and reading-order noise, and its numbers mostly do not.
import { decodeEntities } from "../util/html.ts";

// A run of digits with its thousands separators, decimal points and time colons, and an am/pm
// after it. Commas are only thousands separators when every group after the first is three digits,
// so "1,2,3" is three numbers and "1,200" is one. A dash is never part of a number, so a range reads
// the same with a hyphen, an en dash or an em dash, and a sign is not compared. The am/pm takes a
// closing dot only after an inner one, `p.m.`, so a sentence's full stop after `pm.` is not quoted.
const NUMBER = /(\d{1,3}(?:,\d{3})+(?!\d)|\d+)((?:[.:]\d+)*)(?:\s?([ap])(\.?)\s?m\b\4)?/giu;

// The printer's alignment space inside a thousands group, `4, 271`. The same pattern
// `tightenDigitGroups` (util/html.ts) closes up in a table cell, applied to both sides here: a text
// layer prints the gap, and the HTML has it closed, so without this the repaired figure would read
// as a number the layer lacks.
const DIGIT_GROUP_GAP = /(\d),\s+(?=\d{3}(?!\d))/g;

// A text layer with less than this many letters and digits is a scan (or a page that is all
// picture). Its numbers are not evidence of anything, so the page is not checked.
const MIN_TEXT_LAYER_CHARS = 20;

// More missing numbers than this on a page where most of its numbers are missing means the text
// layer does not describe what the HTML holds (a chart drawn as an image, a scanned insert), not
// that the model misread. That page is skipped. Below it, at most this many are sent.
export const MAX_NUMBER_PROBLEMS = 10;

// One page's text layer, as kept at upload: how much text it has, and its numbers.
export interface TextLayer {
  chars: number;
  numbers: string[];
}

const letterCount = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

// Every number in a text, normalised: no thousands separators, no leading zeros, and am/pm lower
// case and without dots. "09:45 P.M." is "9:45 pm", and "1,200" and "1, 200" are "1200".
export function numberTokens(text: string): string[] {
  return numbersIn(text).map((n) => n.key);
}

// Each number with the spelling the text gave it, so a problem can quote what the HTML says.
function numbersIn(text: string): { key: string; raw: string }[] {
  const out: { key: string; raw: string }[] = [];
  for (const m of text.replace(/\s+/g, " ").replace(DIGIT_GROUP_GAP, "$1,").matchAll(NUMBER)) {
    const whole = m[1].replace(/,/g, "").replace(/^0+(?=\d)/, "");
    const value = whole + m[2];
    out.push({ key: m[3] ? `${value} ${m[3].toLowerCase()}m` : value, raw: m[0].trim() });
  }
  return out;
}

// One page of the PDF's text layer, or null where it is too thin to check against. No numbers is
// a page with text and no numbers, which is not the same as null.
export function textLayer(text: string | undefined): TextLayer | null {
  if (text === undefined) return null;
  const chars = letterCount(text);
  if (chars < MIN_TEXT_LAYER_CHARS) return null;
  return { chars, numbers: [...new Set(numberTokens(text))] };
}

// What a reader is shown, minus the parts whose numbers the text layer cannot hold: comments
// (Iris's own markers), attributes (an alt describes a picture), figures and math (often drawn, not
// typeset), and the page-break marker, whose number is the page label Iris was given.
function checkedText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/<(script|style|figure|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
      .replace(/<(\w+)\b[^>]*\brole\s*=\s*["']?doc-pagebreak\b[^>]*>(?:[^<]*<\/\1\s*>)?/gi, " ")
      .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " "),
  );
}

export interface NumberCheck {
  // Distinct numbers in the HTML.
  checked: number;
  // How many of them the text layer lacks, before the cap.
  missing: number;
  // The ones sent to the correction, as the HTML spells them: the first `MAX_NUMBER_PROBLEMS`, in
  // page order. Empty when skipped.
  numbers: string[];
  // Why nothing was sent although numbers were missing. `thin_layer`: the text layer holds less than
  // half the text the HTML does (a scan with a typed header or stamp). `mostly_absent`: more than
  // `MAX_NUMBER_PROBLEMS`, and most of the page's numbers, are missing.
  skipped?: "thin_layer" | "mostly_absent";
}

// The numbers in a page's HTML that its text layer does not have. `layer` undefined (a scan, an
// image upload) checks nothing and answers null.
//
// A time with am/pm matches the same time with the same am/pm, or the bare time (a timetable
// column headed "PM"). A bare time matches the time with either.
export function numbersMissingFromTextLayer(layer: TextLayer | undefined, html: string): NumberCheck | null {
  if (!layer) return null;
  const text = checkedText(html);
  const have = new Set(layer.numbers);
  const bare = new Set(layer.numbers.map((t) => t.split(" ")[0]));
  // Distinct by normalised value, each quoted as the HTML first spelled it.
  const found = new Map<string, string>();
  for (const n of numbersIn(text)) if (!found.has(n.key)) found.set(n.key, n.raw);
  const missing = [...found]
    .filter(([t]) => (t.includes(" ") ? !have.has(t) && !have.has(t.split(" ")[0]) : !bare.has(t)))
    .map(([, raw]) => raw);
  const result = { checked: found.size, missing: missing.length };
  if (missing.length && layer.chars * 2 < letterCount(text)) return { ...result, numbers: [], skipped: "thin_layer" };
  if (missing.length > MAX_NUMBER_PROBLEMS && missing.length * 2 > found.size) {
    return { ...result, numbers: [], skipped: "mostly_absent" };
  }
  return { ...result, numbers: missing.slice(0, MAX_NUMBER_PROBLEMS) };
}

export function missingNumberProblem(token: string): string {
  return (
    `This page's HTML writes "${token}", and the source PDF's own text for this page has no such ` +
    `number. It may be misread from the image — a 9 read as a 4, a digit dropped. Check it against ` +
    `the source image and write what the page prints. If the image does show "${token}", change ` +
    `nothing for it. Change nothing else about the page.`
  );
}
