// Writer<->critic reflection on a shared blackboard entity — the ECS port of
// the LangGraph.js "reflection" example (essay generator + grader).
//
// There is no router and there are no edges. Both systems query the same
// [Messages, Reflecting] blackboard:
//
//   - `writer` appends a draft. Its own append is self-write-excluded (R26),
//     so only `critic` wakes at the next step. `critic` appends a critique;
//     that foreign append wakes `writer`. The alternation IS the engine's
//     dirty-tracking — nobody routes.
//   - After `MaxCritiques` critique rounds the critic approves and removes the
//     `Reflecting` tag. Both queries unmatch and the world quiesces: the loop
//     ends by component removal, not by a conditional edge.
//
// Who said what is tracked in `Msg.meta.author`; the transcript itself
// accumulates through the stdlib `Messages` append reducer.

import {
  type AgentDef,
  type ComponentType,
  defineAgent,
  defineComponent,
  defineSystem,
  defineTag,
  type Model,
  type ModelRequest,
  type Msg,
  type SystemCtx,
  type TagType,
} from '@langecs/core';
import { Messages } from '@langecs/stdlib';

/** Present while the reflection loop is live; the critic removes it to end the loop. */
export const Reflecting: TagType = defineTag('reflection:Reflecting');

/** How many critique rounds the critic delivers before approving. Pure data: override at spawn. */
export const MaxCritiques: ComponentType<number> = defineComponent<number>({
  name: 'reflection:MaxCritiques',
});

export type Author = 'user' | 'writer' | 'critic';

/** Who wrote a transcript message (the opening task has no author meta). */
export const authorOf = (msg: Msg): Author => (msg.meta?.author as Author | undefined) ?? 'user';

/** Resource name the shared `Model` is registered under. */
export const MODEL_RESOURCE = 'model:essay';

export const WRITER_PROMPT =
  'You are an essay assistant tasked with writing excellent three-paragraph essays. ' +
  "Generate the best essay possible for the user's request. " +
  'If the user provides critique, respond with a revised version of your previous attempts.';

export const CRITIC_PROMPT =
  'You are a teacher grading an essay submission. ' +
  "Generate critique and recommendations for the user's submission. " +
  'Provide detailed recommendations, including requests for length, depth, and style.';

export const APPROVAL = 'This revision meets the bar. Approved — ship it.';

/** Calls the shared model, streaming tokens to the live event stream when supported (R23). */
async function callModel(ctx: SystemCtx, author: Author, req: ModelRequest): Promise<Msg> {
  const model = ctx.resource<Model>(MODEL_RESOURCE);
  const result = model.stream
    ? await model.stream(req, (chunk) => {
        if (chunk.text !== undefined && chunk.text.length > 0) {
          ctx.emit({ kind: 'token', author, text: chunk.text });
        }
      })
    : await model.generate(req);
  return result.message;
}

/**
 * Drafts on the opening task and revises on every critique. The transcript is
 * already stored from the writer's perspective (drafts `assistant`, task and
 * critiques `user`), so it goes to the model as-is.
 */
export const writer = defineSystem({
  name: 'writer',
  query: [Messages, Reflecting],
  when: (e) => {
    const last = e.get(Messages).at(-1);
    return last !== undefined && authorOf(last) !== 'writer';
  },
  run: async (e, ctx) => {
    const reply = await callModel(ctx, 'writer', {
      messages: e.get(Messages),
      system: WRITER_PROMPT,
    });
    e.add(Messages, [{ role: 'assistant', content: reply.content, meta: { author: 'writer' } }]);
  },
});

/**
 * Reviews every fresh draft. Delivers `MaxCritiques` critique rounds, then
 * approves and removes `Reflecting` — ending the loop by unmatching both
 * systems (no model call needed for the verdict; the stop rule is code+data,
 * exactly like LangGraph's `shouldContinue`).
 */
export const critic = defineSystem({
  name: 'critic',
  query: [Messages, Reflecting, MaxCritiques],
  when: (e) => {
    const last = e.get(Messages).at(-1);
    return last !== undefined && authorOf(last) === 'writer';
  },
  run: async (e, ctx) => {
    const transcript = e.get(Messages);
    const delivered = transcript.filter((m) => authorOf(m) === 'critic').length;

    if (delivered >= e.get(MaxCritiques)) {
      e.add(Messages, [
        { role: 'user', content: APPROVAL, meta: { author: 'critic', approved: true } },
      ]);
      e.remove(Reflecting); // <- the loop's END: both queries unmatch, world quiesces
      return;
    }

    // The critic grades a "submission": flip perspectives so drafts read as
    // user input and its earlier critiques as its own assistant turns — the
    // same role flip as the LangGraph original's `clsMap`.
    const flipped = transcript.map((m): Msg => {
      const author = authorOf(m);
      if (author === 'writer') return { role: 'user', content: m.content };
      if (author === 'critic') return { role: 'assistant', content: m.content };
      return m;
    });
    const reply = await callModel(ctx, 'critic', { messages: flipped, system: CRITIC_PROMPT });
    e.add(Messages, [{ role: 'user', content: reply.content, meta: { author: 'critic' } }]);
  },
});

/**
 * One spawnable blackboard entity carrying the transcript, the loop marker,
 * the round budget, and both scoped systems (`reflection:writer`,
 * `reflection:critic`). Override the budget per spawn:
 * `world.spawn(reflection, MaxCritiques(1))`.
 */
export const reflection: AgentDef = defineAgent({
  name: 'reflection',
  components: [Messages([]), Reflecting(), MaxCritiques(2)],
  systems: [writer, critic],
});
