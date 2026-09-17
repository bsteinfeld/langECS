// The declarative layer: components and systems that are DATA. **Experimental.**
//
// Everything else in LangECS keeps one line sharp — components are data (R3),
// behavior is code registered by name (R18). That line is what makes a snapshot
// plain JSON and a world auditable. It also means the one thing an agent (or a
// config file) could not do so far was add BEHAVIOR to a live world without
// someone shipping code.
//
// This module adds that rung without moving the line. A `PromptSystemDecl` is a
// JSON document describing a system whose `run` is a model call: the matched
// entity's components go in as JSON, a structured proposal comes back, and the
// proposal is validated — every part of it — against declared schemas BEFORE
// anything is buffered, then applied through the ordinary `add`/`remove`.
// Reducers, `WriteConflictError`, self-write exclusion, `Not(Cancelled)`,
// budgets, snapshots and time travel all apply unchanged, because underneath it
// is a plain `defineSystem`. Nothing here evaluates code an agent wrote. A
// `ComponentDecl` is likewise a JSON document over `defineComponent` using the
// named reducers of R59.
//
// Because both are data, a world can carry its own vocabulary: `declareComponent`
// and `declareSystem` record their declarations in a `Recipe` component on a
// well-known entity, and `hydrateRecipe` / `forkFromSnapshot` re-declare them —
// in registration order, which is barrier semantics (R25 step 6) — before
// `world.load()` in a fresh process.
//
// What a prompt system CANNOT do, on purpose: write or remove a component it did
// not declare, touch a reserved control or capability component, touch any entity
// but the one it matched, spawn, despawn, invalidate, or define components or
// systems. It also does not throw on a malformed reply: a rejected proposal is
// state (`ProposalRejected`), because a throw discards the pair's buffer (R31) —
// including the `TokenUsage` receipt for the call that was just paid for — and
// invites `retry` to pay again. The honest limits of that accounting are stated
// on `PromptLedger` below.

import {
  AwaitingHuman,
  appendReducer,
  boundedAppend,
  Cancelled,
  type ComponentType,
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  type EntityReadView,
  type EntityView,
  getComponentByName,
  HumanResponse,
  LangECSError,
  listComponents,
  type Model,
  type ModelRequest,
  type ModelResult,
  type Msg,
  mergeReducer,
  Not,
  type PersistenceAdapter,
  type QueryTerm,
  type Snapshot,
  type SystemCtx,
  type SystemDef,
  SystemError,
  sumReducer,
  type TagType,
  type World,
} from '@langecs/core';
import { BudgetExceeded, BudgetWarning, spendOf, TokenBudget, TokenUsage } from './budget';
import { MessageWaiting, ModelRef, PendingToolCalls, RetryPolicy, Tools } from './components';
import { type JsonSchema, validateJson, validateSchemaShape } from './json-schema';

// ------------------------------------------------------------- declarations

/**
 * Merge policy for a declared component, by name so it is data (R59):
 * - `'append'` — array concatenation (`appendReducer`; `max` caps it via `boundedAppend`)
 * - `'merge'` — shallow object merge, incoming keys win (`mergeReducer`)
 * - `'sum'` — numeric addition (`sumReducer`)
 * - `'last-wins'` — explicit last-write-wins, the sanctioned form of what R30 forbids silently
 * - absent — a plain component: two writers in one step is a `WriteConflictError`
 */
export type DeclaredReducer = 'append' | 'merge' | 'sum' | 'last-wins';

/** A component as data: what `defineComponent` needs, minus code. */
export interface ComponentDecl {
  name: string;
  /** One line for humans and models: what the value means. */
  description?: string;
  /**
   * JSON Schema (see `json-schema.ts` for the supported subset) that the STORED
   * value must satisfy. For reducer components the merged result is what is
   * checked, so an append fragment cannot push the array past `maxItems` and a
   * sum cannot pass `maximum`.
   */
  schema?: JsonSchema;
  /** A value-less marker (`defineTag`); `schema`/`reducer` must be absent. */
  tag?: boolean;
  reducer?: DeclaredReducer;
  /** With `reducer: 'append'`: cap the array at this many items (oldest dropped). */
  max?: number;
}

/**
 * A system as data. Underneath: `defineSystem({ query, when, run })` where `run`
 * asks `model` for a structured proposal over the matched entity's components.
 */
export interface PromptSystemDecl {
  name: string;
  /** What this system is for; shown to the model and to humans reading the recipe. */
  description?: string;
  /**
   * Positive query terms (component names) — the ONLY wake dependencies, exactly
   * as for a hand-written system (R26). At least one is required.
   */
  query: string[];
  /** Negative terms (component names). `Cancelled` is always excluded (R50). */
  not?: string[];
  /**
   * Components shown to the model as context. Defaults to `query`. Extra names
   * here are context only: a change to them never wakes this system, and other
   * entities' components are never dependencies either.
   */
  reads?: string[];
  /**
   * Components this system may write on the matched entity — always via `add`,
   * so a reducer merges and a plain component is set (R15). The model must not
   * name anything else; if it does the whole proposal is rejected. Reserved
   * control and capability components (see `RESERVED_COMPONENTS`) are refused
   * at declaration time.
   */
  writes?: string[];
  /** Components this system may remove from the matched entity. Same reservations. */
  removes?: string[];
  /** Resource name of the `Model` (e.g. `'model:main'`). */
  model: string;
  /** The instructions. The output-format contract is appended by this module. */
  prompt: string;
  /** Scope to an agent's instances: adds the `agent:<name>` auto-tag as a positive term (R34). */
  agent?: string;
  /** Wall-clock budget for one execution (R52). */
  timeoutMs?: number;
  /** Forwarded as `ModelRequest.maxTokens` — bound the reply, not just the wait. */
  maxOutputTokens?: number;
  /**
   * Lifetime cap on executions of this system per entity (default 8), enforced
   * by a `when` guard over the `PromptRuns` counter. This is the brake against
   * two data-defined systems waking each other forever: self-write exclusion is
   * per pair and is not a convergence guarantee, and the engine records a write
   * as a change even when the value is identical (R26).
   */
  maxRuns?: number;
  /**
   * Park this system after a rejected proposal (default `true`): `Not(ProposalRejected)`
   * joins the query, so it stays silent until someone clears the record — a human,
   * or the agent that authored it — and clearing it re-matches the query, which is
   * what fires it again. Note the marker is per ENTITY: every prompt system on that
   * entity with this option parks together. `false` leaves the system matched, so
   * the next foreign change tries again (and pays again).
   */
  haltOnRejection?: boolean;
}

