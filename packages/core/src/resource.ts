// Typed resource references (R18 amended): a resource name that carries the
// resource's type. Purely a type-level affordance — no global registry, no
// uniqueness rule, and at runtime a ref is nothing but `{ resourceName }`.

/**
 * A typed reference to a world resource (R18 amended): the resource name plus
 * the resource's type `T`, carried at the type level only. A ref and its
 * `resourceName` string address the **same slot** — `world.register(ref, v)`
 * and `world.register(ref.resourceName, v)` are interchangeable.
 */
export interface ResourceRef<T> {
  /** The resource name — the string key of `world.register`/`ctx.resource` (R18). */
  readonly resourceName: string;
  /**
   * Phantom type carrier; never present at runtime. Exists only so `T` is
   * inferable by `world.register(ref, value)` and `ctx.resource(ref)`.
   * @internal
   */
  readonly __type?: T;
}

/**
 * Creates a typed resource reference (R18 amended) — kills the stringly-typed
 * resource hop without changing the runtime model.
 *
 * Before (stringly typed; `T` asserted at every call site):
 * ```ts
 * world.register('model:main', client);
 * const model = ctx.resource<Model>('model:main');
 * ```
 *
 * After (typed name; `T` inferred, register value type-checked):
 * ```ts
 * const MainModel = defineResource<Model>('model:main');
 * world.register(MainModel, client);   // value must be a Model
 * const model = ctx.resource(MainModel); // Model — no manual generic
 * ```
 *
 * No global registry and no uniqueness rule: two refs with the same name are
 * the same slot, and either interoperates with the plain string form.
 */
export function defineResource<T>(name: string): ResourceRef<T> {
  return { resourceName: name };
}
