// @langecs/devtools — visual inspector server for LangECS worlds.
// `startDevtools(world)` hosts the UI, a `/ws` protocol socket, and an
// OTLP/HTTP JSON trace receiver, all on one port.

export { decodeOtlpTraces } from './otlp';
// The whole wire contract (PROTOCOL_VERSION + every message/state type) is
// re-exported so the UI and tests can import it from the package root.
export * from './protocol';
export { type DevtoolsOptions, type DevtoolsServer, startDevtools } from './server';
export { buildWorldState } from './state';
