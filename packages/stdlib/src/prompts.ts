// Prompt registry (SPEC §13, @langecs/stdlib): versioned, injection-safe
// prompt templates resolved by name, mirroring the ModelRef/callLLM and
// ToolDef/registerTools resolve-by-name patterns exactly.
//
// A `PromptRef('name@version')` component holds only the pinned reference
// string (R3, data-only). The render closure carries behavior, so it lives in
// the `prompts` world resource — never in a component. `resolvePrompt` resolves
// the registry via `ctx.resource`, renders with the entity's `PromptVars`, and
// writes a `RenderedPrompt` string, firing exactly once via `Not(RenderedPrompt)`.

import { type ComponentType, defineComponent, defineSystem, Not, type World } from '@langecs/core';

/**
 * Pinned prompt reference `'name@version'` (e.g. `'greeting@1.0.0'`). Data-only
 * (R3); mirrors `ModelRef`. `@version` is MANDATORY — a bare name will not match
 * any stored `name@version` key and resolves to a "not found" error.
 */
export const PromptRef: ComponentType<string> = defineComponent<string>({ name: 'PromptRef' });

/** The rendered prompt output string (R3); typically consumed as a `SystemPrompt`. */
export const RenderedPrompt: ComponentType<string> = defineComponent<string>({
  name: 'RenderedPrompt',
});

/** Per-entity render inputs (R3, JSON-serializable). The renderer reads these by name. */
export const PromptVars: ComponentType<Record<string, unknown>> = defineComponent<
  Record<string, unknown>
>({ name: 'PromptVars' });

/** World resource name the prompt registry registers under. */
export const PROMPTS_RESOURCE = 'prompts' as const;

/**
 * One versioned template. `render` is a typed `(vars: T) => string` closure that
 * carries behavior, so it lives ONLY here in the registry resource, never in a
 * component (R3). `name` + `version` combine as the lookup key `${name}@${version}`.
 */
export interface PromptTemplate<T = Record<string, unknown>> {
  name: string;
  /** e.g. `'1.0.0'` — combined as `${name}@${version}`. */
  version: string;
  /** Typed, injection-safe renderer; lives in the registry, not a component (R3). */
  render: (vars: T) => string;
}

/** A resolved-by-name registry of versioned prompt templates. */
export interface PromptRegistry {
  /** Resolve & render a pinned `'name@version'` ref; throws on an unknown ref. */
  render(ref: string, vars: Record<string, unknown>): string;
  /** Frozen lookup of a resolved template (provenance/inspection); `undefined` on miss. */
  get(ref: string): PromptTemplate | undefined;
}

/** Identity helper for typing/DX symmetry with `defineTool`/`defineComponent`. */
export function definePrompts<T>(templates: PromptTemplate<T>[]): PromptTemplate<T>[] {
  return templates;
}

/**
 * Injection-safe single-pass slot substitution. One regex pass over the TEMPLATE
 * only replaces each `{{name}}` slot with the opaque `String(value)`; a missing
 * var renders to an empty string. Substituted values are never re-parsed, so a
 * value like `}}{{secret}}` or `</system>` lands literally and cannot open a new
 * slot or escape a delimiter. No `eval`, no `Function`, no template engine.
 */
export function renderSlots(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    key in vars ? String(vars[key]) : '',
  );
}

/**
 * Builds an in-memory `PromptRegistry` with copy-on-register immutability: each
 * template is stored as an `Object.freeze`'d shallow copy keyed by
 * `${name}@${version}`. Because a frozen copy is captured at register time, later
 * mutation of the caller's `templates` array has no effect on stored versions
 * (PROMPT-03). `render` requires a pinned `name@version` ref and throws a clear
 * error on an unknown ref. Mirrors `registerTools`/`ToolDef` (behavior in the
 * registry, R3).
 */
export function inMemoryRegistry(templates: PromptTemplate<any>[]): PromptRegistry {
  const store = new Map<string, PromptTemplate>();
  for (const t of templates) {
    const key = `${t.name}@${t.version}`;
    // copy-on-register: freeze a shallow copy; the render closure is captured by value.
    store.set(key, Object.freeze({ name: t.name, version: t.version, render: t.render }));
  }
  return {
    get: (ref) => store.get(ref),
    render: (ref, vars) => {
      const tmpl = store.get(ref);
      if (tmpl === undefined) throw new Error(`prompt not found: '${ref}'`);
      return tmpl.render(vars);
    },
  };
}

/** Registers the prompt registry as a world resource under `PROMPTS_RESOURCE` (cf. `registerTools`). */
export function registerPrompts(world: World, registry: PromptRegistry): void {
  world.register(PROMPTS_RESOURCE, registry);
}

/**
 * Resolves a pinned `PromptRef('name@version')` to a `RenderedPrompt` string,
 * mirroring `callLLM`'s resolve-by-name shape.
 *
 * Query `[PromptRef, Not(RenderedPrompt)]` makes it exactly-once: writing
 * `RenderedPrompt` removes the entity from the match set, so the pair never
 * refires on its own write, and per-pair self-write exclusion (R26) closes the
 * loop. It reads `PromptRef`/`PromptVars` and writes ONLY `RenderedPrompt`.
 */
export const resolvePrompt = defineSystem({
  name: 'resolvePrompt',
  query: [PromptRef, Not(RenderedPrompt)],
  run: (e, ctx) => {
    const registry = ctx.resource<PromptRegistry>(PROMPTS_RESOURCE);
    const vars = e.get(PromptVars) ?? {};
    e.set(RenderedPrompt, registry.render(e.get(PromptRef), vars));
  },
});
