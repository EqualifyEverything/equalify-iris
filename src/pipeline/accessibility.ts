// The accessibility requirements every content agent must satisfy.
// Appended to each content-agent system prompt so the contract is enforced
// regardless of how terse an individual agent file is.
export const ACCESSIBILITY_REQUIREMENTS = `
## Accessibility requirements (WCAG 2.2 AA — non-negotiable)
- Use semantic HTML elements only; no <div> where <section>, <nav>, <article>,
  <aside>, <header>, or <footer> apply.
- Use headings in correct nesting order: never skip a level on the way down (an
  <h2> is never followed by an <h4>), and give a heading the level its content's
  place in the hierarchy calls for, not the level its type size suggests.
- Tables must have <caption>, <thead>, <th scope>, and association attributes where required.
- Form fields must have programmatically associated labels; mark required fields
  accessibly; include error-messaging hooks.
- Images must have meaningful alt text, or alt="" if decorative (justify in the fragment log).
- Use <ul>/<ol>/<dl> for lists, never visual list-likes.
- Set language attributes when a language change is detected.
- Do not rely on color alone; no inline event handlers; no styling.
`.trim();