/** One proposal the validator refused. */
export interface RejectedProposal {
  system: string;
  step: number;
  /** Every violation, one per line. */
  errors: string[];
  /** The model's final reply, fences stripped and truncated, for the audit trail. */
  reply: string;
}

/**
 * Proposals a prompt system refused to apply. Queryable state in the
 * `SystemError`/`AwaitingHuman`/`Cancelled` family: a rejection is not a crash,
 * so the run reports `'done'`, and removing the component is how work resumes.
 * Bounded (R59) so a misbehaving model cannot grow a snapshot without limit.
 */
export const ProposalRejected: ComponentType<RejectedProposal[]> = defineComponent<
  RejectedProposal[]
>({
  name: 'ProposalRejected',
  reducer: boundedAppend<RejectedProposal>(50),
});

/**
 * Executions per prompt system on this entity — `{ [systemName]: count }`.
 * Written by each prompt system after every completed execution (a self-write,
 * so it wakes nothing) and read by its `maxRuns` guard.
 */
export const PromptRuns: ComponentType<Record<string, number>> = defineComponent<
  Record<string, number>
>({
  name: 'PromptRuns',
  // Two prompt systems on one entity in one step write disjoint keys; shallow
  // merge keeps both. The same key cannot be written twice in a step (one
  // execution per pair per step).
  reducer: mergeReducer<Record<string, number>>(),
});

/** The world's own vocabulary and behavior, as data, on one entity. */
export interface RecipeValue {
  version: 1;
  components: ComponentDecl[];
  /** Every declared prompt system, dormant ones included, in registration order. */
  systems: PromptSystemDecl[];
  /**
   * Every registered system key at the last change — hand-written ones included,
   * in registration order. Barrier apply order follows it (R25 step 6), so a
   * rehydrated world must reproduce it; `hydrateRecipe` checks.
   */
  order: string[];
}

/**
 * Carried by exactly one entity per world (spawned on first use). Nothing
 * queries it, so writing it changes no scheduling; it exists so a snapshot can be
 * rehydrated by `hydrateRecipe` in a process that never saw the declarations.
 * Prompt systems may never write it (a system defined as data must not redefine
 * the world's systems from inside a run); it changes only at idle, through
 * `declareComponent`/`declareSystem`, which is auditable and time-travellable.
 */
export const Recipe: ComponentType<RecipeValue> = defineComponent<RecipeValue>({
  name: 'Recipe',
  reducer: (_current, incoming) => incoming,
});

/**
 * Components a prompt system may never write or remove, whatever it declares.
 * Control state (cancellation, approvals, errors, budgets, the recipe, this
 * layer's own bookkeeping) and capability components — writing `PendingToolCalls`
 * or `Tools` is not harmless just because it is JSON: it invokes tools through
 * `executeTools`. The `agent:*` auto-tags are reserved too (R34 scoping). A host
 * that wants a prompt system to reach these does it through a hand-written
 * system with an explicit contract, not by widening this list.
 */
export const RESERVED_COMPONENTS: ReadonlySet<string> = new Set([
  Recipe.componentName,
  ProposalRejected.componentName,
  PromptRuns.componentName,
  Cancelled.componentName,
  AwaitingHuman.componentName,
  HumanResponse.componentName,
  SystemError.componentName,
  TokenBudget.componentName,
  TokenUsage.componentName,
  BudgetExceeded.componentName,
  BudgetWarning.componentName,
  Tools.componentName,
  ModelRef.componentName,
  PendingToolCalls.componentName,
  MessageWaiting.componentName,
  RetryPolicy.componentName,
]);

const isReserved = (name: string): boolean =>
  RESERVED_COMPONENTS.has(name) || name.startsWith('agent:');

// ------------------------------------------------------- attempt ledger

/** One model call a prompt system made, recorded at admission and settled after. */
export interface PromptAttempt {
  system: string;
  entity: number;
  step: number;
  /** 1 for the first call, 2 for the correction retry. */
  attempt: 1 | 2;
  /** `'pending'` until the provider answers; a process that dies mid-call leaves it so. */
  status: 'pending' | 'delivered' | 'failed';
  /** Reported or estimated tokens once delivered; absent while pending or after a failure. */
  tokens?: number;
  /** Failure text, for `'failed'`. The provider may still have done paid work. */
  error?: string;
  /** How the proposal this call produced was judged, once the execution finished. */
  proposal?: 'accepted' | 'rejected';
  /** `Date.now()` at admission. */
  at: number;
}

/**
 * Host-owned record of every model call the prompt systems made, kept OUTSIDE
 * the world's transactional state, so a barrier rejection (R30), a discarded
 * buffer (R31) or a timeout (R52) cannot erase it. This is the accounting to
 * trust; the `TokenUsage` mirror each system appends to its entity is
 * best-effort — it survives only when the pair's buffer commits.
 *
 * Honest limits: a `'failed'` attempt may still have cost tokens (a request can
 * reach the provider and generate before the client sees an error or an abort),
 * so `failed` rows carry no `tokens`, not zero. A world-level cap that must hold
 * strictly needs admission control (reserve before calling) built on this
 * ledger; `budgetWatchdog` (R63) is a delayed brake by design.
 */
export class PromptLedger {
  readonly attempts: PromptAttempt[] = [];

  /** Records an attempt at admission; the returned row is settled in place. */
  open(attempt: Omit<PromptAttempt, 'status' | 'at'>): PromptAttempt {
    const row: PromptAttempt = { ...attempt, status: 'pending', at: Date.now() };
    this.attempts.push(row);
    return row;
  }

  /** Tokens across delivered attempts, optionally for one system. */
  spent(system?: string): number {
    return this.attempts.reduce(
      (sum, a) =>
        a.status === 'delivered' && (system === undefined || a.system === system)
          ? sum + (a.tokens ?? 0)
          : sum,
      0,
    );
  }
}

/** Resource name the ledger registers under; systems look it up by this name. */
export const PROMPT_LEDGER_RESOURCE = 'langecs:prompt-ledger';

/** The world's `PromptLedger`, registering a fresh one on first use. */
export function promptLedger(world: World): PromptLedger {
  const ledger = ledgers.get(world);
  if (ledger !== undefined) return ledger;
  // Resource values are never exposed by introspection (R18), so a ledger this
  // module did not create cannot be read back — refuse rather than overwrite it.
  if (world.resources().includes(PROMPT_LEDGER_RESOURCE)) {
    throw new LangECSError(
      `Resource "${PROMPT_LEDGER_RESOURCE}" is registered but was not created by promptLedger(); ` +
        'register the ledger through promptLedger(world) only.',
    );
  }
  const fresh = new PromptLedger();
  world.register(PROMPT_LEDGER_RESOURCE, fresh);
  ledgers.set(world, fresh);
  return fresh;
}

