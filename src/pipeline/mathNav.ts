import { JSDOM } from "jsdom";
import { MATH_NAV_CSS, MATH_NAV_SCRIPT } from "./mathNavAssets.ts";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const SPANISH_MATH_REPLACEMENTS: [RegExp, string][] = [
  [/\bfraction with numerator\b/gi, "fracción con numerador"],
  [/\band denominator\b/gi, "sobre denominador"],
  [/\bover denominator\b/gi, "sobre denominador"],
  [/\bsquare root of\b/gi, "raíz cuadrada de"],
  [/\bsquared\b/gi, "al cuadrado"],
  [/\bcubed\b/gi, "al cubo"],
  [/\bto the power of\b/gi, "a la potencia de"],
  [/\bto the power\b/gi, "a la potencia"],
  [/\bplus or minus\b/gi, "más o menos"],
  [/\bminus\b/gi, "menos"],
  [/\bnegative\b/gi, "menos"],
  [/\bplus\b/gi, "más"],
  [/\bequals\b/gi, "igual a"],
  [/\bequation\b/gi, "ecuación"],
  [/\bEquation\b/g, "Ecuación"],
  [/\bdefinite integral from\b/gi, "integral definida de"],
  [/\bintegral from\b/gi, "integral de"],
  [/\bderivative with respect to\b/gi, "derivada con respecto a"],
  [/\blimit as\b/gi, "límite cuando"],
  [/\bapproaches\b/gi, "tiende a"],
  [/\blog base\b/gi, "logaritmo en base"],
  [/\btimes\b/gi, "por"],
  [/\bprime of\b/gi, "prima de"],
  [/\bprime\b/gi, "prima"],
  [/\bof\b/gi, "de"],
  [/\bopen parenthesis\b/gi, "paréntesis abierto"],
  [/\bclose parenthesis\b/gi, "paréntesis cerrado"],
];

export function translateSpeechToSpanish(speech: string): string {
  let res = speech;
  for (const [pattern, repl] of SPANISH_MATH_REPLACEMENTS) {
    res = res.replace(pattern, repl);
  }
  return res;
}

export function deriveMathSpeech(node: Element, lang: "en" | "es" = "en", fallbackEn?: string): string {
  if (lang === "es" && fallbackEn) {
    return translateSpeechToSpanish(fallbackEn);
  }

  // Token-based fallback speech synthesis from MathML elements
  const tokens: string[] = [];
  function walk(el: Element): void {
    const tag = el.tagName.toLowerCase();
    if (tag === "mfrac") {
      const children = Array.from(el.children);
      tokens.push(lang === "es" ? "fracción con numerador" : "fraction with numerator");
      if (children[0]) walk(children[0]);
      tokens.push(lang === "es" ? "sobre denominador" : "over denominator");
      if (children[1]) walk(children[1]);
      return;
    }
    if (tag === "msqrt") {
      tokens.push(lang === "es" ? "raíz cuadrada de" : "square root of");
      for (const child of Array.from(el.children)) {
        walk(child);
      }
      return;
    }
    if (tag === "msup") {
      const children = Array.from(el.children);
      if (children[0]) walk(children[0]);
      const supText = children[1]?.textContent?.trim();
      if (supText === "2") {
        tokens.push(lang === "es" ? "al cuadrado" : "squared");
      } else if (supText === "3") {
        tokens.push(lang === "es" ? "al cubo" : "cubed");
      } else {
        tokens.push(lang === "es" ? "a la potencia" : "to the power");
        if (children[1]) walk(children[1]);
      }
      return;
    }
    if (tag === "msub") {
      const children = Array.from(el.children);
      if (children[0]) walk(children[0]);
      tokens.push(lang === "es" ? "subíndice" : "sub");
      if (children[1]) walk(children[1]);
      return;
    }
    if (["mi", "mn", "mo", "mtext"].includes(tag)) {
      let t = el.textContent?.trim() ?? "";
      if (t === "=") t = lang === "es" ? "igual a" : "equals";
      else if (t === "+") t = lang === "es" ? "más" : "plus";
      else if (t === "-" || t === "−") t = lang === "es" ? "menos" : "minus";
      else if (t === "±" || t === "&plusmn;") t = lang === "es" ? "más o menos" : "plus or minus";
      else if (t === "·" || t === "×" || t === "*") t = lang === "es" ? "por" : "times";
      if (t) tokens.push(t);
      return;
    }
    for (const child of Array.from(el.children)) {
      walk(child);
    }
  }

  walk(node);
  const result = tokens.join(" ").replace(/\s+/g, " ").trim();
  return result || (lang === "es" ? "fórmula matemática" : "mathematical formula");
}

