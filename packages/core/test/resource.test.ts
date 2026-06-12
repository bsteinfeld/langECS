import { expect, expectTypeOf, test } from 'vitest';
import {
  createWorld,
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  MissingResourceError,
  type ResourceRef,
  SystemError,
} from '../src/index';

// Typed resource references (R18 amended): refs are typed names — no global
// registry, no uniqueness rule — sharing the string-keyed slot of R18.

interface Greeter {
  greet(name: string): string;
}

test('typed roundtrip: register via ref, read via ref, T inferred without manual generics', async () => {
  const Input = defineComponent<string>({ name: 'resT:input' });
  const Output = defineComponent<string>({ name: 'resT:output' });
  const MainGreeter = defineResource<Greeter>('greeter:main');
  expectTypeOf(MainGreeter).toEqualTypeOf<ResourceRef<Greeter>>();

  const world = createWorld();
  world.register(MainGreeter, { greet: (name) => `hello ${name}` });
  // The register value is pinned to the ref's T:
  // @ts-expect-error a Greeter resource cannot be registered as a number
  const reject = () => world.register(MainGreeter, 42);
  void reject;

  let guardSaw: Greeter | undefined;
  world.use(
    defineSystem({
      name: 'resT:greet',
      query: [Input],
      when: (_e, ctx) => {
        // GuardCtx.resource accepts refs too (R18 amended via R21's GuardCtx).
        guardSaw = ctx.resource(MainGreeter);
        return true;
      },
      run: (e, ctx) => {
        const greeter = ctx.resource(MainGreeter);
        expectTypeOf(greeter).toEqualTypeOf<Greeter>(); // inferred from the ref
        e.set(Output, greeter.greet(e.get(Input)));
      },
    }),
  );
  const e = world.spawn(Input('world'));
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(e.get(Output)).toBe('hello world');
  expect(guardSaw?.greet('x')).toBe('hello x');
});

test('string and ref forms interoperate: same name = same slot', async () => {
  const Probe = defineTag('resT:probe');
  const Answer = defineResource<number>('resT:answer');

  const world = createWorld();
  const seen: { viaRef?: number; viaString?: number } = {};
  world.use(
    defineSystem({
      name: 'resT:read',
      query: [Probe],
      run: (_e, ctx) => {
        seen.viaRef = ctx.resource(Answer);
        seen.viaString = ctx.resource<number>('resT:answer');
      },
    }),
  );
  const e = world.spawn(Probe());

  // Registered by string, readable through the ref (and the string).
  world.register('resT:answer', 42);
  await world.run();
  expect(seen).toEqual({ viaRef: 42, viaString: 42 });

  // Re-registered through the ref, the string form sees the same slot.
  world.register(Answer, 43);
  await world.send(e, Probe());
  expect(seen).toEqual({ viaRef: 43, viaString: 43 });
});

test('MissingResourceError still names the resource for ref lookups', async () => {
  const Poke = defineTag('resT:poke');
  const Nope = defineResource<string>('resT:nope');

  const world = createWorld();
  world.use(
    defineSystem({
      name: 'resT:miss',
      query: [Poke],
      run: (_e, ctx) => {
        ctx.resource(Nope);
      },
    }),
  );
  const e = world.spawn(Poke());
  const result = await world.run();
  expect(result.status).toBe('error');
  const record = e.get(SystemError)?.[0];
  expect(record?.error.name).toBe(new MissingResourceError('x').name);
  expect(record?.error.message).toContain('"resT:nope"'); // message unchanged: uses the name
});
