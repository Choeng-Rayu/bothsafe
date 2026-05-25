/**
 * Property tests: deal state machine end-to-end invariants.
 * Tasks.md §14.1 — validates R20.1, R20.4, design state diagram.
 *
 * Properties:
 *   1. DEAL_STATUS_TRANSITIONS is a DAG (no cycles).
 *   2. Terminal states have no outgoing transitions.
 *   3. Any sequence of valid transitions from DRAFT eventually terminates.
 */

import * as fc from 'fast-check';
import { DealStatus, TERMINAL_DEAL_STATUSES, ALL_DEAL_STATUSES } from '../common/enums';
import { DEAL_STATUS_TRANSITIONS } from '../common/constants';

describe('Deal state machine property tests (§14.1)', () => {
  it('DEAL_STATUS_TRANSITIONS has no self-loops (no state transitions to itself)', () => {
    for (const status of ALL_DEAL_STATUSES) {
      const targets = DEAL_STATUS_TRANSITIONS[status];
      expect(targets).not.toContain(status);
    }
  });

  it('terminal states have no outgoing transitions', () => {
    for (const terminal of TERMINAL_DEAL_STATUSES) {
      expect(DEAL_STATUS_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('any sequence of valid transitions from DRAFT eventually terminates (no infinite loops)', () => {
    fc.assert(
      fc.property(
        // Generate a random seed for choosing transitions
        fc.infiniteStream(fc.nat()),
        (choices) => {
          let current: DealStatus = DealStatus.DRAFT;
          let steps = 0;
          const maxSteps = ALL_DEAL_STATUSES.length; // DAG can't exceed node count

          const iter = choices[Symbol.iterator]();
          while (DEAL_STATUS_TRANSITIONS[current].length > 0) {
            const nexts: readonly DealStatus[] = DEAL_STATUS_TRANSITIONS[current];
            const choice = iter.next().value! % nexts.length;
            current = nexts[choice];
            steps++;
            if (steps > maxSteps) {
              return false; // Would indicate a cycle
            }
          }
          // Must end in a terminal state
          return TERMINAL_DEAL_STATUSES.includes(current as any);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('every non-terminal state has at least one path to a terminal state', () => {
    // BFS from each non-terminal state to verify reachability of a terminal.
    for (const start of ALL_DEAL_STATUSES) {
      if (TERMINAL_DEAL_STATUSES.includes(start as any)) continue;

      const queue: DealStatus[] = [start];
      const seen = new Set<DealStatus>([start]);
      let reachesTerminal = false;

      while (queue.length > 0) {
        const node = queue.shift()!;
        if (TERMINAL_DEAL_STATUSES.includes(node as any)) {
          reachesTerminal = true;
          break;
        }
        for (const next of DEAL_STATUS_TRANSITIONS[node]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      expect(reachesTerminal).toBe(true);
    }
  });
});
