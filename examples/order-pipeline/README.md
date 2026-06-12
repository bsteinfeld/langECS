# Order Pipeline (zero LLM calls)

E-commerce order fulfillment — five orders flow `Validated -> Charged -> Reserved -> Shipped`
with one rejected at validation and one surviving a flaky payment gateway. There is **no
model, no agent, and no graph** in this example: it proves the LangECS engine is a general
workflow runtime, not an LLM-coupled framework.

```sh
pnpm -C examples order-pipeline           # per-order status table
pnpm -C examples order-pipeline --trace   # + the flight recorder
```

Tests (deterministic, zero network):

```sh
pnpm -C examples exec vitest run order-pipeline
```

## What it teaches

1. **Stages are components, transitions are queries.** Each system queries
   "previous stage present + `Not(next stage)`" (`[Order, Validated, Not(Charged)]`, ...).
   Writing a stage component is what wakes the next system — newly-matched dirt (SPEC R26)
   replaces every edge a graph framework would make you draw.

2. **Concurrency falls out for free.** Every order that is ready for a stage runs in the
   *same step*, as parallel pairs (R25.5). Run with `--trace` and read the choreography:

   ```
   step 1  validate x5                              — all five orders, one step
   step 2  chargePayment x4                         — ORD-1003's gateway call throws (R31)
   step 3  reserveInventory x3 + retry#ORD-1003     — the failure blocked NOBODY
   step 4  ship x3 + chargePayment#ORD-1003         — others ship while the retry succeeds
   step 5  reserveInventory#ORD-1003                — the healed order catches up
   step 6  ship#ORD-1003
   ```

   Steps 3–4 are the point: while ORD-1003 is being healed, the other orders keep
   advancing in the very same steps. One order's failure never blocks the others, because
   there is no shared pipeline state to block — only per-entity components.

3. **Failure is data; recovery is just another system.** When the gateway throws, the
   engine discards the pair's writes and appends a `SystemError` record on that order
   (R31). The stdlib `retry` system queries `[SystemError, RetryPolicy]`, backs off, and
   re-fires the exact failing pair via `ctx.invalidate` (R24); the eventual success
   auto-clears the record (R32). `chargePayment` contains zero retry logic.

Also showcased: `defineResource` gives the payment gateway a **typed** resource ref
(`ctx.resource(PaymentsGateway)` — no stringly-typed lookups, R18 amended).

## Files

- `pipeline.ts` — `Order` + stage components, the four stage systems, the typed
  `PaymentsGateway` resource, and `buildWorld` (stage systems + stdlib `retry`).
- `main.ts` — spawns five orders, `await world.run()`, prints a status table from
  `world.query(Order)`.
- `order-pipeline.test.ts` — asserts final states (rejected, retried) and the step
  choreography above directly from `world.getTrace()`.
