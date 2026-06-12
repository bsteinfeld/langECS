// The code-review crew: one Pr entity, three reviewer lenses that fan in
// DURING THE SAME STEP, a pure-code dedupe, and a model-written verdict.
//
// No graph, no Send() fan-out, no join node. All three reviewers query [Pr],
// so one external send dirties all three pairs at once and the scheduler runs
// them concurrently inside a single step (R25). Their findings merge through
// the Findings append reducer at the step barrier — the barrier IS the fan-in:
// Findings simply does not exist until every reviewer's append commits.

import {
  type AgentDef,
  type ComponentType,
  defineAgent,
  defineComponent,
  defineResource,
  defineSystem,
  type Model,
  type ResourceRef,
} from '@langecs/core';
import { extractJson } from '@langecs/stdlib';

export type Lens = 'security' | 'performance' | 'style';
export type Severity = 'low' | 'medium' | 'high';

/** One issue exactly as a reviewer's model call reports it (see FINDINGS_SCHEMA). */
export type Finding = {
  file: string;
  line: number;
  severity: Severity;
  title: string;
  detail: string;
};

export type Flagged = Finding & { reviewer: Lens }; // as appended by one reviewer
export type Merged = Finding & { reviewers: Lens[] }; // after dedupe: every lens credited
export type Verdict = { verdict: 'approve' | 'request-changes'; summary: string };

/** The pull request under review: title + unified diff. */
export const Pr: ComponentType<{ title: string; diff: string }> = defineComponent({
  name: 'review:Pr',
});

// The append reducer is what lets three reviewers write in the same step: the
// barrier merges their adds in registration order instead of throwing
// WriteConflictError (R30).
export const Findings: ComponentType<Flagged[]> = defineComponent<Flagged[]>({
  name: 'review:Findings',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** Findings after dedupe. Plain component: `dedupe` is its only writer. */
export const Deduped: ComponentType<Merged[]> = defineComponent<Merged[]>({
  name: 'review:Deduped',
});

/** The final review. Plain component: `verdict` is its only writer. */
export const Review: ComponentType<Verdict> = defineComponent<Verdict>({ name: 'review:Review' });

/** Typed handle for the shared review model (R18 amended). */
export const ReviewModel: ResourceRef<Model> = defineResource<Model>('model:review');

const FINDINGS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'path of the changed file' },
      line: { type: 'number', description: 'line number in the new version' },
      severity: { enum: ['low', 'medium', 'high'] },
      title: { type: 'string', description: 'one-line name of the issue' },
      detail: { type: 'string', description: 'why it matters and how to fix it' },
    },
    required: ['file', 'line', 'severity', 'title', 'detail'],
  },
};

// A reviewer lens. All three share the [Pr] query, so the external add of Pr
// is one piece of dirt that schedules three pairs into the same step. Each
// appends to Findings — a component no reviewer queries, so nobody re-fires.
function reviewer(lens: Lens, charter: string) {
  return defineSystem({
    name: lens,
    query: [Pr],
    run: async (e, ctx) => {
      const { title, diff } = e.get(Pr);
      const found = await extractJson<Finding[]>(ctx.resource(ReviewModel), {
        system:
          `You are the ${lens} reviewer on a code-review crew. ${charter} ` +
          'Report only issues in your lens; return [] if you find none.',
        prompt: `Review the diff of PR "${title}":\n\n${diff}`,
        schema: FINDINGS_SCHEMA,
        schemaName: 'Finding[]',
      });
      e.add(
        Findings,
        found.map((f) => ({ ...f, reviewer: lens })),
      );
    },
  });
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

const titleWords = (title: string): Set<string> =>
  new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Two titles describe the same issue when they share half the shorter one's words. */
export function similarTitle(a: string, b: string): boolean {
  const wordsA = titleWords(a);
  const wordsB = titleWords(b);
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  return shared * 2 >= Math.min(wordsA.size, wordsB.size);
}

// Collapses findings with the same file+line and a similar title. The most
// severe reading wins wholesale (severity AND wording); every lens is credited.
export function mergeFindings(flagged: readonly Flagged[]): Merged[] {
  const merged: Merged[] = [];
  for (const { reviewer: lens, ...finding } of flagged) {
    const dup = merged.find(
      (m) =>
        m.file === finding.file && m.line === finding.line && similarTitle(m.title, finding.title),
    );
    if (dup === undefined) {
      merged.push({ ...finding, reviewers: [lens] });
      continue;
    }
    if (!dup.reviewers.includes(lens)) dup.reviewers.push(lens);
    if (RANK[finding.severity] > RANK[dup.severity]) {
      dup.severity = finding.severity;
      dup.title = finding.title;
      dup.detail = finding.detail;
    }
  }
  return merged;
}

// Fires exactly once, exactly after ALL reviewers: Findings is created at the
// step-1 barrier, so this query newly matches at step 2 (R26.2) with every
// reviewer's appends already merged. Pure code — no model call.
export const dedupe = defineSystem({
  name: 'dedupe',
  query: [Findings],
  run: (e) => {
    e.set(Deduped, mergeFindings(e.get(Findings)));
  },
});

// Newly matches when dedupe writes Deduped (step 3). Writes Review, which no
// system queries — the world quiesces right after.
export const verdict = defineSystem({
  name: 'verdict',
  query: [Pr, Deduped],
  run: async (e, ctx) => {
    const review = await extractJson<Verdict>(ctx.resource(ReviewModel), {
      system:
        "You are the lead reviewer turning your crew's deduplicated findings into a PR review. " +
        'Approve only when nothing rises above low severity; otherwise request changes. ' +
        'Write the summary as a short, direct PR comment addressed to the author.',
      prompt:
        `PR "${e.get(Pr).title}" received these deduplicated findings:\n` +
        JSON.stringify(e.get(Deduped), null, 2),
      schema: {
        type: 'object',
        properties: {
          verdict: { enum: ['approve', 'request-changes'] },
          summary: { type: 'string', description: 'a short human-readable review comment' },
        },
        required: ['verdict', 'summary'],
      },
      schemaName: 'Review',
    });
    e.set(Review, review);
  },
});

/** The whole crew as one spawnable bundle; `world.send(pr, Pr(...))` starts a review. */
export const reviewCrew: AgentDef<'review-crew'> = defineAgent({
  name: 'review-crew',
  systems: [
    reviewer(
      'security',
      'Hunt injection risks, unsafe handling of user input, and leaked secrets.',
    ),
    reviewer('performance', 'Hunt accidental O(n^2) work, needless allocation, and blocking I/O.'),
    reviewer('style', 'Hunt naming problems, dead code, and non-idiomatic TypeScript (var, any).'),
    dedupe,
    verdict,
  ],
});

/** Inline PR fixture: a SQL-injection-ish concat (line 5), `var` (line 11), an O(n^2) scan (lines 12-13). */
export const DIFF = `diff --git a/src/users/report.ts b/src/users/report.ts
--- a/src/users/report.ts
+++ b/src/users/report.ts
@@ -1,4 +1,21 @@
 import { db } from '../db';

+export async function searchUsers(name: string) {
+  const rows = await db.query(
+    "SELECT * FROM users WHERE name LIKE '%" + name + "%'",
+  );
+  return rows;
+}
+
+export function duplicateEmails(users: { email: string }[]) {
+  var dupes = [];
+  for (var i = 0; i < users.length; i++) {
+    for (var j = 0; j < users.length; j++) {
+      if (i !== j && users[i].email === users[j].email) dupes.push(users[i].email);
+    }
+  }
+  return dupes;
+}
`;
