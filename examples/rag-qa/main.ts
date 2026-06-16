// Retrieval-Augmented Generation demo — decompose → retrieve (parallel) → answer.
//
// Run with: pnpm -C examples rag-qa   (OPENAI_API_KEY in repo-root .env.local)
//
// The retriever is a tiny in-memory corpus (no vector DB needed to see the
// shape). Watch the event stream: step 1 decomposes into sub-queries and spawns
// a retriever per query; step 2 runs ALL retrievers in one step (parallel
// fan-out) and merges their hits via the Retrieved reducer; step 3 synthesizes
// a grounded, cited answer.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { Answer, type Passage, QaModel, Question, RetrieverRef, useRagPipeline } from './pipeline';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

// A toy knowledge base. A real app swaps this for a vector store — the pipeline
// doesn't change, only the resource registered under 'retriever'.
const CORPUS: Passage[] = [
  {
    source: 'hummingbird-flight',
    text: 'Hummingbirds can hover and are the only birds able to fly backwards.',
  },
  {
    source: 'hummingbird-metabolism',
    text: 'A hummingbird heart can beat over 1200 times per minute during flight.',
  },
  {
    source: 'hummingbird-diet',
    text: 'Hummingbirds feed on nectar and small insects, visiting hundreds of flowers a day.',
  },
  {
    source: 'bee-pollination',
    text: 'Bees transfer pollen between flowers, enabling plant reproduction.',
  },
  {
    source: 'migration',
    text: 'The ruby-throated hummingbird migrates across the Gulf of Mexico nonstop.',
  },
];

/** Keyword retriever: scores passages by how many query terms appear (as substrings). */
function keywordRetriever(query: string): Passage[] {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  return CORPUS.map((p) => {
    const text = p.text.toLowerCase();
    const score = terms.filter((term) => text.includes(term)).length;
    return { p, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.p);
}

const world = createWorld({ id: 'rag-qa' });
world.register(QaModel, fromAiSdk(openai('gpt-4o-mini')));
world.register(RetrieverRef, keywordRetriever);
useRagPipeline(world);

const question = 'How do hummingbirds fly and what do they eat?';
const task = world.spawn(Question(question));
console.log(`question> ${question}\n`);

const run = world.run();
for await (const event of run) {
  if (event.type === 'custom') {
    const data = event.data as { kind?: string; text?: string; query?: string; hits?: number };
    if (data.kind === 'subquery') console.log(`  decomposed -> "${data.text}"`);
    if (data.kind === 'retrieved')
      console.log(`  retrieved ${data.hits} passage(s) for "${data.query}"`);
  }
  if (event.type === 'step:applied') {
    console.log(
      `[step ${event.step}] applied: ${event.changes.map((c) => c.component).join(', ')}`,
    );
  }
}

const result = await run;
if (result.status !== 'done') {
  console.error(`Run did not finish cleanly: ${JSON.stringify(result, null, 2)}`);
  process.exit(1);
}
console.log(`\nanswer> ${world.entity(task.id)?.get(Answer) ?? '(none)'}`);
