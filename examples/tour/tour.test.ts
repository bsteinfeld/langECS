// Deterministic, zero-network: build the tour world, seed it, and assert every
// exhibit the Learn tab points at ends in its expected state.

import { Score, Verdict } from '@langecs/eval';
import { RenderedPrompt } from '@langecs/stdlib';
import { describe, expect, it } from 'vitest';
import { buildTourWorld, Chat, seedTour, WaitingReply } from './world';

describe('tour world', () => {
  it('seeds greeter, support, eval case, and bench report', async () => {
    const { world, refs } = buildTourWorld();
    await seedTour(world, refs);

    // greeter: replied and is quiescent (WaitingReply removed)
    const chat = refs.greeter.get(Chat);
    expect(chat?.at(-1)?.role).toBe('assistant');
    expect(refs.greeter.has(WaitingReply)).toBe(false);

    // support: prompt resolved with the injected vars
    const rendered = refs.support.get(RenderedPrompt);
    expect(rendered).toContain('Ada');
    expect(rendered).toContain('getting started with LangECS');

    // eval case: scored and judged a pass
    expect(refs.evalCase.get(Score)).toBe(1);
    expect(refs.evalCase.get(Verdict)).toBe('pass');

    // bench report: present on its own entity, two candidates
    const report = world
      .snapshot()
      .entities.flatMap((e) => Object.entries(e.components))
      .find(([name]) => name === 'bench:ComparisonReport')?.[1] as
      | { candidates: unknown[] }
      | undefined;
    expect(report?.candidates).toHaveLength(2);
  });
});