const ledgers = new WeakMap<World, PromptLedger>();

const optionalLedger = (ctx: SystemCtx): PromptLedger | undefined => {
  try {
    return ctx.resource<PromptLedger>(PROMPT_LEDGER_RESOURCE);
  } catch {
    return undefined;
  }
};

// ------------------------------------------------- component declarations

const declared = new Map<string, ComponentDecl>();
/** The unwrapped R59 reducer per declared component, for validation dry runs. */
const declaredReducers = new Map<string, (current: any, incoming: any) => any>();

/** Full canonical identity — everything but the human-facing description. */
const identityOf = (decl: ComponentDecl): string =>
  JSON.stringify({
    tag: decl.tag === true,
    reducer: decl.reducer ?? null,
    max: decl.reducer === 'append' ? (decl.max ?? null) : null,
    schema: decl.schema ?? null,
  });

function reducerFor(decl: ComponentDecl): ((current: any, incoming: any) => any) | undefined {
  switch (decl.reducer) {
    case undefined:
      return undefined;
    case 'append':
      return decl.max === undefined ? appendReducer<unknown>() : boundedAppend<unknown>(decl.max);
    case 'merge':
      return mergeReducer<object>();
    case 'sum':
      return sumReducer();
    case 'last-wins':
      return (_current: unknown, incoming: unknown) => incoming;
    default:
      throw new LangECSError(
        `Component "${decl.name}": unknown reducer "${String(decl.reducer)}". ` +
          `Use one of append, merge, sum, last-wins, or omit it for a plain component.`,
      );
  }
}

/** Structural checks on a declaration — no registry side effects. */
function validateComponentDecl(decl: ComponentDecl): void {
  if (typeof decl.name !== 'string' || decl.name.length === 0) {
    throw new LangECSError('A component declaration needs a non-empty "name".');
  }
  if (decl.description !== undefined && typeof decl.description !== 'string') {
    throw new LangECSError(`Component "${decl.name}": "description" must be a string.`);
  }
  if (decl.tag !== undefined && typeof decl.tag !== 'boolean') {
    throw new LangECSError(`Component "${decl.name}": "tag" must be a boolean.`);
  }
  if (isReserved(decl.name)) {
    throw new LangECSError(`Component "${decl.name}": that name is reserved.`);
  }
  if (decl.schema !== undefined) {
    const shape = validateSchemaShape(decl.schema);
    if (shape.length > 0) {
      throw new LangECSError(
        `Component "${decl.name}": malformed schema — ${shape.join('; ')}. A schema that cannot ` +
          `be evaluated would fail after a model reply was paid for; it is refused here instead.`,
      );
    }
  }
  if (decl.tag === true && (decl.schema !== undefined || decl.reducer !== undefined)) {
    throw new LangECSError(
      `Component "${decl.name}": a tag has no value, so it takes no schema and no reducer.`,
    );
  }
  if (decl.max !== undefined && decl.reducer !== 'append') {
    throw new LangECSError(`Component "${decl.name}": "max" only applies to reducer "append".`);
  }
  if (decl.max !== undefined && (!Number.isInteger(decl.max) || decl.max <= 0)) {
    throw new LangECSError(`Component "${decl.name}": "max" must be a positive integer.`);
  }
  reducerFor(decl); // rejects an unknown reducer name
  const existing = declared.get(decl.name);
  if (existing !== undefined) {
    if (identityOf(existing) !== identityOf(decl)) {
      throw new LangECSError(
        `Component "${decl.name}" is already declared with a different schema, reducer or ` +
          `tag-ness. Names are global (R7); declare a new name, or bump recipeVersion and ` +
          `migrate (R54) to change what existing values mean.`,
      );
    }
    return;
  }
  if (getComponentByName(decl.name) !== undefined) {
    throw new LangECSError(
      `Component "${decl.name}" is already defined in code. Declared components need a fresh ` +
        `name; a prompt system can still read the code-defined one by naming it.`,
    );
  }
}

/**
 * Turns a `ComponentDecl` into a real `ComponentType`, registering it in the
 * global registry (R7). Idempotent for an identical declaration (same schema,
 * reducer, cap and tag-ness — the description may differ); a differing one
 * throws, because R7 makes the registry per-realm and a redefinition would
 * silently change what every existing value means. A name already defined in
 * code (e.g. stdlib's `Messages`) throws too.
 */
export function componentFromDecl(decl: ComponentDecl & { tag: true }): TagType;
export function componentFromDecl(decl: ComponentDecl): ComponentType<any>;
export function componentFromDecl(decl: ComponentDecl): ComponentType<any> {
  validateComponentDecl(decl);
  const existing = declared.get(decl.name);
  if (existing !== undefined) {
    declared.set(decl.name, { ...existing, ...decl });
    return getComponentByName(decl.name) as ComponentType<any>;
  }
  if (decl.tag === true) {
    // A real tag (R6): zero-arg callable, value `true`, reported as a tag by
    // `listComponents`, and present in snapshots. `defineComponent<true>` was
    // none of those — `Flag()` stored `undefined`, which a snapshot drops.
    const tag = defineTag(decl.name);
    declared.set(decl.name, { ...decl });
    return tag as ComponentType<any>;
  }
  const base = reducerFor(decl);
  const schema = decl.schema;
  // The declared schema is an invariant on the STORED value. `checkWrite`
  // validates a proposal against step-start state, which is all a pair can see —
  // but two pairs each merging a valid fragment can still land past the bound at
  // the barrier (+6 and +6 on 0 with maximum 10). The reducer is the only code
  // that sees the real merged value, so it checks it there; a violation rejects
  // the step at staging (R25) with nothing committed, which is the engine's one
  // sanctioned answer to an invariant that cannot be kept (R30).
  const reducer =
    base === undefined || schema === undefined
      ? base
      : (current: unknown, incoming: unknown): unknown => {
          const merged = base(current, incoming);
          const errors = validateJson(merged, schema, decl.name);
          if (errors.length > 0) {
            throw new LangECSError(
              `Declared component "${decl.name}": the merged value violates its schema — ` +
                `${errors.join('; ')}. Each write passed validation against step-start state; ` +
                `together they cannot keep the invariant, so the step is rejected (R25/R30).`,
            );
          }
          return merged;
        };
  const type = defineComponent<unknown>(
    reducer === undefined ? { name: decl.name } : { name: decl.name, reducer },
  );
  declared.set(decl.name, { ...decl });
  if (base !== undefined) declaredReducers.set(decl.name, base);
  return type as ComponentType<any>;
}

