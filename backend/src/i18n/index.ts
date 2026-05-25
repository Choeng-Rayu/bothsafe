/**
 * Public re-exports for the backend i18n key registry.
 *
 * Consumers import message keys via `import { ERROR_KEYS } from '../i18n'`
 * (or `'src/i18n'` from outside this folder). Keeping this barrel file
 * thin lets us reorganise `keys.ts` later without breaking imports.
 */

export * from './keys';
