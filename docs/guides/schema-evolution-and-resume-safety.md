# Schema evolution and resume safety

*Renaming a component without orphaning live worlds, and making sure two workers
never resume the same snapshot. Requirements: R54 (recipe versions and
migrations), R55 (non-strict load), R56 (`canLoad`), R57 (fencing and
`expectedStep`), R58 (write cadence).*

This guide exists because of one bug that two of the engine's best features
produce together.

Quiescence **is** the pause (see [human-in-the-loop](./human-in-the-loop.md)), so
a world can sit paused for as long as a human takes — hours, or a week. And
`world.load` throws on any component name or `pendingPairs` system it cannot
resolve (R36), which is the right default, because silently dropping state would
be much worse. Put those together:

> Someone pauses a run awaiting approval. You deploy a component rename. Their
> world is now permanently unloadable, and it fails with a stack trace at load
> time.

That used to have no supported answer at all — not a hard one, not an awkward
one. It hit the *most* enthusiastic adopters first: the ones who actually paused
a world for a day.

## Two version numbers, deliberately

A snapshot carries two:

```ts
{ version: 1,           // the ENVELOPE FORMAT — the engine owns this
  recipeVersion: 3,     // YOUR component/system vocabulary — you own this
  worldId, step, nextEntityId, entities, pendingPairs }
```

Keeping them separate is the point. They change on completely independent
schedules: `version` moves when the engine's snapshot shape changes,
`recipeVersion` when *your* components do. Collapse them into one number and
every engine release looks like a schema migration, while every schema migration
looks like a format break.

`recipeVersion` defaults to 0 and is omitted from the envelope entirely at 0, so
a world that never opts in keeps writing byte-identical snapshots.

## Renaming a component without orphaning live worlds

Declare the new version, and register the step that bridges it:

```ts
const world = createWorld({ id: 'deck-42', recipeVersion: 2, persistence: adapter })

world.migration(1, 2, (s) => {
  for (const entity of s.entities) {
    if ('Draft' in entity.components) {
      entity.components.Article = entity.components.Draft
      delete entity.components.Draft
    }
  }
  // The half that is easy to forget: pendingPairs reference systems BY KEY, so a
  // renamed system leaves dirt pointing at a name that no longer resolves.
  for (const pair of s.pendingPairs) {
    if (pair.system === 'writeDraft') pair.system = 'writeArticle'
  }
  return s
})

world.load(pausedSnapshot)   // migrated on the way in
```

Four rules make this predictable:

- **Migrations run before any name is resolved.** That ordering is what lets a
  migration rename a component the running build no longer defines. If validation
  came first, there would be nothing a migration could fix.
- **A migration gets a detached deep copy.** Mutate it and return it; you cannot
  corrupt anything upstream.
- **The chain is walked ascending and transitively.** Register 1→2 and 2→3, load a
  v1 snapshot into a v3 world, and both run in order.
- **Exactly one migration may start at a given version.** Two would make the
  upgrade path depend on registration order, so the second throws
  `DuplicateMigrationError`. Re-registering the *same* edge is idempotent, so
  module reloads are fine.

`world.load` returns a `LoadReport` telling you what happened:

```ts
const report = world.load(pausedSnapshot)
report.migrated        // [{ from: 1, to: 2 }]
```

### A snapshot from newer code fails loudly

If `recipeVersion` is *ahead* of the world's, `load` throws `RecipeVersionError`
with `fromFuture: true`, and there is deliberately no way to migrate it. Only
code that knows the later schema can interpret it, so a rollback has to refuse
rather than quietly misread live state. Deploy the newer code, or restore an
older snapshot.

## Finding out at deploy time, not from your user

`canLoad` is the same analysis with no side effects — nothing mutated, nothing
thrown:

```ts
const check = world.canLoad(snapshot)
if (!check.ok) {
  check.missingMigration   // { from: 1, to: 2 }
  check.components         // names that would not resolve, after migration
  check.systems            // pendingPairs systems that are not registered
  check.recipeVersion      // set when the snapshot is from the future
}
```

Point it at your paused worlds from CI and a rename that would orphan them fails
the build. That is the difference between an operator learning about this at
deploy time and the user who paused the world learning about it for them.

## Rolling deploys: `strict: false`

During a rolling deploy two versions run at once, and the old one will read
snapshots containing components only the new one knows. `{ strict: false }`
resolves what it can and reports the rest — with a deliberate asymmetry:

```ts
const report = world.load(snapshot, { strict: false })
report.preserved     // [{ entity: 7, component: 'newer.Thing' }]  ← kept
report.droppedPairs  // [{ entity: 7, system: 'newerSystem', … }]  ← gone
```

