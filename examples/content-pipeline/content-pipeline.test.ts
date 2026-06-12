// Deterministic choreography test — core scriptedModel only, zero network.
// A scripted 3-section outline; asserts the exact stage schedule from the
// flight recorder: fan-out spawns 3 Section entities, ALL THREE drafters run
// in the same step, drafts reduce by outline index even though completion
// order is deliberately scrambled, and one editor pass publishes the post.

import { createWorld, type Model, type ModelRequest, type Msg, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  Assembled,
  assemble,
  Brief,
  Outline,
  Published,
  pipeline,
  Section,
  SectionDrafts,
  WriterModel,
} from './pipeline';

const OUTLINE = { title: 'ECS for Agents', sections: ['The hook', 'Why it fits', 'Takeaways'] };

/** Which outline slot a drafter request targets (the drafter quotes the heading). */
const sectionOf = (req: ModelRequest): number =>
  OUTLINE.sections.findIndex((h) => req.messages[0]?.content.includes(`"${h}"`) ?? false);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delays drafter calls so LATER sections answer FIRST (index 2 immediately,
 * index 0 last). If assembly depended on completion order the post would come
 * out reversed — it must come out in outline order instead.
 */
const scrambleCompletion = (model: Model): Model => ({
  async generate(req) {
    const index = sectionOf(req);
    if (index >= 0) await sleep((OUTLINE.sections.length - 1 - index) * 20);
    return model.generate(req);
  },
});

const draftTurn = (req: ModelRequest): Msg => ({
  role: 'assistant',
  content: `Body of ${OUTLINE.sections[sectionOf(req)]}.`,
});

const EXPECTED_ASSEMBLED = [
  '# ECS for Agents',
  '## The hook',
  'Body of The hook.',
  '## Why it fits',
  'Body of Why it fits.',
  '## Takeaways',
  'Body of Takeaways.',
].join('\n\n');

test('brief → outline → 3-way fan-out → same-step parallel drafts → index-ordered assembly → edit', async () => {
  const requests: ModelRequest[] = [];
  const record =
    (turn: (req: ModelRequest) => Msg) =>
    (req: ModelRequest): Msg => {
      requests.push(req);
      return turn(req);
    };

  const world = createWorld({ id: 'content-pipeline-test' });
  // 5 scripted turns = 5 model calls total; one extra call (e.g. an extractJson
  // retry) would throw 'scriptedModel exhausted'. The drafter turns are keyed
  // on the request, not on position, because their order is the scrambled one.
  world.register(
    WriterModel,
    scrambleCompletion(
      scriptedModel([
        record(() => ({ role: 'assistant', content: JSON.stringify(OUTLINE) })),
        record(draftTurn),
        record(draftTurn),
        record(draftTurn),
        record(() => ({ role: 'assistant', content: 'The polished final post.' })),
      ]),
    ),
  );
  for (const stage of pipeline) world.use(stage);

  const post = world.spawn();
  const result = await world.send(post, Brief('Why ECS fits LLM agent workflows.'));

  expect(result.status).toBe('done');
  expect(result.steps).toBe(5); // one step per stage — the 3 drafts share ONE step

  // --- fan-out: one Section entity per heading, addressed back to the Post.
  const sections = world.query(Section);
  expect(sections).toHaveLength(3);
  expect(sections.map((s) => s.get(Section))).toEqual([
    { post: post.id, index: 0, heading: 'The hook' },
    { post: post.id, index: 1, heading: 'Why it fits' },
    { post: post.id, index: 2, heading: 'Takeaways' },
  ]);

  // --- the stage choreography, straight from the flight recorder.
  const trace = world.getTrace();
  expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
    ['outline'],
    ['draftSections'],
    ['drafter', 'drafter', 'drafter'], // every section drafted in the SAME step
    ['assemble'],
    ['editor'],
  ]);
  const ids = sections.map((s) => s.id);
  expect([...(trace[1]?.spawned ?? [])].sort((a, b) => a - b)).toEqual(ids);
  expect(trace[1]?.spawnedBy?.map((s) => `${s.system}<-${s.parent}`)).toEqual(
    ids.map(() => `draftSections<-${post.id}`),
  );
  expect(trace[2]?.runs.map((r) => r.entity).sort((a, b) => a - b)).toEqual(ids);

  // --- fan-in: completion order really was reversed (2, 1, 0)…
  expect(requests.slice(1, 4).map(sectionOf)).toEqual([2, 1, 0]);
  // …but the drafts merged via the reducer and assembly read each draft's
  // index, so the page is in outline order, not arrival order.
  expect(post.get(SectionDrafts)).toHaveLength(3);
  expect(post.get(Assembled)).toBe(EXPECTED_ASSEMBLED);

  // --- the editor saw the assembled draft and its reply is the published post.
  expect(requests[4]?.messages[0]?.content).toContain(EXPECTED_ASSEMBLED);
  expect(post.get(Published)).toBe('The polished final post.');

  // Quiescence: Published un-matched the editor; a fresh run has nothing to do.
  const again = await world.run();
  expect(again.status).toBe('idle');
  expect(again.steps).toBe(0);
});

test('the count guard holds assembly until every outline slot has a draft', async () => {
  // Pure logic — only the assemble stage, no model, no other systems.
  const world = createWorld({ id: 'content-pipeline-guard' });
  world.use(assemble);
  const post = world.spawn(Outline({ title: 'T', sections: ['One', 'Two'] }));

  // The second slot arrives first: assemble is scheduled but the guard vetoes
  // (1 draft ≠ 2 sections). The veto consumed the dirt; nothing executed.
  const early = await world.send(post, SectionDrafts([{ index: 1, text: 'second half' }]));
  expect(early.status).toBe('idle');
  expect(early.steps).toBe(0);
  expect(world.getTrace().at(-1)?.vetoed).toEqual([{ system: 'assemble', entity: post.id }]);
  expect(post.has(Assembled)).toBe(false);

  // The missing slot lands: fresh dirt re-schedules the pair and counts match.
  const done = await world.send(post, SectionDrafts([{ index: 0, text: 'first half' }]));
  expect(done.status).toBe('done');
  expect(done.steps).toBe(1);

  // The reduce buffer holds arrival order (1 then 0) — the page does not.
  expect(post.get(SectionDrafts)?.map((d) => d.index)).toEqual([1, 0]);
  expect(post.get(Assembled)).toBe('# T\n\n## One\n\nfirst half\n\n## Two\n\nsecond half');
});
