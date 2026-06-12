# Hello, LangECS — a chat agent from raw parts

The smallest possible LangECS agent: one component, one tag, one system, one
agent bundle, two sends. No tools, no stdlib, no event handling — `main.ts` is
the whole program, and it reads top to bottom.

## What it teaches

1. **Component = state.** All of the agent's memory is data on an entity.
2. **System = logic that fires when its query newly matches.** No edges, no
   router — the trigger is the data changing.
3. **Quiescence = done.** A run ends when no system has anything left to do,
   not when something returns.

## Walking the file

**State.** `Chat` is a component holding the transcript (`Msg[]`). Its
`reducer` turns `add` into *append*: when anyone adds messages, they merge
into the existing history instead of replacing it. `WaitingReply` is a tag — a
value-less component whose mere presence means "the last word is the user's;
someone owes a reply". `ChatModel` is a typed resource reference
(`defineResource<Model>`), so registering and looking up the model is
type-checked instead of stringly-typed.

**Logic.** `respond` is the only system. Its query is `[Chat, WaitingReply]`:
it fires for any entity that has *both* — and the engine schedules it exactly
when that query **newly matches** (or its components change under it). The body
calls the model with the transcript, appends the reply, and removes the tag.
Two scheduling rules make this terminate cleanly:

- the `Chat` append is a *self-write*, which never re-triggers the writing
  system — so appending the reply doesn't cause an infinite loop;
- removing `WaitingReply` un-matches the query, so nothing is scheduled next
  step. A world with nothing scheduled is **quiescent**, and that is what ends
  the run.

**Bundle.** `defineAgent` packages the starting components (`Chat([])`) with
the system, so `world.spawn(greeter)` creates a ready-to-chat entity.

**Run.** `world.send(agent, Chat([userMsg]), WaitingReply())` adds the user
message and raises the tag, then runs the world until quiescence. Awaiting it
gives you the finished state; the reply is just `agent.get(Chat).at(-1)`.

**The second send is the punchline.** Same entity, same components — the
transcript is still there, so the model sees the whole history and can answer
"What's my name?". Conversation memory isn't a feature; it's just state that
never went anywhere.

## Choreography of one send

```
external: add Chat([user msg]) + WaitingReply   -> respond newly matches
step 1:   respond runs — append assistant msg, remove WaitingReply
          (self-write doesn't re-trigger; tag removal un-matches)
quiescent -> run resolves 'done'
```

## Run it

```sh
pnpm install                                    # repo root, once
pnpm -C examples hello-world                    # live (OPENAI_API_KEY in <repo-root>/.env.local)
pnpm -C examples hello-world -- --trace         # same, plus the flight recorder
pnpm -C examples exec vitest run hello-world    # deterministic test, no network
```