/**
 * Enriches an HTML document with interactive, accessible MathML navigation drawers,
 * visual highlighting, zoom scaling, TTS audio, and bilingual screen-reader accessibility.
 */
export function enrichMathNavigation(html: string): string {
  if (!html.includes("<math")) {
    return html;
  }

  const dom = new JSDOM(html);
  const document = dom.window.document;
  const mathElements = Array.from(document.querySelectorAll("math"));
  if (mathElements.length === 0) {
    return html;
  }

  let blockCount = 0;
  for (const mathEl of mathElements) {
    const isBlock =
      mathEl.getAttribute("display") === "block" ||
      mathEl.closest("figure") !== null ||
      mathEl.parentElement?.tagName.toLowerCase() === "main" ||
      mathEl.parentElement?.tagName.toLowerCase() === "body";

    if (isBlock) {
      blockCount++;
      const eqId = `eq-${blockCount}`;
      const fig = mathEl.closest("figure");
      const figCaption = fig ? fig.querySelector("figcaption") : null;
      const desc = figCaption?.textContent?.trim() || `Equation ${blockCount}`;

      const rawAria = mathEl.getAttribute("aria-label");
      const speechEn = rawAria ? rawAria.trim() : deriveMathSpeech(mathEl, "en");
      const speechEs = deriveMathSpeech(mathEl, "es", speechEn);

      // Strip attributes from math element to prevent screen-reader double reading
      mathEl.removeAttribute("aria-label");
      mathEl.removeAttribute("alttext");
      if (!mathEl.hasAttribute("xmlns")) {
        mathEl.setAttribute("xmlns", "http://www.w3.org/1998/Math/MathML");
      }
      mathEl.setAttribute("display", "block");

      const wrapper = document.createElement("div");
      wrapper.className = "interactive-equation-wrapper";
      wrapper.id = `wrapper-${eqId}`;
      wrapper.setAttribute("role", "region");
      wrapper.setAttribute("tabindex", "0");
      wrapper.setAttribute("aria-label", desc);
      wrapper.setAttribute("data-description", desc);
      wrapper.setAttribute("data-eq-id", eqId);
      wrapper.setAttribute("data-mathml", mathEl.outerHTML);
      wrapper.setAttribute("data-speech", speechEn);
      wrapper.setAttribute("data-speech-es", speechEs);

      const eqContainer = document.createElement("div");
      eqContainer.className = "equation-container";
      eqContainer.appendChild(mathEl.cloneNode(true));
      wrapper.appendChild(eqContainer);

      const drawer = document.createElement("div");
      drawer.className = "in-place-nav-drawer";
      drawer.setAttribute("role", "application");
      drawer.setAttribute("aria-hidden", "true");
      drawer.setAttribute("aria-label", "Math Sub-expression Navigator");
      drawer.style.display = "none";
      drawer.innerHTML = `
<div class="in-place-nav-header">
<span class="in-place-level-badge">Level 0: Whole Equation</span>
<span class="in-place-speech-text">${escapeHtml(speechEn)}</span>
</div>
<div aria-label="Equation Sub-expressions" class="in-place-term-list" role="group"></div>
<div aria-hidden="true" class="in-place-shortcuts">
<span><kbd>←</kbd> / <kbd>→</kbd> Siblings</span>
<span><kbd>↓</kbd> / <kbd>Enter</kbd> Drill Down</span>
<span><kbd>↑</kbd> / <kbd>Esc</kbd> Go Up</span>
<span><kbd>Backspace</kbd> Exit</span>
</div>`;
      wrapper.appendChild(drawer);

      const actions = document.createElement("div");
      actions.className = "eq-actions-overlay";
      actions.innerHTML = `
<button aria-label="Navigate equation in-place" class="eq-action-btn nav-toggle-btn" type="button"><span aria-hidden="true" class="icon">🎯</span> Navigate In-Place</button>
<button aria-label="Speak equation aloud in English" class="eq-action-btn speak-btn speak-btn-en" data-lang="en" type="button"><span aria-hidden="true" class="icon">🔊</span> Speak (EN)</button>
<button aria-label="Escuchar ecuación en español (Speak in Spanish)" class="eq-action-btn speak-btn speak-btn-es" data-lang="es" type="button"><span aria-hidden="true" class="icon">🌐</span> Español (ES)</button>
<button aria-label="Show equation code and details" class="eq-action-btn focus-btn" type="button"><span aria-hidden="true" class="icon">📋</span> Code &amp; Details</button>`;
      wrapper.appendChild(actions);

      const target = fig || mathEl;
      target.replaceWith(wrapper);
    }
  }

  // Handle inline math
  const remainingMath = Array.from(document.querySelectorAll("math"));
  for (const mathEl of remainingMath) {
    if (mathEl.closest(".interactive-equation-wrapper") || mathEl.closest(".inline-math-wrapper")) {
      continue;
    }
    const rawAria = mathEl.getAttribute("aria-label");
    const speech = rawAria ? rawAria.trim() : deriveMathSpeech(mathEl, "en");

    mathEl.removeAttribute("aria-label");
    mathEl.removeAttribute("alttext");
    if (!mathEl.hasAttribute("xmlns")) {
      mathEl.setAttribute("xmlns", "http://www.w3.org/1998/Math/MathML");
    }
    mathEl.setAttribute("display", "inline");

    const span = document.createElement("span");
    span.className = "inline-math-wrapper";
    span.setAttribute("role", "math");
    span.setAttribute("tabindex", "0");
    span.setAttribute("aria-label", `Math inline: ${speech}`);
    span.setAttribute("data-description", `Math inline: ${speech}`);
    span.setAttribute("data-mathml", mathEl.outerHTML);
    span.setAttribute("data-speech", speech);

    const clone = mathEl.cloneNode(true);
    span.appendChild(clone);
    mathEl.replaceWith(span);
  }

  // Inject Styles into head if not already present
  let head = document.head;
  if (!head) {
    head = document.createElement("head");
    if (document.documentElement.firstChild) {
      document.documentElement.insertBefore(head, document.documentElement.firstChild);
    } else {
      document.documentElement.appendChild(head);
    }
  }
  if (!document.querySelector("style[data-math-nav]")) {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-math-nav", "true");
    styleEl.textContent = `\n${MATH_NAV_CSS}\n`;
    head.appendChild(styleEl);
  }

  // Inject Navigation Script into body if not already present
  let body = document.body;
  if (!body) {
    body = document.createElement("body");
    document.documentElement.appendChild(body);
  }
  if (!document.querySelector("script[data-math-nav]")) {
    const scriptEl = document.createElement("script");
    scriptEl.setAttribute("data-math-nav", "true");
    scriptEl.textContent = `\n${MATH_NAV_SCRIPT}\n`;
    body.appendChild(scriptEl);
  }

  return "<!DOCTYPE html>\n" + document.documentElement.outerHTML + "\n";
}
