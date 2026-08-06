// AIC-43 — validate tool input against its declared JSON schema before the
// handler runs. Prevents the model from crashing tools by passing garbage.
// Returns { ok: true } or { ok: false, errors: string[] } — never throws.

import Ajv, { type ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

// Two validators: the default draft-07 Ajv for our own tool schemas, and
// a draft-2020-12 Ajv for MCP tool schemas (Linear's remote MCP ships
// schemas that reference the 2020-12 meta-schema — draft-07 Ajv rejects
// them with "no schema with key or ref https://json-schema.org/draft/2020-12/schema").
// We route by the schema's own `$schema` field, falling back to draft-07.
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
const ajv2020 = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true });

function pickAjv(schema: object): Ajv | Ajv2020 {
  const s = (schema as { $schema?: string }).$schema;
  if (typeof s === "string" && s.includes("2020-12")) return ajv2020;
  if (typeof s === "string" && s.includes("2019-09")) return ajv2020; // 2020 is a superset
  return ajv;
}

const compiled = new WeakMap<object, (data: unknown) => boolean>();

export function validateInput(schema: object, input: unknown): { ok: true } | { ok: false; errors: string[] } {
  let validator = compiled.get(schema);
  if (!validator) {
    try { validator = pickAjv(schema).compile(schema); compiled.set(schema, validator); }
    catch (err) { return { ok: false, errors: [`bad schema: ${err}`] }; }
  }
  const valid = validator(input);
  if (valid) return { ok: true };
  const errors = ((validator as any).errors as ErrorObject[] | null | undefined)?.map(
    (e) => `${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`
  ) ?? [];
  return { ok: false, errors };
}
