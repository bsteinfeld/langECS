// Ambient platform declarations for the abort primitives (R49).
//
// `@langecs/core` compiles with `lib: ["ES2022"]` and `types: []` on purpose
// (R1): nothing DOM-only or Node-only can leak into an isomorphic package by
// accident. `AbortController`/`AbortSignal` are WHATWG standards present in
// every runtime core targets — Node >= 20, browsers, workers, Deno, Bun — but
// they are declared in the DOM and Node type libraries, either of which would
// drag in far more surface than core is allowed to see (`document`, `process`).
//
// So the exact surface core uses is declared here instead. Deliberately
// minimal: adding a member means core depends on it. Consumers compile against
// their own platform's fuller declaration, which this is compatible with.
//
// **Include this file only in programs that do NOT have `@types/node`.** An
// ambient file is not reachable through the import graph, so the sibling
// packages that compile core's *source* under `types: []` (`stdlib`,
// `langchain`, `otel`) name it in their tsconfig `include`. Packages that do
// have node types (`ai-sdk`, `devtools`, `persist-fs`, `examples`) must not —
// two `declare const AbortController`s in one program is a redeclaration error.
// Core's runtime code still reaches the constructors through `globalThis` (see
// `cancel.ts`), the way it reaches `performance` and `setTimeout`, so the value
// declarations below serve type-checking only.

interface AbortSignal {
  readonly aborted: boolean;
  /** Populated by `controller.abort(reason)`; an `AbortError` when unspecified. */
  readonly reason?: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean } | boolean,
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare const AbortController: {
  prototype: AbortController;
  new (): AbortController;
};

declare const AbortSignal: {
  prototype: AbortSignal;
  /** ES2024-era addition; `anySignal` feature-detects it and falls back (R51). */
  any?(signals: AbortSignal[]): AbortSignal;
};
