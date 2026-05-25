/**
 * Public surface of the audit module.
 *
 * Mirrors the `src/prisma/index.ts` convention so feature modules that need
 * the audit writer can do `import { AuditModule, AuditService } from
 * '../audit';` without reaching past the module boundary.
 */

export { AuditModule } from './audit.module';
export { AuditService } from './audit.service';
export type { NewAuditLogEntry } from './audit.service';
