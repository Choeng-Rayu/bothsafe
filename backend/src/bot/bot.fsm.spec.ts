import { BotState, VALID_TRANSITIONS, isValidTransition } from './bot.states';

describe('Bot FSM transitions (property test)', () => {
  const ALL_STATES = Object.values(BotState);

  it('FSM closure — only defined states are reachable from valid transitions', () => {
    for (const from of ALL_STATES) {
      const targets = VALID_TRANSITIONS[from];
      for (const to of targets) {
        expect(ALL_STATES).toContain(to);
      }
    }
  });

  it('/cancel from any non-IDLE state transitions to IDLE', () => {
    for (const state of ALL_STATES) {
      if (state === BotState.IDLE) continue;
      // Every non-IDLE state must allow transition to IDLE (cancel)
      expect(isValidTransition(state, BotState.IDLE)).toBe(true);
    }
  });

  it('IDLE cannot transition to itself', () => {
    expect(isValidTransition(BotState.IDLE, BotState.IDLE)).toBe(false);
  });

  it('valid forward transitions are accepted', () => {
    expect(isValidTransition(BotState.IDLE, BotState.COLLECTING_ROLE)).toBe(true);
    expect(isValidTransition(BotState.COLLECTING_ROLE, BotState.COLLECTING_TITLE)).toBe(true);
    expect(isValidTransition(BotState.COLLECTING_TITLE, BotState.COLLECTING_AMOUNT)).toBe(true);
    expect(isValidTransition(BotState.COLLECTING_AMOUNT, BotState.COLLECTING_CURRENCY)).toBe(true);
    expect(isValidTransition(BotState.COLLECTING_CURRENCY, BotState.CONFIRMING)).toBe(true);
    expect(isValidTransition(BotState.CONFIRMING, BotState.IDLE)).toBe(true);
  });

  it('invalid transitions are rejected', () => {
    expect(isValidTransition(BotState.IDLE, BotState.COLLECTING_TITLE)).toBe(false);
    expect(isValidTransition(BotState.IDLE, BotState.CONFIRMING)).toBe(false);
    expect(isValidTransition(BotState.COLLECTING_ROLE, BotState.CONFIRMING)).toBe(false);
    expect(isValidTransition(BotState.COLLECTING_AMOUNT, BotState.COLLECTING_ROLE)).toBe(false);
    expect(isValidTransition(BotState.CONFIRMING, BotState.COLLECTING_TITLE)).toBe(false);
  });

  it('property: random walk through valid transitions always stays in defined states', () => {
    // Simulate 100 random walks
    for (let i = 0; i < 100; i++) {
      let current: BotState = BotState.IDLE;
      for (let step = 0; step < 20; step++) {
        const targets: readonly BotState[] = VALID_TRANSITIONS[current];
        if (targets.length === 0) break;
        const next: BotState = targets[Math.floor(Math.random() * targets.length)];
        expect(ALL_STATES).toContain(next);
        expect(isValidTransition(current, next)).toBe(true);
        current = next;
      }
    }
  });
});
