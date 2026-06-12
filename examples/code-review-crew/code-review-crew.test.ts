// Deterministic choreography test — core scriptedModel only, zero network.
// Proves the one-step parallel fan-in straight from the flight recorder: all
// three reviewers run in the SAME step, dedupe collapses a planted
// cross-reviewer duplicate, and the verdict summarizes the merged findings.

import { createWorld, type ModelRequest, type Msg, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  Deduped,
  DIFF,
  type Finding,
  Findings,
  type Flagged,
  mergeFindings,
  Pr,
  Review,
  ReviewModel,
  reviewCrew,
  similarTitle,
} from './crew';

/** Serves canned JSON and asserts WHICH lens-specific prompt it answered. */
const turnFor =
  (requests: ModelRequest[], lens: string, value: unknown) =>
  (req: ModelRequest): Msg => {
    requests.push(req);
    expect(req.system).toContain(lens);
    return { role: 'assistant', content: JSON.stringify(value) };
  };

const SQLI: Finding = {
  file: 'src/users/report.ts',
  line: 5,
  severity: 'high',
  title: 'SQL injection via string concatenation',
  detail: 'User input is concatenated into the query; use a parameterized query.',
};
// The planted duplicate: the same line-5 issue, seen through the style lens.
const SQLI_AGAIN: Finding = {
  file: 'src/users/report.ts',
  line: 5,
  severity: 'low',
  title: 'String concatenation builds a SQL query',
  detail: 'Prefer a query builder over manual string assembly.',
};
const QUADRATIC: Finding = {
  file: 'src/users/report.ts',
  line: 13,
  severity: 'medium',
  title: 'O(n^2) duplicate scan',
  detail: 'Nested loops over users; count emails in a Map for O(n).',
};
const VAR_DECL: Finding = {
  file: 'src/users/report.ts',
  line: 11,
  severity: 'low',
  title: 'var instead of const/let',
  detail: 'Block-scoped declarations avoid hoisting surprises.',
};

test('three reviewers share one step; dedupe collapses the duplicate; verdict lands', async () => {
  const requests: ModelRequest[] = [];
  // Pairs start in system registration order (deterministic, R25/T21), so the
  // call order is security, performance, style, then the lead verdict — and
  // each turn ASSERTS it answered the right lens's prompt.
  const model = scriptedModel([
    turnFor(requests, 'security', [SQLI]),
    turnFor(requests, 'performance', [QUADRATIC]),
    turnFor(requests, 'style', [SQLI_AGAIN, VAR_DECL]),
    turnFor(requests, 'lead reviewer', {
      verdict: 'request-changes',
      summary: 'Blocking: fix the SQL injection before merge.',
    }),
  ]);

  const world = createWorld({ id: 'code-review-crew-test' });
  world.register(ReviewModel, model);
  const pr = world.spawn(reviewCrew);

  const result = await world.send(pr, Pr({ title: 'Add user search', diff: DIFF }));
  expect(result.status).toBe('done');
  expect(result.steps).toBe(3);

  // --- the one-step parallel fan-in, proven from the flight recorder ---
  const trace = world.getTrace();
  expect(trace.map((step) => step.runs.map((r) => r.system).sort())).toEqual([
    ['review-crew:performance', 'review-crew:security', 'review-crew:style'], // SAME step
    ['review-crew:dedupe'], // fires once Findings exists — i.e. after ALL reviewers
    ['review-crew:verdict'], // fires once Deduped exists
  ]);
  expect(trace.every((step) => step.vetoed.length === 0)).toBe(true);

  // All three reviewers read the same committed Pr diff in step 1.
  for (const req of requests.slice(0, 3)) {
    expect(req.messages.at(-1)?.content).toContain("LIKE '%");
  }

  // The Findings reducer merged the three same-step writers in registration
  // order (R30) — no WriteConflictError, no join node.
  expect((pr.get(Findings) ?? []).map((f) => f.reviewer)).toEqual([
    'security',
    'performance',
    'style',
    'style',
  ]);

  // --- dedupe: 4 raw findings -> 3; the duplicate keeps the highest severity ---
  const merged = pr.get(Deduped) ?? [];
  expect(merged).toHaveLength(3);
  expect(merged.find((m) => m.line === SQLI.line)).toEqual({
    ...SQLI, // high-severity wording wins over SQLI_AGAIN's
    reviewers: ['security', 'style'],
  });
  expect(merged.map((m) => m.line).sort((a, b) => a - b)).toEqual([5, 11, 13]);

  // The lead saw the deduplicated list, not the raw four.
  expect(requests[3]?.messages[0]?.content).toContain(SQLI.title);
  expect(requests[3]?.messages[0]?.content).not.toContain(SQLI_AGAIN.title);

  expect(pr.get(Review)).toEqual({
    verdict: 'request-changes',
    summary: 'Blocking: fix the SQL injection before merge.',
  });

  // Quiescent: Review feeds no query, so a fresh run has nothing to do.
  const again = await world.run();
  expect(again.status).toBe('idle');
  expect(again.steps).toBe(0);
});

test('mergeFindings is pure code: same file+line+similar title collapses, others stay', () => {
  const flag = (finding: Finding, reviewer: Flagged['reviewer']): Flagged => ({
    ...finding,
    reviewer,
  });

  expect(similarTitle(SQLI.title, SQLI_AGAIN.title)).toBe(true);
  expect(similarTitle(SQLI.title, QUADRATIC.title)).toBe(false);

  // Order-independent severity: the low-severity duplicate arrives FIRST and
  // is still upgraded to the security reviewer's high-severity reading.
  const merged = mergeFindings([
    flag(SQLI_AGAIN, 'style'),
    flag(QUADRATIC, 'performance'),
    flag(SQLI, 'security'),
  ]);
  expect(merged).toHaveLength(2);
  expect(merged[0]).toEqual({ ...SQLI, reviewers: ['style', 'security'] });

  // Same title on a different line is a different issue — never collapsed.
  const apart = mergeFindings([flag(SQLI, 'security'), flag({ ...SQLI, line: 99 }, 'style')]);
  expect(apart).toHaveLength(2);
});
