// A small JSON Schema check for the parts docs/openapi.yaml uses: $ref, type (with "null" and
// "integer"), required, properties, additionalProperties, items, enum. Returns the problems found,
// each with the path where it is. Used by test/openapi.test.ts and test/openapi-check.mjs (e2e).
type Schema = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export function validate(schema: Schema | undefined, value: unknown, root: Schema, at = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (schema.$ref) {
    const target = (schema.$ref as string).replace(/^#\//, "").split("/").reduce((o: Schema | undefined, k) => o && o[k], root);
    return validate(target, value, root, at);
  }
  const out: string[] = [];
  const types: string[] | null = schema.type === undefined ? null : [].concat(schema.type);
  if (types) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const ok = types.some((t) => t === actual || (t === "integer" && Number.isInteger(value)) || (t === "number" && actual === "number"));
    if (!ok) return [`${at}: expected ${types.join(" or ")}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of (schema.required ?? []) as string[]) if (!(k in value)) out.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
      if (sub) out.push(...validate(sub, v, root, `${at}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => out.push(...validate(schema.items, v, root, `${at}[${i}]`)));
  return out;
}