- An **unknown component is preserved as opaque data**, not dropped. It joins no
  query, generates no dirt, and runs no reducer — but the next `snapshot()` writes
  it back out. Dropping it would mean the old version silently destroys state the
  new version still owns, which is far worse than carrying bytes you cannot
  interpret.
- An **unknown `pendingPairs` system is dropped and reported**. There is nowhere
  to keep it: dirt names a system that has to be *scheduled*. The work it
  described will not run, so it is surfaced loudly rather than swallowed.

Use `strict: false` for rolling deploys and forward-compatibility. Keep the
default (`strict: true`) everywhere else — you want the loud failure.

## Two workers, one snapshot

The recommended deployment shape is: a run drives to quiescence, the job
completes, and resuming enqueues a *new* job that loads the snapshot. That is
exactly the shape where two resumes race — a double-click, two browser tabs, a
queue retry after a timeout, or two workers picking up the same message. Nothing
about it is exotic, and the divergence is **silent**: both worlds run happily,
and one of them is writing history nobody will ever read.

Two mechanisms, catching it at different moments.

### `expectedStep` — cheap and synchronous

```ts
world.load(snapshot, { expectedStep: snapshot.step })   // StaleSnapshotError on mismatch
```

No adapter involvement. Enough to catch a resume that read a snapshot another
worker has since advanced.

### Fencing — the durable guarantee

The resume recipe has four steps, and the order matters:

```ts
const world = createWorld({ id: 'deck-42', persistence: adapter, fence: true })
world.use(recordsAgent)
world.load(snapshot)
await world.claim()                 // throws FenceError if another worker owns it
await world.resume(entity, true)
```

**`claim()` is what makes side effects exactly-once.** The save-time fence alone
does not: it stops the loser from persisting a divergent timeline, but by then its
systems have already run — the refund is issued, the record is already deleted.
Claiming before any step executes is what stops the loser from doing the work at
all. The example test asserts exactly this: two workers resume one approval, and
`delete_record` runs **once**.

With `fence: true`, the engine also calls `adapter.fence(worldId, step)` immediately
**before each save** — the moment divergence would actually become durable, and
already an awaited async boundary — and rejects the run with `FenceError` if
refused. The loser stops rather than keep writing.

```
worker A  load(step 5) → run → fence(id, 6) → true  → saves  ✓
worker B  load(step 5) → run → fence(id, 6) → false → FenceError, stops
```

`fence` must be **monotonic per worldId**: granting a step implicitly refuses
that step and everything below it. Implementations must make the check-and-claim
**atomic** against other writers — a conditional write, a compare-and-set, or
`O_EXCL`. A read followed by a separate write reintroduces the very race it
exists to close. `persist-fs` uses exclusive create (`wx`), which the kernel makes
atomic across processes:

```ts
await writeFile(lockPath, stamp, { flag: 'wx' })   // EEXIST ⇒ someone else won
```

**Fencing is opt-in per world, and deliberately not implied by the adapter having
the method.** A time-travel world legitimately rewrites steps it has already
written (R38), and an automatic fence would refuse its own replay. Enable it on
production worlds; leave it off for rewind, fork, and tests.

When a world loses the fence, its in-memory state is ahead of what was persisted.
Discard it and reload — do not try to re-save.

## Write cadence

`snapshot()` serialises **every** entity's every component, and by default the
engine writes after every barrier. Cost per step therefore scales with total
world size rather than with what changed, so a long run over a large blackboard
pays for the whole world on every step.

```ts
createWorld({ saveEvery: 'barrier' })      // default: every committed step
createWorld({ saveEvery: 'quiescence' })   // once per run
createWorld({ saveEvery: 25 })             // every 25 steps
```

Run end always writes, at every setting, so a quiesced world is never left
unpersisted. And because quiescence *is* the pause here, `'quiescence'` still
captures every boundary a human-in-the-loop flow resumes from — what it gives up
is the **intermediate** steps, which is to say step-level time travel. If a
process dies mid-run under that setting, you lose back to the last run boundary,
not to the beginning.

One related fix: a boundary is now never written twice. The engine used to persist
the final step at its barrier *and* again at run end — harmless against an
idempotent adapter, but a monotonic fence would have refused the world's own
second claim on the same step.

## See also

- [persistence and time travel](./persistence-and-time-travel.md) — snapshot
  anatomy, the adapter contract, rewind and fork
- [human-in-the-loop](./human-in-the-loop.md) — why paused worlds are the ones
  that get orphaned by a rename
- [examples/human-in-the-loop](../../examples/human-in-the-loop/README.md) —
  kill-and-resume across processes, now including a rename survived by a migration
