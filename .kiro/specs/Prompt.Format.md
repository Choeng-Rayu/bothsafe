

## How to Read and implement project of these Three Files

Follow this order when working on each task:

1. **Read the Task file** to understand what needs to be done.
2. **Cross-reference the Requirements file** using the requirement IDs listed in the task.
   - Example: If a task lists `Requirements: 1.1, 1.2, 1.3`, look up each of those points in the Requirements file.
   - Example of a requirement entry: `1.1 — The AppColors SHALL define a primary token as #009DFF, used for brand accents, active states, and focus borders in both modes.`
3. **Read the Design/UX file** to understand the visual and interaction intent, which helps guide implementation decisions.

## Purpose of Each File

| File | Purpose |
|------|---------|
| **Task** | Defines what to build and which requirement IDs apply |
| **Requirements** | Specifies the exact rules and constraints for each requirement ID |
| **Design/UX** | Clarifies the visual design and user experience to guide implementation |

## Workflow

1. Read the task.
2. Look up the referenced requirement IDs in the Requirements file.
3. Check the Design/UX file for visual context.
4. Implement the code accordingly.
5. **Mark the task complete** by changing `[ ]` → `[x]` once implementation is done.



















Execute task **3.8 Implement `IdempotencyMiddleware` keyed on `Idempotency-Key` header** from the BothSafe Deal Flow spec.

Spec path: `/home/rayu/bothsafe/.kiro/specs/bothsafe-deal-flow/`
Tasks file: `/home/rayu/bothsafe/.kiro/specs/bothsafe-deal-flow/tasks.md`

Read tasks.md, requirements.md, and design.md in that spec folder, then implement task 3.8. Key things to know:
- Backend: `/home/rayu/bothsafe/backend` (NestJS + Prisma + PostgreSQL 16).
- An `IdempotencyKey` Prisma model is planned (not yet migrated — that lives in section 2 work). For now, implement the middleware against the planned model interface; if the model does not yet exist in `schema.prisma`, add the model (id, key, route, request_hash, response_status, response_body Jsonb, created_at, expires_at) and run `npx prisma migrate dev --name add_idempotency_key` from `/home/rayu/bothsafe/backend`.
- Middleware behaviour: only applies on POST/PATCH/PUT; reads `Idempotency-Key` header; computes `request_hash = sha256(method + url + body)`; on first call records pending row; on replay with matching hash returns cached response with status 200/originalStatus; on hash mismatch responds 409 with error envelope.
- TTL: 24 h (configurable). Skip middleware on `GET`, `HEAD`, `OPTIONS`.
- Wire in `AppModule.configure(consumer)` for the relevant routes (apply globally is fine; the middleware no-ops without the header).

Verify with `npm run build` from `/home/rayu/bothsafe/backend`. Do not run destructive Prisma commands; `migrate dev` is fine in dev.