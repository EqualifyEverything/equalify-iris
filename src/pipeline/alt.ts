import { decodeEntities } from "../util/html.ts";

// A placeholder where a description belongs: `alt="image"` (#290).
//
// This is the one defect class whose only watcher was the expensive model. Bench measured six
// verifiers on a real alt gutted down to `alt="image"`, two pages, three repeats each, and read
// off whether the reply says in prose that the alt is a placeholder: Sonnet 4.6 (deployed) 6/6,
// Luna 5/6, qwen3-vl-235b 2/6, Haiku 4.5 1/6 with 1 false alarm on clean HTML, nova-2-lite 0/6.
// So the cost saving #246 is built around — dropping the verifier from Sonnet to Luna — is close
// to free on every other class and pays for itself here, and this rule is how it is bought back.
//
// axe cannot report it, and that is not a misconfiguration: `image-alt` asks whether the
// attribute is PRESENT. Confirmed by calling this repo's own `runAxe` on the five cases — a rich
// alt, `alt="image"`, `alt="Photo."`, `alt=""` and no attribute at all — where only the last
// raises anything (`image-alt`), and all five otherwise lint identically. Whether an alt's
// contents mean anything is not machine-checkable in general, which is why the rule below is a
// closed word list rather than a judgement.
//
// NOT a length threshold, and this is the part the data settles. The shortest alts Iris
// legitimately writes are `"M"` (1 character), `"Home"` and `"Meta"` (4) — all of them logos and
// icons, where one word IS the description. Any rule keyed on length flags them. A closed list of
// words that describe the MEDIUM rather than the content does not.
//
// `alt=""` passes, deliberately: an empty alt is a valid statement that an image is decorative,
// and a rule that argued with it would fight the one case the authoring guidance is unambiguous
// about. Whitespace-only is read the same way — it trims to empty, and there is no reading of
// `alt="  "` where the remedy is "describe the image" rather than "write `alt=""`".
//
// False positives, which is the only half of the measurement that carries information (the
// injected defects were chosen to match the list, so they cannot test it): over every `<img>` in
// every bench artifact — 32 run directories, 1,064 non-empty alt occurrences, 406 distinct
// values, source pages and model output together — the filing's list flags 0. The widening below
// flags exactly 1, and that 1 is real.
const GENERIC_ALT_WORDS = [
  // The filing's list, unchanged: words for what the element IS.
  "image",
  "images",
  "photo",
  "photograph",
  "picture",
  "pic",
  "graphic",
  "graphics",
  "figure",
  "fig",
  "img",
  "icon",
  "logo",
  "chart",
  "graph",
  "diagram",
  "screenshot",
  "untitled",
  "placeholder",
  "alt",
  "alt text",
  "description",
  "thumbnail",
  // Added on measurement, not on suspicion. `alt="null"` is in the corpus above — written by
  // nvidia.nemotron-nano-12b-v2 on a bench page, and Iris's own Reader complained about it in
  // the same run ("Image with alt='null' announces as [Image alt] null"). It is not a word for
  // the medium, it is a serialization leak, and it is the same defect for a reader: an
  // announcement with no content in it. The three beside it are that leak's other spellings,
  // added together because a list holding one of them and not the others would be a list that
  // happens to have seen one bug.
  "null",
  "undefined",
  "nan",
  "n/a",
];

// Anchored at both ends, so `"Meta logo"` and `"Bar chart of Q3 revenue"` pass: the finding is an
// alt that is ONLY the word, not one that contains it. 258 of the corpus's alts are `"Meta logo"`
// and a rule that flagged them would be worse than no rule.
//
// The trailing class is the punctuation a model puts after a lone word — `"Image."`, `"photo:"`,
// `"figure -"` — which is the same alt with a keystroke on the end. Punctuation ALONE is not
// matched (the word is required), and that is deliberate rather than an oversight: `alt="..."`
// occurs in the corpus and there is no evidence about whether those images are decorative, so
// flagging it would buy a correction on a judgement this rule does not have.
const GENERIC_ALT = new RegExp(`^(?:${GENERIC_ALT_WORDS.join("|")})[\\s.:;,-]*$`, "i");

