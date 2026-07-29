// Typed custom events (R60), mirroring `defineResource`'s ergonomics.
//
// `ctx.emit(data: unknown)` is the engine's only channel for domain-meaningful
// events (R23), and untyped it forces every consumer — devtools, @langecs/otel,
// an app's own UI — to receive `unknown` and cast, then parse everything just to
// find out whether it cares.

/** Brand so an `EventRef` is never confused with a payload that happens to have `eventName`. */
const EVENT_REF = Symbol.for('langecs.eventRef');

/**
 * A typed reference to a custom event (R60): a name plus the payload type,
 * carried at the type level only. Like `ResourceRef`, there is no registry and no
 * uniqueness rule — a ref is just a branded name.
 */
export interface EventRef<T> {
  /** The event name, surfaced as `RunEvent.custom.name` so observers can filter. */
  readonly eventName: string;
  /** @internal */
  readonly [EVENT_REF]: true;
  /**
   * Phantom type carrier; never present at runtime. Exists only so `T` is
   * inferable at the `ctx.emit(ref, payload)` call site.
   * @internal
   */
  readonly __payload?: T;
}

/**
 * Creates a typed event reference (R60).
 *
 * Before (untyped; every consumer casts, and observers must parse everything to
 * find the events they care about):
 * ```ts
 * ctx.emit({ kind: 'token', text })
 * // observer: onEvent(e) { if (e.type === 'custom') { const d = e.data as any; if (d.kind === 'token') … } }
 * ```
 *
 * After (typed name; payload checked at the call site, event filterable by name):
 * ```ts
 * const Token = defineEvent<{ text: string }>('token')
 * ctx.emit(Token, { text })
 * // observer: onEvent(e) { if (e.type === 'custom' && e.name === 'token') … }
 * ```
 *
 * The plain `ctx.emit(data)` form still works unchanged; a typed emit simply also
 * carries `name`.
 */
export function defineEvent<T>(name: string): EventRef<T> {
  return { eventName: name, [EVENT_REF]: true };
}

/** Whether a value is an `EventRef` (R60) — brand check, never structural. */
export function isEventRef(value: unknown): value is EventRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [EVENT_REF]?: unknown })[EVENT_REF] === true
  );
}
