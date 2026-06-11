// Tool definitions and registration helpers (SPEC §13).
// A ToolDef carries behavior (`execute`), so it lives in world resources —
// never in components. Components reference tools by name (the `Tools` list).

import type { GuardCtx, ToolSpec, World } from '@langecs/core';

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. */
  parameters?: Record<string, unknown>;
  /** When true, `toolApproval` interrupts the run before this tool executes. */
  needsApproval?: boolean;
  execute: (args: unknown) => unknown | Promise<unknown>;
}

/** Identity helper for typing/DX symmetry with `defineComponent`/`defineSystem`. */
export function defineTool(def: ToolDef): ToolDef {
  return def;
}

/** Resource name a tool registers under: `tool:<name>` (idempotent on prefixed input). */
export function toolResourceName(name: string): string {
  return name.startsWith('tool:') ? name : `tool:${name}`;
}

/** Bare tool name as the model sees it (strips a `tool:` prefix if present). */
export function bareToolName(name: string): string {
  return name.startsWith('tool:') ? name.slice('tool:'.length) : name;
}

/** Registers each tool as a world resource under `tool:<name>`. */
export function registerTools(world: World, tools: ToolDef[]): void {
  for (const tool of tools) world.register(toolResourceName(tool.name), tool);
}

/** The model-facing spec of a tool (name/description/parameters only). */
export function toToolSpec(tool: ToolDef): ToolSpec {
  const spec: ToolSpec = { name: bareToolName(tool.name) };
  if (tool.description !== undefined) spec.description = tool.description;
  if (tool.parameters !== undefined) spec.parameters = tool.parameters;
  return spec;
}

/**
 * Resolves a tool resource by (possibly prefixed) name; `undefined` when
 * unregistered. Accepts the restricted `GuardCtx` so `when` guards (which no
 * longer receive the full mutator `SystemCtx`, R21 amended) can use it too.
 */
export function lookupTool(ctx: GuardCtx, name: string): ToolDef | undefined {
  try {
    return ctx.resource<ToolDef>(toolResourceName(name));
  } catch {
    return undefined;
  }
}
