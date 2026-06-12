// The content pipeline: one Post entity flows brief → outline → parallel
// section drafts → assembled draft → published post. There is no orchestrator
// and no stage list — every system declares the data shape it needs, and the
// previous stage *producing* that shape is what fires the next one.

import {
  type ComponentType,
  defineComponent,
  defineResource,
  defineSystem,
  type Model,
  Not,
  type ResourceRef,
} from '@langecs/core';
import { extractJson } from '@langecs/stdlib';

// --- Components: the post's lifecycle, written down as data shapes ----------

/** The assignment ("a short post about X, for audience Y"). The pipeline's only input. */
export const Brief: ComponentType<string> = defineComponent<string>({ name: 'Brief' });

export interface OutlineValue {
  title: string;
  sections: string[];
}

/** The plan. Its appearance on the Post is what triggers the fan-out. */
export const Outline: ComponentType<OutlineValue> = defineComponent<OutlineValue>({
  name: 'Outline',
});

export interface SectionValue {
  post: number;
  index: number;
  heading: string;
}

/** One fan-out unit: a Section entity knows its parent Post and its outline slot. */
export const Section: ComponentType<SectionValue> = defineComponent<SectionValue>({
  name: 'Section',
});

export interface SectionDraft {
  index: number;
  text: string;
}

/**
 * Drafted section texts, reduced onto the Post. The append reducer IS the
 * fan-in: N drafters writing concurrently in one step merge instead of
 * conflicting (R30), and each entry carries its outline `index` so assembly
 * order comes from the plan — never from which model call finished first.
 */
export const SectionDrafts: ComponentType<SectionDraft[]> = defineComponent<SectionDraft[]>({
  name: 'SectionDrafts',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** The stitched full draft, pre-edit. */
export const Assembled: ComponentType<string> = defineComponent<string>({ name: 'Assembled' });

/** The final post. Once it exists, no query matches: done and quiescent are the same fact. */
export const Published: ComponentType<string> = defineComponent<string>({ name: 'Published' });

/** Typed handle for the model resource — no raw 'model:…' strings at call sites. */
export const WriterModel: ResourceRef<Model> = defineResource<Model>('model:writer');

// --- Systems: each stage is one small, single-purpose reaction --------------

/**
 * Stage 1 — plan. Matches a Post that has a Brief but no Outline yet, so the
 * external send of the Brief is the only thing that can fire it; setting
 * Outline un-matches the Not() term, and the stage can never re-fire.
 */
export const outline = defineSystem({
  name: 'outline',
  query: [Brief, Not(Outline)],
  run: async (e, ctx) => {
    const plan = await extractJson<OutlineValue>(ctx.resource(WriterModel), {
      prompt:
        `Plan a short blog post for this brief:\n${e.get(Brief)}\n\n` +
        'Give a punchy title and exactly 3 section headings.',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          sections: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        },
        required: ['title', 'sections'],
      },
      schemaName: 'Outline',
    });
    e.set(Outline, plan);
  },
});

/**
 * Stage 2 — fan out. The Outline that stage 1 just set is a NEW match for this
 * query, so this fires exactly once and spawns one Section entity per heading.
 * Every fresh Section is new dirt for `drafter` — the engine schedules all of
 * them together next step; no Promise.all in sight.
 */
export const draftSections = defineSystem({
  name: 'draftSections',
  query: [Outline],
  run: (e, ctx) => {
    for (const [index, heading] of e.get(Outline).sections.entries()) {
      ctx.spawn(Section({ post: e.id, index, heading }));
    }
  },
});

/**
 * Stage 3 — draft, in parallel. One run per Section entity; because all
 * Sections materialized at the same barrier, every pair is dirty in the SAME
 * step and the model calls overlap for free. The result is written back to
 * the parent Post (cross-entity `ctx.write`), where the SectionDrafts reducer
 * merges the concurrent appends.
 */
export const drafter = defineSystem({
  name: 'drafter',
  query: [Section],
  run: async (e, ctx) => {
    const { post, index, heading } = e.get(Section);
    const title = ctx.world.entity(post)?.get(Outline)?.title ?? 'the post';
    const { message } = await ctx.resource(WriterModel).generate({
      messages: [
        {
          role: 'user',
          content:
            `Write the "${heading}" section of a short blog post titled "${title}". ` +
            '2–3 sentences of body text only; no heading line, no markdown.',
        },
      ],
    });
    ctx.write(post, SectionDrafts, [{ index, text: message.content }]);
  },
});

/**
 * Stage 4 — fan in. Each drafter append is foreign dirt on the Post, but the
 * guard compares counts and holds the stage until every outline slot has a
 * draft: readiness is a property of the data, not of stage choreography.
 * Stitching sorts by index, so completion order never leaks into the page.
 */
export const assemble = defineSystem({
  name: 'assemble',
  query: [Outline, SectionDrafts],
  when: (e) => e.get(SectionDrafts).length === e.get(Outline).sections.length,
  run: (e) => {
    const { title, sections } = e.get(Outline);
    // get() values are committed state and must stay immutable (R17) — copy, then sort.
    const ordered = [...e.get(SectionDrafts)].sort((a, b) => a.index - b.index);
    const body = ordered.map((d) => `## ${sections[d.index]}\n\n${d.text}`).join('\n\n');
    e.set(Assembled, `# ${title}\n\n${body}`);
  },
});

/**
 * Stage 5 — edit. One polish pass over the stitched draft. Setting Published
 * un-matches the Not() term, and with no other dirty pair the world goes
 * quiescent — the pipeline ends because nothing is left to react to.
 */
export const editor = defineSystem({
  name: 'editor',
  query: [Assembled, Not(Published)],
  run: async (e, ctx) => {
    const { message } = await ctx.resource(WriterModel).generate({
      messages: [
        {
          role: 'user',
          content:
            'Lightly edit this blog post draft for flow and consistent voice. ' +
            `Keep the markdown structure. Return only the edited post.\n\n${e.get(Assembled)}`,
        },
      ],
    });
    e.set(Published, message.content);
  },
});

/** The whole pipeline; register with `for (const stage of pipeline) world.use(stage)`. */
export const pipeline = [outline, draftSections, drafter, assemble, editor];