// One `<img>` start tag. Quoted regions are matched as units rather than excluded by `[^>]*`,
// because `alt="a > b"` is legal and the naive form cuts the tag in half at the `>` — which
// loses the alt entirely and reads as an image with no attribute, i.e. it under-reports in the
// one case a maintainer would most want to see.
const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

// The attributes on that tag, read one at a time: a name, then optionally a value in one of the
// three spellings source HTML allows. A bare value cannot contain whitespace, so `alt=image` is
// caught and `alt=a b` reads as `a` — which is what a parser does with it too.
//
// Walked as a sequence rather than searched for by name, because `\balt\s*=` finds an `alt` that
// is not an attribute at all: it matches inside `data-alt="image"` (the word boundary is the
// hyphen) and inside another attribute's value (`title="alt=photo"`), and the first match in the
// tag wins — so either one beats the real `alt` written beside it and reports a placeholder for an
// image that is described properly. Both are false positives, which this file's own measurement
// says is the expensive direction: a false positive buys a page call and a binding recheck on a
// page that had already passed. Consuming each value as a unit is what rules them out, and it is
// the same reason `IMG_TAG` matches quoted regions rather than excluding `>`.
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

// The first `alt` on one `<img>` start tag, undecoded, or null where the tag has none. First and
// not last, because a parser handed `<img alt="a" alt="b">` keeps `a` and drops the duplicate.
function altAttr(tag: string): string | null {
  // Past `<img`, so the tag name is not read as the first attribute. `matchAll` works on a copy of
  // the regex, so the shared `lastIndex` is never carried from one tag to the next.
  for (const attr of tag.slice(4).matchAll(ATTR)) {
    if (attr[1].toLowerCase() !== "alt") continue;
    return attr[2] ?? attr[3] ?? attr[4] ?? "";
  }
  return null;
}

// Every non-empty `alt` on an `<img>` in this fragment, decoded and trimmed.
//
// `<img>` only. An `alt` is legal on `<area>` and `<input type="image">` too, and neither is
// something the page agents emit; scanning for the attribute name across the whole document
// instead would read the word `alt=` out of prose and out of a URL, which is the trap
// links.ts's `unresolvedRefs` is built around.
//
// Entities are decoded for the same reason links.ts normalizes an href: the value a reader is
// announced is the decoded one, and `alt="&#105;mage"` is the same placeholder written twice.
export function altTexts(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(IMG_TAG) ?? []) {
    const raw = altAttr(tag);
    if (raw === null) continue;
    const value = decodeEntities(raw).trim();
    if (value) out.push(value);
  }
  return out;
}

// The placeholder alts in this fragment, as written. Duplicates kept: two images described
// `"image"` are two images a reader gets nothing from, and the correction below names each.
export function genericAlts(html: string): string[] {
  return altTexts(html).filter((alt) => GENERIC_ALT.test(alt));
}

// What the correction pass is asked to do about one, in the shape links.ts's
// `missingLinkProblem` uses: a sentence naming the exact defect and the exact repair, appended to
// the Feedback Agent's own problems and sent back with the source image.
//
// The image is why this is a correction rather than an assertion at assembly: the fix is to
// describe the picture, and the page agent is the only component that has the picture. A gate
// that rejected the document could only report the defect it could not repair.
export function genericAltProblem(alt: string): string {
  return (
    `The image described as alt="${alt}" has a placeholder for alt text, not a description. ` +
    `Replace it with what the image shows, in a sentence a reader who cannot see it can use — ` +
    `or, if the image carries no information a reader needs, write alt="" to mark it decorative. ` +
    `Change nothing else about the page.`
  );
}
