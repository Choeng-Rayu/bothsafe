import { StorageService } from './storage.service';

describe('StorageService — MIME and size validation', () => {
  let service: StorageService;

  beforeEach(() => {
    service = new (StorageService as any)({
      get: (key: string, def: any) => def,
    });
  });

  describe('validateMime', () => {
    it('accepts image/jpeg', () => {
      expect(service.validateMime('image/jpeg')).toBe(true);
    });

    it('accepts image/png', () => {
      expect(service.validateMime('image/png')).toBe(true);
    });

    it('accepts image/webp', () => {
      expect(service.validateMime('image/webp')).toBe(true);
    });

    it('rejects application/pdf', () => {
      expect(service.validateMime('application/pdf')).toBe(false);
    });

    it('rejects text/plain', () => {
      expect(service.validateMime('text/plain')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(service.validateMime('')).toBe(false);
    });

    it('rejects image/svg+xml', () => {
      expect(service.validateMime('image/svg+xml')).toBe(false);
    });
  });

  describe('validateSize', () => {
    it('accepts 1 byte', () => {
      expect(service.validateSize(1)).toBe(true);
    });

    it('accepts exactly 10MB', () => {
      expect(service.validateSize(10 * 1024 * 1024)).toBe(true);
    });

    it('rejects 0 bytes', () => {
      expect(service.validateSize(0)).toBe(false);
    });

    it('rejects negative size', () => {
      expect(service.validateSize(-1)).toBe(false);
    });

    it('rejects over 10MB', () => {
      expect(service.validateSize(10 * 1024 * 1024 + 1)).toBe(false);
    });
  });

  describe('signUpload', () => {
    it('generates object_key with correct format', async () => {
      const result = await service.signUpload('user123', {
        kind: 'payment_receipt',
        mime: 'image/png',
        size: 5000,
      });

      expect(result.object_key).toMatch(/^payment_receipt\/user123\/\d+-[a-f0-9]{16}\.png$/);
      expect(result.put_url).toContain('bothsafe');
      expect(result.expires_at).toBeDefined();
    });

    it('uses correct extension for jpeg', async () => {
      const result = await service.signUpload('u1', {
        kind: 'shipping',
        mime: 'image/jpeg',
        size: 1000,
      });

      expect(result.object_key).toMatch(/\.jpg$/);
    });

    it('uses correct extension for webp', async () => {
      const result = await service.signUpload('u1', {
        kind: 'dispute',
        mime: 'image/webp',
        size: 1000,
      });

      expect(result.object_key).toMatch(/\.webp$/);
    });
  });
});