/** The declaration behind a declared component name, if `componentFromDecl` saw one. */
export function declarationOf(name: string): ComponentDecl | undefined {
  const decl = declared.get(name);
  return decl === undefined ? undefined : { ...decl };
}

// ------------------------------------------------------- prompt systems

const truncate = (text: string, max = 400): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;

/** Strips one wrapping markdown code fence, like `extractJson` does. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[\w-]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

interface Proposal {
  writes: Record<string, unknown>;
  remove: string[];
  note?: string;
}

type FullDecl = PromptSystemDecl & { writes: string[]; removes: string[] };

/**
 * What the HOST lets prompt systems touch. Being defined in code is not an
 * authorization: a native component such as an application's `Approved` marker
 * is exactly what a prompt system must not be able to grant itself. By default
 * a prompt system may write or remove only components that were DECLARED
 * through this layer; the host opens native ones explicitly.
 */
export interface AuthoringPolicy {
  /** Native (code-defined) components prompt systems may write or remove. */
  allowNative?: readonly string[];
  /** Components no prompt system may write or remove, declared or not. */
  deny?: readonly string[];
}

export interface ValidateSystemDeclOptions {
  /** Component names that resolve (default: the registry). */
  knownNames?: ReadonlySet<string>;
  /** Names counted as declared (default: this module's declarations); a recipe adds its own. */
  declaredNames?: ReadonlySet<string>;
  /**
   * The host policy for native targets. `'unchecked'` skips the policy — for
   * the pure `systemFromDecl` factory, where the caller IS host code.
   */
  policy?: AuthoringPolicy | 'unchecked';
}

/**
 * Checks a system declaration against a set of known component names — the
 * registry plus whatever a recipe is about to declare — without registering
 * anything. Returns the normalized declaration.
 */
export function validateSystemDecl(
  decl: PromptSystemDecl,
  options: ValidateSystemDeclOptions = {},
): FullDecl {
  const knownNames = options.knownNames ?? new Set(listComponents().map((c) => c.name));
  const declaredNames = options.declaredNames ?? new Set(declared.keys());
  const policy = options.policy ?? {};
  if (typeof decl.name !== 'string' || decl.name.length === 0) {
    throw new LangECSError('A prompt system declaration needs a non-empty "name".');
  }
  const where = `Prompt system "${decl.name}"`;
  // Shape first, every field: a manifest is untrusted input, and a field of the
  // wrong shape that slipped past here used to surface only inside
  // `systemFromDecl` — after the recipe's components had already registered.
  const names = (field: 'not' | 'reads' | 'writes' | 'removes'): void => {
    const value = decl[field];
    if (value === undefined) return;
    if (!Array.isArray(value) || !value.every((n) => typeof n === 'string' && n.length > 0)) {
      throw new LangECSError(`${where}: "${field}" must be an array of component names.`);
    }
  };
  for (const field of ['not', 'reads', 'writes', 'removes'] as const) names(field);
  for (const field of ['description', 'agent'] as const) {
    if (decl[field] !== undefined && typeof decl[field] !== 'string') {
      throw new LangECSError(`${where}: "${field}" must be a string.`);
    }
  }
  for (const field of ['timeoutMs', 'maxOutputTokens'] as const) {
    const value = decl[field];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    ) {
      throw new LangECSError(`${where}: "${field}" must be a positive finite number.`);
    }
  }
  if (decl.haltOnRejection !== undefined && typeof decl.haltOnRejection !== 'boolean') {
    throw new LangECSError(`${where}: "haltOnRejection" must be a boolean.`);
  }
  if (
    !Array.isArray(decl.query) ||
    decl.query.length === 0 ||
    !decl.query.every((n) => typeof n === 'string' && n.length > 0)
  ) {
    throw new LangECSError(`${where}: "query" needs at least one component name (R21).`);
  }
  if (typeof decl.model !== 'string' || decl.model.length === 0) {
    throw new LangECSError(`${where}: "model" (a resource name) is required.`);
  }
  if (typeof decl.prompt !== 'string' || decl.prompt.length === 0) {
    throw new LangECSError(`${where}: "prompt" is required.`);
  }
  if (decl.maxRuns !== undefined && (!Number.isInteger(decl.maxRuns) || decl.maxRuns <= 0)) {
    throw new LangECSError(`${where}: "maxRuns" must be a positive integer.`);
  }
  const writes = decl.writes ?? [];
  const removes = decl.removes ?? [];
  const known = (name: string, role: string): void => {
    if (!knownNames.has(name)) {
      const list = [...knownNames]
        .filter((n) => !n.startsWith('agent:'))
        .sort()
        .join(', ');
      throw new LangECSError(
        `${where}: ${role} names unknown component "${name}". Declare it first, or use one of: ${list}.`,
      );
    }
  };
  for (const name of decl.query) known(name, '"query"');
  for (const name of decl.not ?? []) known(name, '"not"');
  for (const name of decl.reads ?? []) known(name, '"reads"');
  const target = (name: string, verb: string): void => {
    if (isReserved(name)) {
      throw new LangECSError(
        `${where} may not ${verb} "${name}": it is a reserved control or capability component.`,
      );
    }
    if (policy === 'unchecked') return;
    if (policy.deny?.includes(name)) {
      throw new LangECSError(`${where} may not ${verb} "${name}": denied by the host policy.`);
    }
    if (!declaredNames.has(name) && !(policy.allowNative?.includes(name) ?? false)) {
      throw new LangECSError(
        `${where} may not ${verb} "${name}": it is a native (code-defined) component, and being ` +
          `defined in code is not an authorization. The host must list it in the authoring ` +
          `policy's allowNative to open it to prompt systems.`,
      );
    }
  };
  for (const name of writes) {
    known(name, '"writes"');
    target(name, 'write');
  }
  for (const name of removes) {
    known(name, '"removes"');
    target(name, 'remove');
  }
  if (decl.agent !== undefined) known(`agent:${decl.agent}`, '"agent"');
  return { ...decl, writes, removes };
}

/** Renders one component's contract for the model. */
function describeComponent(name: string): string {
  const decl = declared.get(name);
  const info = listComponents().find((c) => c.name === name);
  const parts: string[] = [];
  if (info?.tag) parts.push('a tag: write exactly true');
  else if (decl?.schema !== undefined) parts.push(`schema ${JSON.stringify(decl.schema)}`);
  else parts.push('any JSON value (no schema declared)');
  if (decl?.reducer !== undefined) {
    parts.push(`reducer: ${decl.reducer}${decl.max !== undefined ? ` (max ${decl.max})` : ''}`);
  } else if (info?.reducer) parts.push('has a reducer: your value is MERGED with the current one');
  else parts.push('plain: your value REPLACES the current one');
  const description = decl?.description;
  return `- ${name}${description !== undefined ? ` — ${description}` : ''} (${parts.join('; ')})`;
}

