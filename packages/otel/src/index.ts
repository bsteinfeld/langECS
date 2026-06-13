// @langecs/otel — OpenTelemetry instrumentation for LangECS.
//
// An instrumentation *library* in the OTel sense: the only runtime dependency
// is `@opentelemetry/api` (peer). It never sets up providers, exporters, or
// context managers — the host application owns those (NodeSDK,
// NodeTracerProvider, …); with nothing configured, every call is a no-op.
//
// - `instrumentWorld(world)` — run/step/system spans from `world.observe`
//   (SPEC §14), engine metrics, and auto-wrapping of models/tools registered
//   after instrumentation.
// - `instrumentModel(model)` — GenAI `chat {model}` CLIENT spans with token
//   usage; message content capture is opt-in
//   (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`).
// - `instrumentTool(tool)` — GenAI `execute_tool {name}` spans.

export { type InstrumentModelOptions, instrumentModel } from './instrument-model';
export { type InstrumentToolOptions, instrumentTool } from './instrument-tool';
export { type InstrumentWorldOptions, instrumentWorld } from './instrument-world';
export * from './semconv';
