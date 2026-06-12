# Tools from scratch

The LLM-tools loop built by hand, so `reactAgent` stops being magic. Three
local components (`Convo`, `NeedsReply`, `ToolQueue`), two systems (`think`,
`act`), two inline tools (a calculator and a unit converter) — and no loop
construct anywhere. The agent answers a question that needs both tools
*chained*: convert miles to kilometers, then multiply the result.

## The cycle

```
        world.send(agent, Convo([user msg]), NeedsReply())
                            |
                            v
              +---------------------------+
              |           think           |
              |   query: [Convo,          |
              |           NeedsReply]     |
              +---------------------------+
                |                       |
   reply has toolCalls:                 |  plain-text reply:
   set ToolQueue                        |  remove NeedsReply
   (newly matches act ----+            |  -> think unmatches,
    -> act fires next step)|            |     nothing dirty,
                            v            |     world QUIESCES,
              +---------------------------+   await send() resolves
              |            act            |
              |   query: [ToolQueue]      |
              +---------------------------+
                |
                |  run each call, append tool Msgs to Convo,
                |  remove ToolQueue (act unmatches itself)
                |
                +--> Convo changed by a FOREIGN writer
                     -> (think, entity) is dirty again
                     -> think re-fires with results in context
```

Two writes to the same `Convo` component, two very different outcomes:

- `think` appends its own reply — **self-writes never retrigger** the writing
  pair, so `think` does not re-fire itself (SPEC R26.1).
- `act` appends tool results — a **foreign write** to a component in `think`'s
  query, which is exactly what marks `think` dirty again (R27).

The loop *is* this two-system cycle. There is no edge list, no `while`, no
router: control flow is data appearing and disappearing on the entity.

## What it teaches

1. **Dirty-triggering as control flow** — `set ToolQueue` is the think->act
   edge; the foreign `Convo` append is the act->think edge; `remove NeedsReply`
   is the exit condition.
2. **Self-write exclusion** — why an agent that appends to its own transcript
   every step does not loop forever.
3. **Typed resources** — `defineResource<Model>('model:chat')` gives the model
   slot a type; `ctx.resource(ChatModel)` needs no manual generic.

## This is what stdlib packages for you

`think` is stdlib's `callLLM` (plus streaming, system-prompt and tool-spec
components); `act` is `executeTools` (plus human approval and error-to-message
handling); `Convo`/`NeedsReply`/`ToolQueue` are `Messages`/`MessageWaiting`/
`PendingToolCalls`. The `reactAgent` preset wires them all:

```ts
import { ask, defineTool, reactAgent, registerTools } from '@langecs/stdlib';

registerTools(world, [calculatorTool, convertTool]); // defineTool(...) each
const agent = world.spawn(
  reactAgent({ name: 'mathbot', model: 'model:chat', tools: [calculatorTool, convertTool] }),
);
const answer = await ask(world, agent, question);
```

Same components, same two-system cycle, same trace shape — see the
[react-agent example](../react-agent/) for that version running.

## Run it

```sh
pnpm -C examples tools-from-scratch          # needs OPENAI_API_KEY in .env.local
pnpm -C examples tools-from-scratch --trace  # plus the flight recorder dump

pnpm -C examples exec vitest run tools-from-scratch   # deterministic test, no network
```

The test scripts the model (two tool-call turns, then an answer) and asserts
the exact `think -> act -> think -> act -> think` step sequence from
`world.getTrace()`.