/**
 * Validates a parsed reply against the declaration and the current entity.
 * Returns the proposal or the list of violations; never throws.
 */
function checkProposal(
  parsed: unknown,
  decl: FullDecl,
  e: EntityReadView<any>,
): { ok: true; proposal: Proposal } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ['reply must be a JSON object like {"writes": {...}, "remove": [...]}'],
    };
  }
  const reply = parsed as Record<string, unknown>;
  for (const key of Object.keys(reply)) {
    if (key !== 'writes' && key !== 'remove' && key !== 'note') {
      errors.push(`unexpected top-level key "${key}"`);
    }
  }
  const writes: Record<string, unknown> = {};
  if (reply.writes !== undefined) {
    if (typeof reply.writes !== 'object' || reply.writes === null || Array.isArray(reply.writes)) {
      errors.push('"writes" must be an object keyed by component name');
    } else {
      for (const [name, value] of Object.entries(reply.writes as Record<string, unknown>)) {
        if (!decl.writes.includes(name)) {
          errors.push(
            `"${name}" is not in this system's allowed writes (${decl.writes.join(', ') || 'none'})`,
          );
          continue;
        }
        errors.push(...checkWrite(name, value, e));
        writes[name] = value;
      }
    }
  }
  const remove: string[] = [];
  if (reply.remove !== undefined) {
    if (!Array.isArray(reply.remove) || !reply.remove.every((n) => typeof n === 'string')) {
      errors.push('"remove" must be an array of component names');
    } else {
      for (const name of reply.remove as string[]) {
        if (!decl.removes.includes(name)) {
          errors.push(
            `"${name}" is not in this system's allowed removes (${decl.removes.join(', ') || 'none'})`,
          );
          continue;
        }
        if (Object.hasOwn(writes, name)) errors.push(`"${name}" is both written and removed`);
        remove.push(name);
      }
    }
  }
  if (reply.note !== undefined && typeof reply.note !== 'string') {
    errors.push('"note" must be a string');
  }
  if (errors.length > 0) return { ok: false, errors };
  const proposal: Proposal = { writes, remove };
  if (typeof reply.note === 'string') proposal.note = reply.note;
  return { ok: true, proposal };
}

/**
 * One write, checked the way the barrier will apply it: a tag must be `true`;
 * a plain component's value must satisfy the schema; a reducer component's
 * MERGED value must — computed by dry-running the pure reducer (R59) against
 * the committed value, which also turns a reducer that cannot merge the value
 * (a string into an append) into a rejection instead of a staging throw that
 * would reject the whole run (R25).
 */
function checkWrite(name: string, value: unknown, e: EntityReadView<any>): string[] {
  const type = getComponentByName(name) as ComponentType<any>;
  return checkDeclaredWrite(name, value, e.has(type) ? e.get(type) : undefined);
}

/**
 * Validates one `add` of `value` to component `name` the way a prompt system's
 * proposal is validated: a tag must be `true`; a declared reducer fixes the
 * fragment's kind; the declared schema is checked against the MERGED value when
 * `current` is given and the component has a reducer, else against `value`.
 * Returns violations (empty = fine); never throws. Exported so a host that
 * accepts external edits (the playground's MCP `edit`) can refuse a bad value
 * before it reaches the world.
 */
