// A small JSON Schema validator — the subset an agent-authored component
// declaration realistically needs, with zero dependencies (stdlib has none).
//
// Exists for the declarative layer (`declarative.ts`): a prompt system's
// proposed writes are checked against each component's declared schema BEFORE
// they reach the barrier, so a malformed value becomes a rejected proposal
// (queryable state) rather than a reducer throw that rejects the whole run
// (R25 staging). `schemaValidator(schema)` also plugs straight into
// `extractJson`'s `validate` hook, which until now embedded the schema as text
// only and never enforced it.
//
// Supported keywords: type (incl. arrays of types), enum, const, properties,
// required, additionalProperties (boolean or schema), items, minItems, maxItems,
// minimum, maximum, minLength, maxLength, pattern, anyOf, oneOf, allOf, nullable.
// Deliberately NOT supported: $ref, if/then/else, patternProperties, format,
// uniqueItems — a `$ref`-free schema is easy for a model to write and for a human
// to audit, which is the point. Unknown keywords are ignored, never rejected.

import type { Validator } from './extract';

/** A JSON Schema document (the subset above). Plain JSON, so it is component data. */
export type JsonSchema = Record<string, unknown>;

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';

const typeOf = (value: unknown): JsonType | 'undefined' => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'undefined';
  }
};

const show = (value: unknown): string => {
  const json = JSON.stringify(value);
  const text = json === undefined ? String(value) : json;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validates `value` against `schema`, returning every violation as a
 * human-readable string with a JSON-pointer-style path (`$`, `$.items[2].id`).
 * An empty array means valid. Never throws on a malformed schema — a schema an
 * agent wrote badly should read as "invalid", not crash the system checking it.
 */
export function validateJson(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  const at = (msg: string): void => {
    errors.push(`${path}: ${msg}`);
  };

  if (value === null && schema.nullable === true) return errors;

  // type
  if (schema.type !== undefined) {
    const allowed = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    const actual = typeOf(value);
    const ok = allowed.some((t) =>
      t === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : t === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : t === actual,
    );
    if (!ok) {
      at(
        `expected ${allowed.join(' | ')}, got ${actual === 'undefined' ? 'undefined' : show(value)}`,
      );
      return errors; // further keyword checks assume the right type
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    at(`must be one of ${schema.enum.map(show).join(', ')}, got ${show(value)}`);
  }
  if (Object.hasOwn(schema, 'const') && !deepEqual(schema.const, value)) {
    at(`must equal ${show(schema.const)}, got ${show(value)}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      at(`length ${value.length} is below minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      at(`length ${value.length} exceeds maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) at(`does not match pattern ${schema.pattern}`);
      } catch {
        at(`schema pattern ${show(schema.pattern)} is not a valid regular expression`);
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      at(`${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      at(`${value} exceeds maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      at(`${value.length} item(s) is below minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      at(`${value.length} item(s) exceeds maxItems ${schema.maxItems}`);
    }
    if (isSchema(schema.items)) {
      for (const [i, item] of value.entries()) {
        errors.push(...validateJson(item, schema.items as JsonSchema, `${path}[${i}]`));
      }
    }
  }

  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    const properties = isSchema(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as unknown[]) {
        if (typeof key === 'string' && !Object.hasOwn(record, key)) {
          at(`missing required property "${key}"`);
        }
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(record, key) && isSchema(sub))
        errors.push(...validateJson(record[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) at(`unexpected property "${key}"`);
      }
    } else if (isSchema(schema.additionalProperties)) {
      for (const [key, sub] of Object.entries(record)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(
            ...validateJson(sub, schema.additionalProperties as JsonSchema, `${path}.${key}`),
          );
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf)
      if (isSchema(sub)) errors.push(...validateJson(value, sub, path));
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(isSchema);
    if (
      branches.length > 0 &&
      !branches.some((sub) => validateJson(value, sub, path).length === 0)
    ) {
      at(`matches none of the ${branches.length} anyOf alternatives`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.filter(isSchema);
    const matching = branches.filter((sub) => validateJson(value, sub, path).length === 0).length;
    if (branches.length > 0 && matching !== 1) {
      at(`matches ${matching} of the oneOf alternatives; exactly one is required`);
    }
  }
  return errors;
}

const isSchema = (candidate: unknown): candidate is JsonSchema =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);

/**
 * Checks that `schema` is a well-formed schema in the supported subset, so a
 * malformed declaration is refused when it is declared rather than crashing the
 * system that later validates a paid model reply against it. Returns
 * violations; empty means well-formed. Unknown keywords are ignored.
 */
export function validateSchemaShape(schema: unknown, path = '$'): string[] {
  if (!isSchema(schema)) return [`${path}: a schema must be a JSON object, got ${show(schema)}`];
  const errors: string[] = [];
  const at = (msg: string): void => {
    errors.push(`${path}: ${msg}`);
  };
  const s = schema;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) {
      if (typeof t !== 'string' || !JSON_TYPES.has(t)) at(`unknown type ${show(t)}`);
    }
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) {
    at('"enum" must be a non-empty array');
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || !s.required.every((k) => typeof k === 'string')) {
      at('"required" must be an array of property names');
    }
  }
  for (const key of ['minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength']) {
    if (s[key] !== undefined && typeof s[key] !== 'number') at(`"${key}" must be a number`);
  }
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string') at('"pattern" must be a string');
    else {
      try {
        new RegExp(s.pattern);
      } catch {
        at(`"pattern" ${show(s.pattern)} is not a valid regular expression`);
      }
    }
  }
  if (s.nullable !== undefined && typeof s.nullable !== 'boolean')
    at('"nullable" must be a boolean');
  if (s.properties !== undefined) {
    if (!isSchema(s.properties)) at('"properties" must be an object of schemas');
    else {
      for (const [key, sub] of Object.entries(s.properties)) {
        errors.push(...validateSchemaShape(sub, `${path}.properties.${key}`));
      }
    }
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') {
    errors.push(...validateSchemaShape(s.additionalProperties, `${path}.additionalProperties`));
  }
  if (s.items !== undefined) errors.push(...validateSchemaShape(s.items, `${path}.items`));
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (s[key] === undefined) continue;
    if (!Array.isArray(s[key]) || (s[key] as unknown[]).length === 0) {
      at(`"${key}" must be a non-empty array of schemas`);
      continue;
    }
    for (const [i, sub] of (s[key] as unknown[]).entries()) {
      errors.push(...validateSchemaShape(sub, `${path}.${key}[${i}]`));
    }
  }
  return errors;
}

/**
 * A `Validator` for `extractJson` that enforces `schema` (the subset above) and
 * throws with every violation listed, so the model sees precisely what to fix on
 * the retry. Closes the gap `extractJson` documents — "schema: never validated
 * against" — without adding a dependency.
 *
 * ```ts
 * const plan = await extractJson<Plan>(model, { prompt, schema }, schemaValidator<Plan>(schema));
 * ```
 */
export function schemaValidator<T = unknown>(schema: JsonSchema): Validator<T> {
  return (parsed) => {
    const errors = validateJson(parsed, schema);
    if (errors.length > 0) throw new Error(`does not match the schema: ${errors.join('; ')}`);
    return parsed as T;
  };
}
