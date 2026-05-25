import { generateReferenceNote } from '../common/tokens';

const CROCKFORD_REGEX = /^[0-9A-HJKMNP-TV-Z]{16}$/;

describe('Reference_Note allocator', () => {
  describe('format property', () => {
    it('generates 16-char Crockford base32 strings', () => {
      for (let i = 0; i < 1000; i++) {
        const note = generateReferenceNote();
        expect(note).toHaveLength(16);
        expect(note).toMatch(CROCKFORD_REGEX);
      }
    });

    it('rejects I, L, O, U characters', () => {
      for (let i = 0; i < 1000; i++) {
        const note = generateReferenceNote();
        expect(note).not.toMatch(/[ILOU]/);
      }
    });
  });

  describe('uniqueness property', () => {
    it('100k generated notes have no duplicates', () => {
      const notes = new Set<string>();
      for (let i = 0; i < 100_000; i++) {
        notes.add(generateReferenceNote());
      }
      expect(notes.size).toBe(100_000);
    });
  });
});