export function checkDeclaredWrite(name: string, value: unknown, current?: unknown): string[] {
  const type = getComponentByName(name) as ComponentType<any> | undefined;
  if (type === undefined) return [`${name}: unknown component`];
  const info = listComponents().find((c) => c.name === name);
  if (info?.tag) {
    return value === true
      ? []
      : [`${name}: a tag must be written as true, got ${JSON.stringify(value)}`];
  }
  const decl = declared.get(name);
  const schema = decl?.schema;
  // The declared reducer fixes the KIND of an incoming fragment independently of
  // any schema: `append` merges arrays, `sum` numbers, `merge` objects. A string
  // handed to an append reducer would spread into characters without throwing,
  // so the dry run below would not catch it.
  const kind = decl?.reducer;
  if (kind === 'append' && !Array.isArray(value)) {
    return [
      `${name}: reducer "append" takes an array fragment, got ${truncate(JSON.stringify(value) ?? 'undefined', 80)}`,
    ];
  }
  if (kind === 'sum' && typeof value !== 'number') {
    return [
      `${name}: reducer "sum" takes a number, got ${truncate(JSON.stringify(value) ?? 'undefined', 80)}`,
    ];
  }
  if (kind === 'merge' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    return [
      `${name}: reducer "merge" takes an object, got ${truncate(JSON.stringify(value) ?? 'undefined', 80)}`,
    ];
  }
  if (type.reducer !== undefined && current !== undefined) {
    // Dry-run the UNWRAPPED reducer: the declared one also enforces the schema
    // and would throw, and the point here is to report the violation, not throw.
    const merge = declaredReducers.get(name) ?? type.reducer;
    let merged: unknown;
    try {
      merged = merge(current, value);
    } catch (err) {
      return [
        `${name}: the reducer cannot merge ${truncate(JSON.stringify(value) ?? 'undefined', 80)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ];
    }
    return schema === undefined
      ? []
      : validateJson(merged, schema, name).map((msg) => `${msg} (after merging your write)`);
  }
  return schema === undefined ? [] : validateJson(value, schema, name);
}

function parse(
  text: string,
  decl: FullDecl,
  e: EntityReadView<any>,
): { ok: true; proposal: Proposal } | { ok: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return checkProposal(parsed, decl, e);
}

const systemCache = new Map<string, SystemDef<any>>();

const canonical = (decl: PromptSystemDecl): string =>
  JSON.stringify(decl, Object.keys(decl).sort());

/**
 * Turns a `PromptSystemDecl` into a real `SystemDef` — global unless `agent` is
 * set. Memoized on the canonical declaration, so declaring the identical JSON
 * twice yields the same object and `world.use` stays idempotent (R21); a changed
 * prompt under the same name is a different system and needs a new name (core
 * has no unregister).
 *
 * The run, in order: build the request (static contract in `system`, the entity's
 * `reads` as JSON in the user turn); call the model with `ctx.signal` and
 * `maxOutputTokens`; parse and validate the whole envelope; on a bad reply, one
 * correction retry with the violations as context; on a second bad reply, write
 * `ProposalRejected` and apply nothing. Every call is recorded in the world's
 * `PromptLedger` at admission (REQUIRED — a world without one fails the pair
 * before any call is made; `declareSystem`/`hydrateRecipe` register it) and
 * appended to the entity's `TokenUsage` on completion. On the expected paths only
 * a transport failure or a cancellation throws; a defect in a validator or a
 * reducer still surfaces as a `SystemError` rather than being swallowed.
 */
export function systemFromDecl(decl: PromptSystemDecl): SystemDef<any> {
  const key = canonical(decl);
  const cached = systemCache.get(key);
  if (cached !== undefined) return cached;

  // The pure factory is host code by definition; policy is applied by
  // `declareSystem` and `hydrateRecipe`, which take untrusted declarations.
  const full = validateSystemDecl(decl, { policy: 'unchecked' });
  const positives = full.query.map((n) => getComponentByName(n) as ComponentType<any>);
  const negatives = (full.not ?? []).map((n) => getComponentByName(n) as ComponentType<any>);
  const reads = (full.reads ?? full.query).map((n) => getComponentByName(n) as ComponentType<any>);
  const haltOnRejection = full.haltOnRejection ?? true;
  const maxRuns = full.maxRuns ?? 8;

  const query: QueryTerm[] = [...positives];
  if (full.agent !== undefined) {
    query.push(getComponentByName(`agent:${full.agent}`) as ComponentType<any>);
  }
  query.push(...negatives.map((c) => Not(c)));
  if (!negatives.includes(Cancelled)) query.push(Not(Cancelled));
  // Model-calling systems carry the budget brake (R63); a data-defined one gets
  // it from the compiler rather than trusting its author to remember.
  if (!negatives.includes(BudgetExceeded)) query.push(Not(BudgetExceeded));
  if (haltOnRejection) query.push(Not(ProposalRejected));

  const contract = [
    `You are the system "${full.name}" in a LangECS world${full.description !== undefined ? `: ${full.description}` : '.'}`,
    full.prompt,
    'You will be shown one entity as JSON (component name -> value). Decide what to write to it.',
    full.writes.length > 0
      ? `You MAY write these components (each value must satisfy its contract):\n${full.writes.map(describeComponent).join('\n')}`
      : 'You may not write any component.',
    full.removes.length > 0
      ? `You MAY remove these components: ${full.removes.join(', ')}.`
      : 'You may not remove any component.',
    'Reply with ONLY one JSON object, no prose, no markdown fences:\n' +
      '{"writes": {"<Component>": <value>}, "remove": ["<Component>"], "note": "<one short sentence>"}\n' +
      'Omit "writes" or "remove" when you have nothing for them. Never name a component that is not listed above.',
  ].join('\n\n');

  const system = defineSystem({
    name: full.name,
    query,
    ...(full.timeoutMs !== undefined ? { timeoutMs: full.timeoutMs } : {}),
    // The lifetime brake (see `maxRuns`). A veto consumes the dirt (R26) and is
    // recorded in the trace, so "why did it stop?" has an answer.
    when: (e) => (e.get(PromptRuns)?.[full.name] ?? 0) < maxRuns,
    run: async (e, ctx) => {
      const model = ctx.resource<Model>(full.model);
      const ledger = optionalLedger(ctx);
      if (ledger === undefined) {
        // Refused BEFORE any paid call (R31 records it, nothing was spent): the
        // admission cap below lives in the ledger, and a prompt system without
        // one would run with only the committed `PromptRuns` cap — which a
        // rejected step never commits. `declareSystem`/`hydrateRecipe` register
        // the ledger; a hand-wired `world.use(systemFromDecl(...))` must call
        // `promptLedger(world)` first.
        throw new LangECSError(
          `Prompt system "${full.name}" needs the world's PromptLedger (resource ` +
            `"${PROMPT_LEDGER_RESOURCE}") for admission control. Register it with promptLedger(world) ` +
            'before running, or declare the system through declareSystem / hydrateRecipe.',
        );
      }
      // Admission control, outside transactional state: `PromptRuns` is the
      // committed cap, but a barrier the step never commits (a sibling's
      // WriteConflictError, R30) also never commits the counter, and each retry
      // of the run would pay for the model again. The host ledger counts every
      // execution admitted for this (system, entity) in this world instance —
      // committed or rolled back — and refuses past `maxRuns` before a call is
      // made. Scope: the ledger's lifetime (a fresh world or fork starts at zero).
      // `maxRuns` counts EXECUTIONS (first attempts); each execution may make one
      // correction call, so the call ceiling per entity is 2 × maxRuns.
      const admitted = ledger.attempts.filter(
        (a) => a.system === full.name && a.entity === e.id && a.attempt === 1,
      ).length;
      if (admitted >= maxRuns) {
        ctx.emit({ kind: 'prompt-brake', system: full.name, entity: e.id, admitted, maxRuns });
        return; // no call, no writes; the pair ran, so its dirt is consumed (R26)
      }
      const view: Record<string, unknown> = {};
      for (const c of reads) if (e.has(c)) view[c.componentName] = e.get(c);
      const messages: Msg[] = [
        { role: 'user', content: `Entity #${e.id}:\n${JSON.stringify(view, null, 2)}` },
      ];
      const rows: PromptAttempt[] = [];
      const receipts: { result: ModelResult; req: ModelRequest }[] = [];

      const call = async (msgs: Msg[], attempt: 1 | 2): Promise<ModelResult> => {
        const req: ModelRequest = { messages: msgs, system: contract, signal: ctx.signal };
        if (full.maxOutputTokens !== undefined) req.maxTokens = full.maxOutputTokens;
        const row = ledger.open({ system: full.name, entity: e.id, step: ctx.step, attempt });
        rows.push(row);
        try {
          const result = await model.generate(req);
          receipts.push({ result, req });
          row.status = 'delivered';
          row.tokens = spendOf(full.name, result, req).tokens;
          return result;
        } catch (err) {
          // Provider or cancellation failure: the pair fails (R31 / R50). The
          // ledger row keeps no token count — it is unknown, not zero.
          row.status = 'failed';
          row.error = err instanceof Error ? err.message : String(err);
          throw err;
        }
      };

      const first = await call(messages, 1);
      let text = stripFences(first.message.content);
      let verdict = parse(text, full, e);
      if (!verdict.ok) {
        const second = await call(
          [
            ...messages,
            first.message,
            {
              role: 'user',
              content:
                `Your reply was rejected:\n- ${verdict.errors.join('\n- ')}\n` +
                'Reply again with ONLY a corrected JSON object.',
            },
          ],
          2,
        );
        text = stripFences(second.message.content);
        verdict = parse(text, full, e);
      }

      // Receipts first, whatever the verdict: the best-effort mirror of the ledger.
      e.add(
        TokenUsage,
        receipts.map(({ result, req }) => spendOf(full.name, result, req)),
      );
      e.add(PromptRuns, { [full.name]: (e.get(PromptRuns)?.[full.name] ?? 0) + 1 });
      for (const row of rows) row.proposal = verdict.ok ? 'accepted' : 'rejected';

      if (!verdict.ok) {
        e.add(ProposalRejected, [
          { system: full.name, step: ctx.step, errors: verdict.errors, reply: truncate(text) },
        ]);
        ctx.emit({
          kind: 'proposal-rejected',
          system: full.name,
          entity: e.id,
          errors: verdict.errors,
        });
        return;
      }
      for (const [name, value] of Object.entries(verdict.proposal.writes)) {
        e.add(getComponentByName(name) as ComponentType<any>, value);
      }
      for (const name of verdict.proposal.remove) {
        e.remove(getComponentByName(name) as ComponentType<any>);
      }
      ctx.emit({
        kind: 'proposal-applied',
        system: full.name,
        entity: e.id,
        writes: Object.keys(verdict.proposal.writes),
        remove: verdict.proposal.remove,
        ...(verdict.proposal.note !== undefined ? { note: verdict.proposal.note } : {}),
      });
    },
  });
  systemCache.set(key, system);
  return system;
}

