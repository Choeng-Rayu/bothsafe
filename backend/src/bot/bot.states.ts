/**
 * FSM states for the Telegram bot /newdeal conversation flow.
 * Stored as plain TEXT in Postgres (no enum migration needed).
 */
export const BotState = {
  IDLE: 'IDLE',
  COLLECTING_ROLE: 'COLLECTING_ROLE',
  COLLECTING_TITLE: 'COLLECTING_TITLE',
  COLLECTING_AMOUNT: 'COLLECTING_AMOUNT',
  COLLECTING_CURRENCY: 'COLLECTING_CURRENCY',
  CONFIRMING: 'CONFIRMING',
} as const;

export type BotState = (typeof BotState)[keyof typeof BotState];

/** Valid transitions: from → allowed next states */
export const VALID_TRANSITIONS: Record<BotState, readonly BotState[]> = {
  [BotState.IDLE]: [BotState.COLLECTING_ROLE],
  [BotState.COLLECTING_ROLE]: [BotState.COLLECTING_TITLE, BotState.IDLE],
  [BotState.COLLECTING_TITLE]: [BotState.COLLECTING_AMOUNT, BotState.IDLE],
  [BotState.COLLECTING_AMOUNT]: [BotState.COLLECTING_CURRENCY, BotState.IDLE],
  [BotState.COLLECTING_CURRENCY]: [BotState.CONFIRMING, BotState.IDLE],
  [BotState.CONFIRMING]: [BotState.IDLE],
};

export function isValidTransition(from: BotState, to: BotState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
