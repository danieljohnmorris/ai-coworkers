// AIC-43 — validate tool input against its declared JSON schema before the
// handler runs. Prevents the model from crashing tools by passing garbage.
// Returns { ok: true } or { ok: false, errors: string[] } — never throws.

import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });

const compiled = new WeakMap<object, (data: unknown) => boolean>();

export function validateInput(schema: object, input: unknown): { ok: true } | { ok: false; errors: string[] } {
  let validator = compiled.get(schema);
  if (!validator) {
    try { validator = ajv.compile(schema); compiled.set(schema, validator); }
    catch (err) { return { ok: false, errors: [`bad schema: ${err}`] }; }
  }
  const valid = validator(input);
  if (valid) return { ok: true };
  const errors = ((validator as any).errors as ErrorObject[] | null | undefined)?.map(
    (e) => `${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`
  ) ?? [];
  return { ok: false, errors };
}
