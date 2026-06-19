# Tour — LangECS Easy Mode

A single offline world plus the DevTools inspector, landing on a guided **📖 Learn**
tab. No API key, no network.

```sh
pnpm -C examples tour
```

Open the printed URL. The inspector starts on the **Learn** tab — step through it with
**"Show me ▶"**, which jumps to the right tab and highlights what each step describes.

## What it seeds

| Exhibit | Teaches | Where to look |
|---------|---------|---------------|
| `greeter` agent | entities, components, tags, systems, queries, quiescence | Inspector → `Chat`, `WaitingReply`; Systems → `respond` |
| `support` agent | versioned, injection-safe prompt registry | Inspector → `PromptRef`, `RenderedPrompt` |
| eval case | scorer → score → verdict | Inspector → `eval:Score`, `eval:Verdict` |
| bench report | comparing models (pass-rate, latency, tokens, cost) | Inspector → `bench:ComparisonReport` |

> **Note:** The bench comparison numbers are canned/illustrative — copied from a real `bench-devtools-demo` run, not produced live by this offline tour.

## Where to go next

- `pnpm -C examples eval-react-agent` — run an agent against a dataset
- `pnpm -C examples prompt-registry` — versioned prompts end to end
- `pnpm -C examples exec tsx bench-devtools-demo/main.ts` — a real model comparison
- `SPEC.md` — the engine contract (R1–R48)
