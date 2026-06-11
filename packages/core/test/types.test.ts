import { expect, expectTypeOf, test } from 'vitest';
import {
  createWorld,
  defineAgent,
  defineComponent,
  defineSystem,
  defineTag,
  type Msg,
  Not,
  type TagType,
} from '../src/index';

// The SPEC §9 snippet, verbatim shapes — must compile with exactly these inferred types (R39).
const Messages = defineComponent<Msg[]>({ name: 'messages', reducer: (a, b) => [...a, ...b] });
const ModelRef = defineComponent<string>({ name: 'modelRef' });
const Busy = defineTag('busy');

test('T22 R39: e.get is non-nullable for positive terms, optional otherwise; values typed', () => {
  const callLLM = defineSystem({
    name: 'callLLM',
    query: [Messages, ModelRef, Not(Busy)],
    when: (e) => {
      expectTypeOf(e.get(Messages)).toEqualTypeOf<Msg[]>(); // non-nullable
      return e.get(Messages).length > 0;
    },
    run: async (e, _ctx) => {
      const m: string = e.get(ModelRef); // string (non-nullable: positive term)
      expectTypeOf(m).toEqualTypeOf<string>();
      expectTypeOf(e.get(Messages)).toEqualTypeOf<Msg[]>();
      e.add(Messages, [{ role: 'assistant', content: 'hi' }]); // value type-checked as Msg[]
      const other = e.get(Busy); // true | undefined (not a positive term)
      expectTypeOf(other).toEqualTypeOf<true | undefined>();

      // @ts-expect-error add value must be Msg[]
      e.add(Messages, 'wrong');
      // @ts-expect-error non-tag components require a value
      e.add(ModelRef);
      // @ts-expect-error set value must be string
      e.set(ModelRef, 42);
      e.add(Busy); // tags need no value
    },
  });
  expect(callLLM.name).toBe('callLLM');
});

test('T22 ctx and world query inference', () => {
  defineSystem({
    name: 'ctxTypes',
    query: [Messages],
    run: (e, ctx) => {
      expectTypeOf(ctx.step).toEqualTypeOf<number>();
      const views = ctx.world.query(Messages, ModelRef, Not(Busy));
      const view = views[0];
      if (view) {
        expectTypeOf(view.get(Messages)).toEqualTypeOf<Msg[]>();
        expectTypeOf(view.get(ModelRef)).toEqualTypeOf<string>();
        expectTypeOf(view.get(Busy)).toEqualTypeOf<true | undefined>();
      }
      expectTypeOf(e.get(ModelRef)).toEqualTypeOf<string | undefined>(); // not in this query
      const resource = ctx.resource<{ generate(): string }>('model');
      expectTypeOf(resource.generate()).toEqualTypeOf<string>();
    },
  });

  const world = createWorld();
  const handles = world.query(Messages, Not(Busy));
  const handle = handles[0];
  if (handle) {
    expectTypeOf(handle.get(Messages)).toEqualTypeOf<Msg[]>();
    expectTypeOf(handle.get(ModelRef)).toEqualTypeOf<string | undefined>();
  }
  const spawned = world.spawn(Messages([]), ModelRef('model:main'));
  expectTypeOf(spawned.id).toEqualTypeOf<number>();
  expectTypeOf(spawned.get(ModelRef)).toEqualTypeOf<string | undefined>();
});

test('T22 R39: tags are name-branded — distinct tags are not interchangeable', () => {
  const Done = defineTag('done');

  expectTypeOf(Busy).toEqualTypeOf<TagType<'busy'>>();
  expectTypeOf(Busy.componentName).toEqualTypeOf<'busy'>();
  expectTypeOf(Busy).not.toEqualTypeOf(Done);
  // @ts-expect-error distinct tags are distinct types ('done' is not 'busy')
  const _wrong: typeof Busy = Done;
  // Both still widen to the unbranded TagType (= TagType<string>).
  const _widened: TagType = Done;
  expect(_wrong).toBe(_widened);

  const sys = defineSystem({
    name: 'tagBrand',
    query: [Messages, Busy],
    run: (e) => {
      expectTypeOf(e.get(Busy)).toEqualTypeOf<true>(); // positive term
      // Done was never queried: with name branding it no longer collides with
      // Busy, so get() correctly stays optional.
      expectTypeOf(e.get(Done)).toEqualTypeOf<true | undefined>();
    },
  });
  expect(sys.name).toBe('tagBrand');

  // Agent auto-tags carry the brand too: two agents' tags are distinct types.
  const AgentA = defineAgent({ name: 'typesAgentA' });
  const AgentB = defineAgent({ name: 'typesAgentB' });
  expectTypeOf(AgentA.tag).toEqualTypeOf<TagType<'agent:typesAgentA'>>();
  expectTypeOf(AgentA.tag).not.toEqualTypeOf(AgentB.tag);
  // @ts-expect-error agent auto-tags are not interchangeable
  const _wrongTag: typeof AgentA.tag = AgentB.tag;
  expect(_wrongTag.componentName).toBe('agent:typesAgentB');

  // Documented caveat (see EntityReadView.get): defineComponent keeps the
  // explicit-T call style, so same-shaped components remain interchangeable —
  // SystemPrompt structurally equals ModelRef (both ComponentType<string>).
  const SystemPrompt = defineComponent<string>({ name: 'typesSystemPrompt' });
  expectTypeOf(SystemPrompt).toEqualTypeOf(ModelRef);
});