// ------------------------------------------------------------------ recipe

const EMPTY_RECIPE: RecipeValue = { version: 1, components: [], systems: [], order: [] };

/** The world's recipe entity, spawned on first use (idle only, like any external mutation). */
export function recipeEntity(world: World): EntityView<any> {
  const [existing] = world.query(Recipe);
  if (existing !== undefined) return existing as EntityView<any>;
  // Record the order that already exists: a recipe that only ever declares
  // components must still pin the hand-written systems it was born with, or a
  // fork without them would hydrate "successfully" with zero systems.
  return world.spawn(Recipe({ ...EMPTY_RECIPE, order: world.systems().map((s) => s.key) }));
}

/** Replaces the entry with `item.name` in place, or appends — order is semantics. */
function upsert<T extends { name: string }>(list: T[], item: T): T[] {
  const at = list.findIndex((x) => x.name === item.name);
  if (at === -1) return [...list, item];
  const copy = [...list];
  copy[at] = item;
  return copy;
}

/** The recipe as currently recorded, or an empty one. */
export function readRecipe(world: World): RecipeValue {
  const [entity] = world.query(Recipe);
  return entity === undefined ? EMPTY_RECIPE : (entity.get(Recipe) as RecipeValue);
}

function updateRecipe(world: World, patch: (current: RecipeValue) => RecipeValue): void {
  const handle = recipeEntity(world);
  const current = (handle.get(Recipe) as RecipeValue | undefined) ?? EMPTY_RECIPE;
  handle.set(Recipe, patch(current));
}

/**
 * Refreshes the recorded system order from `world.systems()`. `declareSystem`
 * does this itself; call it after registering hand-written systems LATER than
 * the last declaration, or `hydrateRecipe` will (rightly) refuse the mismatch.
 */
export function recordSystemOrder(world: World): void {
  if (world.query(Recipe).length === 0) return;
  updateRecipe(world, (current) => ({ ...current, order: world.systems().map((s) => s.key) }));
}

/**
 * `componentFromDecl` plus a record in the world's `Recipe`, so a snapshot of
 * this world can be rehydrated elsewhere. Idle only (R16).
 */
export function declareComponent(world: World, decl: ComponentDecl & { tag: true }): TagType;
export function declareComponent(world: World, decl: ComponentDecl): ComponentType<any>;
export function declareComponent(world: World, decl: ComponentDecl): ComponentType<any> {
  const type = componentFromDecl(decl);
  updateRecipe(world, (current) => ({
    ...current,
    components: upsert(current.components, { ...decl }),
    order: world.systems().map((s) => s.key),
  }));
  return type;
}

/**
 * Refuses a declaration whose write/remove targets could collide with another
 * declared prompt system's on the same entity in one step. Two writers of a
 * plain component is a `WriteConflictError` that rejects the whole barrier
 * (R30) — with no `SystemError` for a healer, and after both model calls were
 * paid for. Only concurrent `add`s on a reducer component merge safely.
 */
function checkSharedTargets(decl: FullDecl, others: PromptSystemDecl[]): void {
  for (const other of others) {
    if (other.name === decl.name) continue;
    const otherWrites = new Set(other.writes ?? []);
    const otherRemoves = new Set(other.removes ?? []);
    for (const name of decl.writes) {
      const type = getComponentByName(name);
      if (otherRemoves.has(name) || (otherWrites.has(name) && type?.reducer === undefined)) {
        throw new LangECSError(
          `Prompt system "${decl.name}" and "${other.name}" would both touch "${name}" — as a ` +
            `plain component, or as a write against a remove, that is a WriteConflictError at the ` +
            `barrier (R30), which rejects the whole run after both model calls were paid for. ` +
            `Declare "${name}" with a reducer, or make the targets disjoint.`,
        );
      }
    }
    for (const name of decl.removes) {
      if (otherWrites.has(name)) {
        throw new LangECSError(
          `Prompt system "${decl.name}" removes "${name}" while "${other.name}" writes it — a ` +
            `write against a remove in one step is a WriteConflictError at the barrier (R30).`,
        );
      }
    }
  }
}

/**
 * `systemFromDecl` + `world.use` + a record in the `Recipe` — including the full
 * registration order, because barrier apply order follows it (R25 step 6) and a
 * rehydrated world must reproduce it. Also makes sure the world has a
 * `PromptLedger`. Idle only (R16). The same name with a different declaration
 * throws `DuplicateSystemError` (core has no unregister): version the name.
 */
export function declareSystem(
  world: World,
  decl: PromptSystemDecl,
  policy: AuthoringPolicy = {},
): SystemDef<any> {
  const full = validateSystemDecl(decl, { policy });
  checkSharedTargets(full, readRecipe(world).systems);
  const system = systemFromDecl(decl);
  promptLedger(world);
  world.use(system);
  updateRecipe(world, (current) => ({
    ...current,
    // In place when re-declared: Recipe.systems IS the replay order.
    systems: upsert(current.systems, { ...decl }),
    order: world.systems().map((s) => s.key),
  }));
  return system;
}

export interface HydrateReport {
  components: string[];
  systems: string[];
}

