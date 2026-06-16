// Retrieval-Augmented Generation as an ECS pipeline.
//
// One question becomes a small blackboard entity. A `decompose` system breaks it
// into focused sub-queries (typed structured output via `extractJson`) and spawns
// one retrieval entity per sub-query. Those retrievers all match `[SubQuery,
// Parent]` in the SAME step and run in parallel, each fanning its passages back
// into the question's `Retrieved` component — whose append reducer merges the
// concurrent writers deterministically at the barrier (no conflict, no lock). A
// `Reports` sum-reducer counts completions so `synthesize` knows when every
// retriever is in, then composes the grounded answer.
//
// This is the supervisor fan-out/fan-in pattern applied to RAG: parallel
// retrieval is just "many entities matching in one step", and gathering results
// is just a reducer. No graph, no orchestration code.

import {
  defineComponent,
  defineResource,
  defineSystem,
  type Model,
  Not,
  type World,
} from '@langecs/core';
import { extractJson } from '@langecs/stdlib';

// ---------------------------------------------------------------- data shapes

/** A retrieved chunk of source text. */
export type Passage = { source: string; text: string };

/** The mock retriever's contract: a query string in, ranked passages out. */
export type Retriever = (query: string) => Passage[];

// ----------------------------------------------------------------- resources

export const QaModel = defineResource<Model>('model:main');
export const RetrieverRef = defineResource<Retriever>('retriever');

// ---------------------------------------------------------------- components

/** The user's question (on the QA blackboard entity). */
export const Question = defineComponent<string>({ name: 'ragQuestion' });

/** One search query handed to a spawned retrieval entity. */
export const SubQuery = defineComponent<string>({ name: 'ragSubQuery' });

/** Back-reference from a retrieval entity to its QA blackboard. */
export const Parent = defineComponent<number>({ name: 'ragParent' });

/** Retrieved passages, fanned in from parallel retrievers (append reducer). */
export const Retrieved = defineComponent<Passage[]>({
  name: 'ragRetrieved',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** How many retrievers have reported, summed across parallel writers. */
export const Reports = defineComponent<number>({
  name: 'ragReports',
  reducer: (current, incoming) => current + incoming,
});

/** Set once retrievers are dispatched; `expect` = number of sub-queries. */
export const Dispatched = defineComponent<{ expect: number }>({ name: 'ragDispatched' });

/** The final grounded answer. */
export const Answer = defineComponent<string>({ name: 'ragAnswer' });

// ------------------------------------------------------------------- systems

const SUBQUERY_SCHEMA = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      items: { type: 'string' },
      description: '1-3 focused search queries',
    },
  },
  required: ['queries'],
};

/** Decompose the question into sub-queries and spawn a retriever for each. */
export const decompose = defineSystem({
  name: 'decompose',
  query: [Question, Not(Dispatched)],
  run: async (e, ctx) => {
    const model = ctx.resource(QaModel);
    const { queries } = await extractJson(
      model,
      {
        system:
          'Break the question into 1-3 focused search queries that together cover ' +
          'what is needed to answer it. Fewer is better.',
        prompt: e.get(Question),
        schema: SUBQUERY_SCHEMA,
        schemaName: 'SubQueries',
      },
      (raw): { queries: string[] } => {
        const queries = (raw as { queries?: unknown }).queries;
        if (
          !Array.isArray(queries) ||
          queries.length === 0 ||
          !queries.every((q) => typeof q === 'string' && q.trim().length > 0)
        ) {
          throw new Error('`queries` must be a non-empty array of non-empty strings.');
        }
        return { queries: queries as string[] };
      },
    );

    for (const query of queries) {
      ctx.spawn(SubQuery(query), Parent(e.id));
      ctx.emit({ kind: 'subquery', text: query });
    }
    e.set(Dispatched, { expect: queries.length });
  },
});

/**
 * Retrieve for one sub-query and fan the passages back into the parent. Many
 * retrieval entities match this in the same step → parallel retrieval; the
 * parent's `Retrieved` reducer merges them at the barrier.
 */
export const retrieve = defineSystem({
  name: 'retrieve',
  query: [SubQuery, Parent],
  run: (e, ctx) => {
    const search = ctx.resource(RetrieverRef);
    const parent = e.get(Parent);
    const passages = search(e.get(SubQuery));
    ctx.write(parent, Retrieved, passages, 'add');
    ctx.write(parent, Reports, 1, 'add'); // sum reducer counts completions
    ctx.emit({ kind: 'retrieved', query: e.get(SubQuery), hits: passages.length });
    ctx.despawn(e); // the retrieval task is done
  },
});

/** Compose the grounded answer once every retriever has reported. */
export const synthesize = defineSystem({
  name: 'synthesize',
  query: [Question, Retrieved, Reports, Dispatched, Not(Answer)],
  when: (e) => e.get(Reports) >= e.get(Dispatched).expect,
  run: async (e, ctx) => {
    const model = ctx.resource(QaModel);
    // De-duplicate passages (sub-queries can overlap) before grounding.
    const seen = new Set<string>();
    const context = e
      .get(Retrieved)
      .filter((p) => {
        if (seen.has(p.text)) return false;
        seen.add(p.text);
        return true;
      })
      .map((p) => `[${p.source}] ${p.text}`)
      .join('\n');
    const reply = await model.generate({
      system:
        'Answer the question using ONLY the provided context. Cite sources inline ' +
        'like [source]. If the context is insufficient, say so plainly.',
      messages: [{ role: 'user', content: `Context:\n${context}\n\nQuestion: ${e.get(Question)}` }],
    });
    e.set(Answer, reply.message.content);
  },
});

/** Registers the RAG systems globally. */
export function useRagPipeline(world: World): void {
  world.use(decompose);
  world.use(retrieve);
  world.use(synthesize);
}
