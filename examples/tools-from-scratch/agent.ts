// The LLM-tools loop built BY HAND — the machinery reactAgent normally hides.
//
// Three local components and two systems are the WHOLE agent. There is no
// loop construct anywhere in this file: the think -> act -> think cycle
// emerges from the engine's dirty-trigger rules (SPEC R26/R27). main.ts and
// the test spawn this exact agent; only the registered model differs.

import {
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  type EntityHandle,
  type Model,
  type Msg,
  type ToolSpec,
  type World,
} from '@langecs/core';

// ---------------------------------------------------------------- components

/** The transcript. Append reducer: every writer's messages merge in barrier order. */
export const Convo = defineComponent<Msg[]>({ name: 'Convo', reducer: (a, b) => [...a, ...b] });

/** Raised while the conversation owes the user an answer; think matches on it. */
export const NeedsReply = defineTag('NeedsReply');

/** A tool call the model requested that nobody has executed yet. */
export type PendingCall = { id: string; name: string; args: unknown };

/** Pending calls. Plain component (no reducer): think is the single writer (R30). */
export const ToolQueue = defineComponent<PendingCall[]>({ name: 'ToolQueue' });

/** Typed slot the chat model is registered under — no stringly-typed hops (R18). */
export const ChatModel = defineResource<Model>('model:chat');

// --------------------------------------------------------------------- tools
// A "tool" is nothing special to the engine: a ToolSpec the model sees, plus a
// plain function the act system calls when its name shows up in ToolQueue.
// stdlib's defineTool/registerTools wrap exactly this pairing.

/** `number (+|-|*|/ number)*` with the usual precedence. No eval, no parens. */
export function calculate(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[-+*/]/g) ?? [];
  const head = tokens[0];
  if (head === undefined || tokens.length % 2 === 0) {
    throw new Error(`calculator: cannot parse "${expression}"`);
  }
  // One pass folds * and / into the running term (precedence); + and - bank
  // the finished term with its sign and start a new one.
  const terms: number[] = [Number(head)];
  const signs: number[] = [1];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const value = Number(tokens[i + 1] ?? Number.NaN);
    if (op === undefined || Number.isNaN(value)) {
      throw new Error(`calculator: cannot parse "${expression}"`);
    }
    if (op === '*' || op === '/') {
      const top = terms[terms.length - 1] ?? Number.NaN;
      terms[terms.length - 1] = op === '*' ? top * value : top / value;
    } else {
      signs.push(op === '+' ? 1 : -1);
      terms.push(value);
    }
  }
  return terms.reduce((sum, term, i) => sum + (signs[i] ?? 1) * term, 0);
}

const FACTORS: Record<string, number> = {
  'miles->kilometers': 1.609344,
  'kilometers->miles': 1 / 1.609344,
  'feet->meters': 0.3048,
  'meters->feet': 1 / 0.3048,
  'pounds->kilograms': 0.45359237,
  'kilograms->pounds': 1 / 0.45359237,
};

export function convertUnits(value: number, from: string, to: string): number {
  const factor = FACTORS[`${from}->${to}`];
  if (factor === undefined) {
    throw new Error(
      `convert_units: no conversion ${from} -> ${to} (supported: ${Object.keys(FACTORS).join(', ')})`,
    );
  }
  return value * factor;
}

const UNITS = ['miles', 'kilometers', 'feet', 'meters', 'pounds', 'kilograms'];

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'calculator',
    description: 'Evaluate arithmetic with + - * / (no parentheses), e.g. "42.16 * 4".',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "42.16 * 4"' } },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'convert_units',
    description: 'Convert a value between units of length or mass.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number' },
        from: { type: 'string', enum: UNITS },
        to: { type: 'string', enum: UNITS },
      },
      required: ['value', 'from', 'to'],
      additionalProperties: false,
    },
  },
];

function runTool(call: PendingCall): string {
  const args = call.args as Record<string, unknown>;
  try {
    switch (call.name) {
      case 'calculator':
        return String(calculate(String(args.expression ?? '')));
      case 'convert_units': {
        const result = convertUnits(Number(args.value), String(args.from), String(args.to));
        return `${String(args.value)} ${String(args.from)} = ${result} ${String(args.to)}`;
      }
      default:
        return `Error: unknown tool "${call.name}"`;
    }
  } catch (err) {
    // Failures go back as message content so the model can read and recover.
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ------------------------------------------------------------------- systems

const SYSTEM_PROMPT =
  'You are a careful math assistant. Never compute or convert anything yourself: use the ' +
  'convert_units tool for unit conversions and the calculator tool for arithmetic, one tool ' +
  'call at a time, feeding each result into the next call. When the tools have given you ' +
  'everything you need, reply with one short sentence.';

/** think: call the model whenever an answer is owed (NeedsReply present). */
export const think = defineSystem({
  name: 'think',
  query: [Convo, NeedsReply],
  run: async (e, ctx) => {
    const model = ctx.resource(ChatModel);
    const { message } = await model.generate({
      messages: e.get(Convo),
      system: SYSTEM_PROMPT,
      tools: TOOL_SPECS,
    });
    // Appending our own reply can NOT re-fire think: a pair's own writes are
    // excluded from its dirt (R26.1), so the cycle never runs away on itself.
    e.add(Convo, [message]);
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      // ToolQueue newly matches act's query — that is the entire "edge" from
      // think to act: act fires next step because this data now exists.
      e.set(ToolQueue, message.toolCalls);
    } else {
      // A plain answer settles the debt. Without NeedsReply, think no longer
      // matches; nothing else is dirty, so the world quiesces and send() resolves.
      e.remove(NeedsReply);
    }
  },
});

/** act: execute every queued call and report results into the transcript. */
export const act = defineSystem({
  name: 'act',
  query: [ToolQueue],
  run: (e) => {
    const results: Msg[] = e.get(ToolQueue).map((call) => ({
      role: 'tool',
      content: runTool(call),
      toolCallId: call.id,
      name: call.name,
    }));
    // This Convo append is a FOREIGN write from think's point of view — it is
    // exactly what marks (think, entity) dirty again (R27) and re-fires the
    // model with tool results in context. Self-writes never retrigger;
    // foreign writes do. The whole loop is this two-system cycle.
    e.add(Convo, results);
    // Consuming the queue unmatches act until think requests more tools.
    e.remove(ToolQueue);
  },
});

/** Registers both systems and spawns the conversation entity. */
export function spawnMathAgent(world: World): EntityHandle {
  world.use(think);
  world.use(act);
  return world.spawn(Convo([]));
}