/**
 * Re-declares a snapshot's recorded vocabulary and prompt systems on `world`, so
 * that `world.load(snapshot)` can resolve every name (R36) in a process that
 * never ran the declaring code. Call it AFTER registering the hand-written
 * systems the original world had and BEFORE `load` — or use `forkFromSnapshot`,
 * which sequences all of it into a fresh world.
 *
 * The whole manifest is validated before anything is registered: a bad
 * declaration leaves the registry untouched instead of half-populated (R7 has
 * no undo). Registration order is engine semantics — writes commit in (system
 * index, entity) order (R25 step 6) — so by default the resulting
 * `world.systems()` order must equal the order the recipe recorded, and a
 * mismatch throws: a world hydrated in a different order would replay the same
 * steps into different state. `strict: false` skips that check.
 *
 * Loading an OLDER step into a world that already has later-declared systems
 * does not uninstall them (R36 replaces entities, not registrations); restore
 * into a fresh world when the recipe changed between the two steps.
 */
export function hydrateRecipe(
  world: World,
  snapshot: Snapshot,
  opts?: { strict?: boolean; policy?: AuthoringPolicy },
): HydrateReport {
  const carriers = snapshot.entities.filter((entity) =>
    Object.hasOwn(entity.components, Recipe.componentName),
  );
  if (carriers.length === 0) return { components: [], systems: [] };
  if (carriers.length > 1) {
    throw new LangECSError(
      `Snapshot has ${carriers.length} entities carrying "${Recipe.componentName}"; exactly one is expected.`,
    );
  }
  const recipe = carriers[0]?.components[Recipe.componentName] as RecipeValue;
  if (recipe.version !== 1) {
    throw new LangECSError(
      `Unsupported Recipe version ${String(recipe.version)}; this build reads version 1.`,
    );
  }
  // Validate everything first (no side effects), then register. That includes
  // conflicts WITHIN the manifest: two declarations of one name with different
  // identities would pass a registry-only check, install the first and throw on
  // the second — leaving R7 polluted with no undo.
  const knownNames = new Set(listComponents().map((c) => c.name));
  const manifest = new Map<string, ComponentDecl>();
  for (const decl of recipe.components) {
    validateComponentDecl(decl);
    const earlier = manifest.get(decl.name);
    if (earlier !== undefined && identityOf(earlier) !== identityOf(decl)) {
      throw new LangECSError(
        `Recipe declares component "${decl.name}" twice with different schema, reducer or tag-ness.`,
      );
    }
    manifest.set(decl.name, decl);
    knownNames.add(decl.name);
  }
  // Agent tags come from `defineAgent` in code (the host's `build` step); a
  // recipe cannot conjure one, so an unknown `agent` fails here, before anything
  // registers.
  const systemNames = new Set<string>();
  const declaredNames = new Set([...declared.keys(), ...manifest.keys()]);
  for (const decl of recipe.systems) {
    if (systemNames.has(decl.name)) {
      throw new LangECSError(`Recipe declares prompt system "${decl.name}" twice.`);
    }
    systemNames.add(decl.name);
    // The host policy applies to a stored manifest exactly as to a live install.
    validateSystemDecl(decl, { knownNames, declaredNames, policy: opts?.policy ?? {} });
  }
  if (opts?.strict ?? true) {
    // Predict the resulting registration order and refuse BEFORE mutating.
    const predicted = [...world.systems().map((s) => s.key), ...recipe.systems.map((d) => d.name)];
    const same =
      predicted.length === recipe.order.length && predicted.every((k, i) => k === recipe.order[i]);
    if (!same) {
      throw new LangECSError(
        'System registration order differs from the recipe, and order is barrier semantics ' +
          `(R25 step 6). Recorded: [${recipe.order.join(', ')}]. Would be: [${predicted.join(', ')}]. ` +
          'Register the hand-written systems in the recorded order before hydrateRecipe (or ' +
          'call recordSystemOrder after registering them), or pass { strict: false } to accept ' +
          'a different replay order.',
      );
    }
  }

  const report: HydrateReport = { components: [], systems: [] };
  for (const decl of recipe.components) {
    componentFromDecl(decl);
    report.components.push(decl.name);
  }
  promptLedger(world);
  for (const decl of recipe.systems) {
    world.use(systemFromDecl(decl));
    report.systems.push(decl.name);
  }
  return report;
}

/** Whether a snapshot carries any declared vocabulary or prompt systems. */
export function snapshotHasRecipe(snapshot: Snapshot): boolean {
  return snapshot.entities.some((entity) => {
    if (!Object.hasOwn(entity.components, Recipe.componentName)) return false;
    const recipe = entity.components[Recipe.componentName] as Partial<RecipeValue> | undefined;
    return (recipe?.components?.length ?? 0) > 0 || (recipe?.systems?.length ?? 0) > 0;
  });
}

export interface ForkOptions {
  snapshot: Snapshot;
  /**
   * Registers the hand-written systems and resources the original world had, in
   * the original order — the same "recipe" function the app uses at startup.
   */
  build?: (world: World) => void;
  /** Id for the new world (default: the snapshot's `worldId`). */
  id?: string;
  persistence?: PersistenceAdapter;
  /** Passed to `hydrateRecipe`. */
  strict?: boolean;
  /** Passed to `hydrateRecipe`: the host's authoring policy for the stored manifest. */
  policy?: AuthoringPolicy;
  /**
   * `false` skips `hydrateRecipe`: a host that does not allow authoring must not
   * compile declarations merely because a checkpoint stores them (`load` then
   * fails on their names, loudly). Default `true`.
   */
  hydrate?: boolean;
  recursionLimit?: number;
  systemTimeoutMs?: number;
}

/**
 * The recommended restore path: compiles a snapshot into a FRESH world —
 * `createWorld` → `build` (hand-written systems and resources) →
 * `hydrateRecipe` → strict `load`. Nothing from any previous timeline is
 * installed, which is what in-place `load` cannot promise for systems.
 */
export function forkFromSnapshot(opts: ForkOptions): World {
  const world = createWorld({
    id: opts.id ?? opts.snapshot.worldId,
    ...(opts.persistence !== undefined ? { persistence: opts.persistence } : {}),
    ...(opts.snapshot.recipeVersion !== undefined
      ? { recipeVersion: opts.snapshot.recipeVersion }
      : {}),
    ...(opts.recursionLimit !== undefined ? { recursionLimit: opts.recursionLimit } : {}),
    ...(opts.systemTimeoutMs !== undefined ? { systemTimeoutMs: opts.systemTimeoutMs } : {}),
  });
  opts.build?.(world);
  if (opts.hydrate !== false) {
    hydrateRecipe(world, opts.snapshot, {
      ...(opts.strict === undefined ? {} : { strict: opts.strict }),
      ...(opts.policy === undefined ? {} : { policy: opts.policy }),
    });
  }
  world.load(opts.snapshot);
  return world;
}
