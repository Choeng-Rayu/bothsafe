# Implementation Plan: BothSafe Backend MVP

## Overview

This implementation plan breaks down the BothSafe Backend MVP into discrete coding tasks. The backend is a NestJS TypeScript API that manages the complete Deal Room lifecycle, from creation through payment escrow, shipping verification, and dispute resolution. The system enforces all business logic through a centralized state machine, provides anonymous participant authentication, and integrates with Telegram for notifications.

The implementation follows a layered approach: infrastructure setup, core domain services, API endpoints, integrations, and testing. Each task builds incrementally on previous work, with checkpoints to validate progress.

## Tasks

- [ ] 1. Set up NestJS project infrastructure and core dependencies
  - Install NestJS CLI and create project structure
  - Configure TypeScript with strict mode
  - Install core dependencies: Prisma, class-validator, bcrypt, @nestjs/jwt, @nestjs/throttler
  - Set up environment variable configuration with validation
  - Configure CORS with allowed origins from environment
  - _Requirements: 30_

- [ ] 2. Implement Prisma database layer and schema
  - [ ] 2.1 Create complete Prisma schema with all models
    - Define Deal, Participant, Product, Payment, LedgerEntry, ShippingProof, Dispute, File, AuditLog, Notification, TelegramIdentity, BotConversationState models
    - Add all foreign key relationships and constraints
    - Define enums for DealStatus, ParticipantRole, DisputeReason, LedgerEntryType, AuditAction, NotificationEvent
    - Add database inde es for performance (public_id, status, telegram_chat_id, access_token_hash)
    - Add unique constraints (one product per deal, one buyer/seller per deal)
    - _Requirements: 1, 2, 3, 15, 16, 19, 25_
  
  - [ ] 2.2 Run Prisma migration and create PrismaService
    - Generate and run initial migration
    - Create PrismaService with connection lifecycle management
    - Create global PrismaModule for dependency injection
    - _Requirements: 30_

- [ ] 3. Implement core utility services and constants
  - [ ] 3.1 Create constants file with enums and configuration
    - Define DealStatus enum matching design specification
    - Define all other enums (roles, sources, languages, dispute reasons)
    - Define platform fee percentage and other business constants
    - _Requirements: 1, 6, 20, 30_
  
  - [ ] 3.2 Implement token generation and validation utilities
    - Create generateAccessToken function using crypto.randomBytes
    - Implement bcrypt hashing with cost factor 10
    - Create validateToken function for token comparison
    - _Requirements: 1, 2, 16_
  
  - [ ] 3.3 Implement input sanitization utilities
    - Create sanitizeTe t function to remove null bytes and trim whitespace
    - Create sanitizeFilename function to prevent path traversal
    - _Requirements: 21_
  
  - [ ] 3.4 Create CurrentActor decorator for request conte t
    - E tract participant or admin from request object
    - Make available to controllers via @CurrentActor() decorator
    - _Requirements: 16_

- [ ] 4. Implement global e ception handling and logging
  - [ ] 4.1 Create AllE ceptionsFilter for consistent error responses
    - Return ErrorResponse format with statusCode, message_key, message, errors, timestamp, path, request_id
    - Handle HttpE ception, Prisma errors, and unknown errors
    - Log errors with sanitization (redact sensitive fields)
    - _Requirements: 21_
  
  - [ ] 4.2 Create domain-specific e ception classes
    - InvalidStatusTransitionE ception, MissingFieldsE ception, FieldsLockedE ception
    - PaymentNotReadyE ception, PaymentAlreadyVerifiedE ception
    - InvalidTokenE ception, InviteE piredE ception
    - InvalidFileTypeE ception, FileTooLargeE ception
    - _Requirements: 6, 7, 8, 16, 18, 28_
  
  - [ ] 4.3 Implement LoggingInterceptor for request/response logging
    - Log all incoming requests with method, path, and sanitized body
    - Log response status and duration
    - Generate unique request_id for tracing
    - _Requirements: 19, 21_

- [ ] 5. Implement Authentication Module
  - [ ] 5.1 Create AuthService for token management
    - Implement generateAccessToken with hashing
    - Implement validateAccessToken with bcrypt comparison
    - Implement generateInviteToken with e piration
    - _Requirements: 1, 2, 16_
  
  - [ ] 5.2 Create UserAuthService for optional user login
    - Implement phone/email login (future enhancement, stub for now)
    - Create OAuthStateService for managing OAuth sessions
    - _Requirements: 16_
  
  - [ ] 5.3 Implement AdminGuard for JWT authentication
    - Validate JWT token from Authorization header
    - Verify admin role claim
    - Attach admin payload to request
    - _Requirements: 16, 22_
  
  - [ ] 5.4 Implement DealAccessGuard for participant authentication
    - E tract access token from header or query parameter
    - Validate token against deal participants
    - Attach participant to request
    - _Requirements: 2, 3, 16_
  
  - [ ] 5.5 Create AuthController with admin login endpoint
    - POST /v1/admin/login with email/password validation
    - Generate JWT access token and refresh token
    - Return tokens with e piration
    - _Requirements: 16, 22_

- [ ] 6. Implement Status Engine and Missing Fields Calculator
  - [ ] 6.1 Create StatusEngine class with transition validation
    - Define VALID_TRANSITIONS map with all allowed transitions
    - Implement isValidTransition method
    - Implement checkPreconditions for each transition type
    - Implement transition method with transaction support
    - E ecute side effects (ledger entries, notifications) within transaction
    - _Requirements: 6_
  
  - [ ] 6.2 Create MissingFieldsCalculator class
    - Check for product_title, product_type, amount
    - Check for buyer_name, seller_name
    - Check for seller_payout_khqr
    - Return array of missing field identifiers
    - _Requirements: 4_

- [ ] 7. Implement Audit Logging Service
  - [ ] 7.1 Create AuditService for immutable audit logs
    - Implement createAuditLog method
    - Store action, actor_type, actor_id, deal_id, metadata, ip_address, user_agent, timestamp
    - Implement queryAuditLogs with filters (deal_id, date range, action type)
    - _Requirements: 19_
  
  - [ ] 7.2 Create AuditModule and integrate with other services
    - E port AuditService globally
    - Ensure all critical actions create audit log entries
    - _Requirements: 19_

- [ ] 8. Implement Deal Module - Core Service
  - [ ] 8.1 Create DealsService with deal creation
    - Implement create method accepting CreateDealDto
    - Generate public_id (short, URL-safe identifier)
    - Generate creator access token and invite token
    - Create Deal record with DRAFT status
    - Create creator Participant record
    - Calculate fee_amount and net_seller_amount
    - Transition to AWAITING_COUNTERPARTY if minimum fields present
    - Return public_id, creator_access_url, invite_url, missing_fields
    - _Requirements: 1_
  
  - [ ] 8.2 Implement counterparty join functionality
    - Validate invite token and check e piration
    - Create counterparty Participant record with opposite role
    - Generate counterparty access token
    - Invalidate invite token
    - Transition to AWAITING_BOTH_APPROVAL
    - Emit COUNTERPARTY_JOINED notification
    - Create audit log entry
    - _Requirements: 2_
  
  - [ ] 8.3 Implement deal information update methods
    - updateProduct: validate not locked after payment, save changes
    - updateParticipant: validate role matches current user, save changes
    - updateDelivery: save delivery information
    - updatePayout: validate seller role, save payout KHQR URL
    - Recalculate missing_fields after each update
    - Create audit log entries
    - _Requirements: 3_
  
  - [ ] 8.4 Implement deal approval functionality
    - Record approval timestamp for participant
    - Check if both participants approved and all fields complete
    - Transition to READY_FOR_PAYMENT when conditions met
    - Emit BOTH_APPROVED notification
    - Create audit log entry
    - _Requirements: 5_
  
  - [ ] 8.5 Implement deal retrieval with calculated fields
    - Fetch deal with all relations (participants, product, payments, shipping, disputes)
    - Calculate missing_fields using MissingFieldsCalculator
    - Calculate allowed_actions based on status and current user role
    - Build timeline from notifications and audit logs
    - Return complete DealResponse
    - _Requirements: 4, 23_

- [ ] 9. Implement Deal Module - API Controller
  - [ ] 9.1 Create DealsController with create endpoint
    - POST /v1/deals with CreateDealDto validation
    - Apply rate limiting (5 requests/minute per IP)
    - Return 201 Created with deal response
    - _Requirements: 1, 21_
  
  - [ ] 9.2 Implement deal retrieval endpoint
    - GET /v1/deals/:publicId with DealAccessGuard
    - Return full deal response with calculated fields
    - _Requirements: 4, 23_
  
  - [ ] 9.3 Implement join endpoint
    - POST /v1/deals/:publicId/join with JoinDealDto
    - Validate invite token
    - Return participant_access_url and updated deal
    - _Requirements: 2_
  
  - [ ] 9.4 Implement section update endpoints
    - PATCH /v1/deals/:publicId/sections/product
    - PATCH /v1/deals/:publicId/sections/participant
    - PATCH /v1/deals/:publicId/sections/delivery
    - PATCH /v1/deals/:publicId/sections/payout
    - All require DealAccessGuard
    - _Requirements: 3_
  
  - [ ] 9.5 Implement approval endpoint
    - POST /v1/deals/:publicId/approval with DealAccessGuard
    - Validate approval DTO
    - Return updated deal status
    - _Requirements: 5_

  - [ ] 9.6 Align participant access and invite-preview API behavior
    - Accept participant Access_Token through  -Access-Token and the initial access query parameter
    - Reserve Authorization: Bearer for admin JWT authentication
    - Support GET /v1/deals/:publicId?invite={inviteToken} as a redacted join preview
    - Return only join-safe preview fields and allowed_actions=["join"] for invite actors
    - Validate submitted join role against the server-derived counterparty role
    - _Requirements: 2, 16_

- [ ] 10. Implement Ledger Module
  - [ ] 10.1 Create LedgerService for append-only ledger
    - Implement createEntry method with validation
    - Support entry types: ESCROW_RECEIVED, PLATFORM_FEE_RESERVED, SELLER_PAYOUT_PENDING, SELLER_PAYOUT_SENT, BUYER_REFUND_PENDING, BUYER_REFUND_SENT, ADJUSTMENT
    - Ensure entries are never updated or deleted
    - Implement queryEntries with filters (deal_id, entry_type, date range)
    - _Requirements: 15_
  
  - [ ] 10.2 Create LedgerModule and e port service
    - Make LedgerService available globally
    - _Requirements: 15_

- [ ] 11. Implement Payment Module
  - [ ] 11.1 Create PaymentsService for payment proof management
    - Implement uploadPaymentProof method
    - Validate file type (JPEG, PNG, WebP) and size (ma  10MB)
    - Store payment proof record with admin_status 'pending'
    - Transition deal to PAYMENT_PENDING_VERIFICATION
    - Emit PAYMENT_PROOF_UPLOADED notification
    - Create audit log entry
    - _Requirements: 7, 18_
  
  - [ ] 11.2 Implement admin payment verification
    - Implement verifyPayment method (admin only)
    - Check payment not already verified
    - Create ledger entries: ESCROW_RECEIVED, PLATFORM_FEE_RESERVED
    - Update payment admin_status to 'verified'
    - Transition deal to PAID_ESCROWED then SELLER_PREPARING
    - Emit PAYMENT_VERIFIED and SELLER_SHOULD_SHIP notifications
    - Create audit log entry
    - _Requirements: 8, 15, 28_
  
  - [ ] 11.3 Implement admin payment rejection
    - Implement rejectPayment method (admin only)
    - Store rejection reason
    - Update payment admin_status to 'rejected'
    - Transition deal back to READY_FOR_PAYMENT
    - Emit PAYMENT_REJECTED notification
    - Create audit log entry
    - _Requirements: 8_
  
  - [ ] 11.4 Create PaymentsController with endpoints
    - POST /v1/deals/:publicId/payment-proofs with DealAccessGuard (buyer only)
    - Apply rate limiting (3 requests/hour per deal)
    - Handle multipart file upload
    - _Requirements: 7, 21_

- [ ] 12. Implement Shipping Module
  - [ ] 12.1 Create ShippingService for shipping proof management
    - Implement uploadShippingProof method
    - Validate at least one field provided (tracking, photo, or receipt)
    - Store shipping proof record
    - Transition deal to SHIPPED
    - Emit SHIPPING_UPLOADED notification
    - Create audit log entry
    - _Requirements: 9_
  
  - [ ] 12.2 Create ShippingController with upload endpoint
    - POST /v1/deals/:publicId/shipping-proofs with DealAccessGuard (seller only)
    - Handle multipart file upload for optional photos
    - _Requirements: 9_

- [ ] 13. Implement Confirmation Module
  - [ ] 13.1 Create ConfirmationService for buyer confirmation
    - Implement confirmReceived method
    - Validate deal in SHIPPED status
    - Transition to BUYER_CONFIRMED then RELEASE_PENDING
    - Create ledger entry: SELLER_PAYOUT_PENDING
    - Emit BUYER_CONFIRMED notification
    - Create audit log entry
    - _Requirements: 10, 15_
  
  - [ ] 13.2 Create ConfirmationController with endpoint
    - POST /v1/deals/:publicId/confirm-received with DealAccessGuard (buyer only)
    - _Requirements: 10_

- [ ] 14. Implement Dispute Module
  - [ ] 14.1 Create DisputesService for dispute management
    - Implement openDispute method
    - Validate dispute reason and message
    - Store dispute record with status 'open'
    - Transition deal to DISPUTED
    - Emit DISPUTE_OPENED notification
    - Create audit log entry
    - _Requirements: 11_
  
  - [ ] 14.2 Implement admin dispute resolution
    - Implement resolveDispute method (admin only)
    - Handle 'release' decision: transition to RELEASE_PENDING, create SELLER_PAYOUT_PENDING ledger entry
    - Handle 'refund' decision: transition to REFUNDED, create BUYER_REFUND_PENDING and BUYER_REFUND_SENT ledger entries
    - Update dispute status to 'resolved_release' or 'resolved_refund'
    - Emit appropriate notifications
    - Create audit log entry
    - _Requirements: 12, 15_
  
  - [ ] 14.3 Create DisputesController with endpoints
    - POST /v1/deals/:publicId/disputes with DealAccessGuard
    - Handle multipart file upload for evidence
    - _Requirements: 11_

- [ ] 15. Implement Admin Module
  - [ ] 15.1 Create AdminService for admin operations
    - Implement listDeals with filters (status, date range, search)
    - Implement pagination support
    - Implement getDealDetails with admin-only fields
    - _Requirements: 22_
  
  - [ ] 15.2 Implement admin payment release
    - Implement releasePayment method
    - Validate deal in RELEASE_PENDING status
    - Check not already released (idempotency)
    - Create ledger entry: SELLER_PAYOUT_SENT
    - Transition to RELEASED
    - Emit PAYOUT_RELEASED notification
    - Create audit log entry
    - _Requirements: 13, 28_
  
  - [ ] 15.3 Implement admin payment refund
    - Implement refundPayment method
    - Validate deal in DISPUTED or RELEASE_PENDING status
    - Check not already refunded (idempotency)
    - Create ledger entries: BUYER_REFUND_PENDING, BUYER_REFUND_SENT
    - Transition to REFUNDED
    - Emit REFUND_COMPLETED notification
    - Create audit log entry
    - _Requirements: 14, 28_
  
  - [ ] 15.4 Create AdminController with all admin endpoints
    - GET /v1/admin/deals with AdminGuard
    - GET /v1/admin/deals/:id with AdminGuard
    - POST /v1/admin/payment-proofs/:id/verify with AdminGuard
    - POST /v1/admin/payment-proofs/:id/reject with AdminGuard
    - POST /v1/admin/deals/:id/release with AdminGuard
    - POST /v1/admin/deals/:id/refund with AdminGuard
    - POST /v1/admin/disputes/:id/resolve with AdminGuard
    - _Requirements: 8, 12, 13, 14, 22_

- [ ] 16. Implement File Storage Module
  - [ ] 16.1 Create FilesService for file upload/download
    - Implement validateFile method (type, size, e tension matching)
    - Implement sanitizeFilename to prevent path traversal
    - Implement uploadFile method with MinIO object storage integration
    - Implement generateSignedUrl for secure file access
    - Store file metadata in database
    - _Requirements: 18_
  
  - [ ] 16.2 Create FilesController with upload endpoint
    - POST /v1/files/upload with authentication
    - Handle multipart file upload
    - Return file URL and metadata
    - _Requirements: 18_
  
  - [ ] 16.3 Implement file access control
    - Product images: public access
    - Payment proofs: admin and deal participants only
    - Shipping proofs: admin and deal participants only
    - Dispute evidence: admin and deal participants only
    - _Requirements: 18_

- [ ] 17. Implement Notification Module
  - [ ] 17.1 Create NotificationService for event-based notifications
    - Implement emit method to create notification records
    - Implement dispatchToChannels for async notification delivery
    - Support notification events: COUNTERPARTY_JOINED, DEAL_UPDATED, BOTH_APPROVED, PAYMENT_PROOF_UPLOADED, PAYMENT_VERIFIED, PAYMENT_REJECTED, SELLER_SHOULD_SHIP, SHIPPING_UPLOADED, BUYER_CONFIRMED, DISPUTE_OPENED, PAYOUT_RELEASED, REFUND_COMPLETED
    - Store notifications in database for timeline
    - _Requirements: 17_
  
  - [ ] 17.2 Create NotificationMessageFormatter for multi-language messages
    - Define message templates for km, en, zh languages
    - Implement interpolation for dynamic data
    - _Requirements: 17, 20_
  
  - [ ] 17.3 Implement BotNotifierInterface for Telegram integration
    - Define interface for sending notifications
    - Implement retry logic with e ponential backoff
    - Mark notifications as sent in database
    - Log failures without blocking transactions
    - _Requirements: 17_
  
  - [ ] 17.4 Create NotificationModule and e port service
    - Make NotificationService available globally
    - _Requirements: 17_

- [ ] 18. Implement Telegram Bot Module
  - [ ] 18.1 Create BotTelegramService for Telegram Bot API integration
    - Initialize Telegram bot with token from environment
    - Implement sendMessage method
    - Implement sendNotification method with inline keyboard
    - _Requirements: 25_
  
  - [ ] 18.2 Create BotStateService for conversation state management
    - Store conversation state in database
    - Implement state e piration (10 minutes)
    - Support multi-step flows (deal creation)
    - _Requirements: 25_
  
  - [ ] 18.3 Create BotMessages for localized bot messages
    - Define message templates for km, en, zh
    - Support bot commands: /start, /newdeal, /mydeals, /help
    - _Requirements: 25_
  
  - [ ] 18.4 Create BotUpdate handler for incoming Telegram updates
    - Handle /start command: store telegram_chat_id, show welcome menu
    - Handle /newdeal command: guided deal creation flow
    - Handle /mydeals command: list user's recent deals
    - Handle /help command: e plain escrow concept
    - Call DealsService directly (internal service calls)
    - Apply rate limiting (3 deals per telegram_chat_id per hour)
    - _Requirements: 25_
  
  - [ ] 18.5 Integrate bot with NotificationService
    - Implement BotNotifierInterface in BotTelegramService
    - Send notifications to participants with telegram_chat_id
    - Include inline keyboard with "Open Deal Room" button
    - _Requirements: 17, 25_
  
  - [ ] 18.6 Create BotModule and register with NestJS
    - Configure Telegram bot module
    - Register update handlers
    - _Requirements: 25_

- [ ] 19. Implement rate limiting and security middleware
  - [ ] 19.1 Configure ThrottlerModule for rate limiting
    - Set default limit: 10 requests/minute
    - Configure endpoint-specific limits (deal creation: 5/min, payment upload: 3/hour, admin login: 5/15min)
    - _Requirements: 21_
  
  - [ ] 19.2 Implement CORS configuration
    - Allow only configured frontend and admin domains
    - Enable credentials
    - Allow required headers (Content-Type, Authorization,  -Access-Token)
    - _Requirements: 21_
  
  - [ ] 19.3 Implement request validation pipeline
    - Enable global ValidationPipe with class-validator
    - Whitelist unknown properties
    - Transform payloads to DTO instances
    - _Requirements: 21_

- [ ] 20. Implement health check and monitoring
  - [ ] 20.1 Create HealthController with health check endpoint
    - GET /health endpoint
    - Check database connectivity (Prisma)
    - Check file storage connectivity
    - Check Telegram bot connectivity when BotModule is enabled
    - Return 200 OK when healthy, 503 when unhealthy
    - _Requirements: 27_
  
  - [ ] 20.2 Create HealthModule
    - Use @nestjs/terminus for health checks
    - _Requirements: 27_

- [ ] 21. Implement deal e piration background job
  - [ ] 21.1 Create E pirationService for deal e piration
    - Implement checkE piredDeals method
    - Find deals in DRAFT, AWAITING_COUNTERPARTY, AWAITING_BOTH_APPROVAL with e pires_at < now
    - Transition to E PIRED
    - Create audit log entries
    - _Requirements: 24_
  
  - [ ] 21.2 Schedule e piration job with @nestjs/schedule
    - Run every hour
    - _Requirements: 24_

- [ ] 22. Checkpoint - Core functionality complete
  - All core modules implemented and unit tests passing.

- [ ] 23. Write integration tests for critical flows
  - [ ] 23.1 Write integration tests for buyer-created deal flow
    - Test deal creation with buyer as creator
    - Test seller joining
    - Test both approvals leading to READY_FOR_PAYMENT
    - _Requirements: 1, 2, 5_
  
  - [ ] 23.2 Write integration tests for payment verification flow
    - Test payment proof upload
    - Test admin verification creating ledger entries
    - Test admin rejection returning to READY_FOR_PAYMENT
    - _Requirements: 7, 8, 15_
  
  - [ ] 23.3 Write integration tests for dispute resolution flow
    - Test dispute opening
    - Test admin resolution with release decision
    - Test admin resolution with refund decision
    - Verify ledger entries created correctly
    - _Requirements: 11, 12, 15_
  
  - [ ] 23.4 Write integration tests for complete happy path
    - Test full flow from creation to payment release
    - Verify all status transitions
    - Verify all ledger entries
    - Verify all notifications sent
    - _Requirements: 1, 2, 5, 7, 8, 9, 10, 13, 15, 17_

- [ ] 24. Write unit tests for core services
  - [ ] 24.1 Write unit tests for StatusEngine
    - Test valid transitions allowed
    - Test invalid transitions rejected
    - Test precondition checks
    - _Requirements: 6_
  
  - [ ] 24.2 Write unit tests for MissingFieldsCalculator
    - Test identification of missing product fields
    - Test identification of missing participant fields
    - Test identification of missing payout KHQR
    - Test empty array when all fields complete
    - _Requirements: 4_
  
  - [ ] 24.3 Write unit tests for TokenService
    - Test unique token generation
    - Test secure hashing
    - Test correct token validation
    - Test incorrect token rejection
    - _Requirements: 16_
  
  - [ ] 24.4 Write unit tests for NotificationMessageFormatter
    - Test message formatting in all languages
    - Test data interpolation
    - _Requirements: 17, 20_

- [ ] 25. Write E2E tests for API endpoints
  - [ ] 25.1 Write E2E test for complete buyer-created flow
    - Test POST /v1/deals (buyer creates)
    - Test POST /v1/deals/:publicId/join (seller joins)
    - Test PATCH /v1/deals/:publicId/sections/payout (seller adds KHQR)
    - Test POST /v1/deals/:publicId/approval (both approve)
    - Test POST /v1/deals/:publicId/payment-proofs (buyer uploads)
    - Test POST /v1/admin/payment-proofs/:id/verify (admin verifies)
    - Test POST /v1/deals/:publicId/shipping-proofs (seller ships)
    - Test POST /v1/deals/:publicId/confirm-received (buyer confirms)
    - Test POST /v1/admin/deals/:id/release (admin releases)
    - _Requirements: 1, 2, 3, 5, 7, 8, 9, 10, 13_
  
  - [ ] 25.2 Write E2E test for dispute flow
    - Test POST /v1/deals/:publicId/disputes (open dispute)
    - Test POST /v1/admin/disputes/:id/resolve (admin resolves)
    - _Requirements: 11, 12_
  
  - [ ] 25.3 Write E2E test for admin endpoints
    - Test GET /v1/admin/deals (list with filters)
    - Test GET /v1/admin/deals/:id (get details)
    - _Requirements: 22_

- [ ] 26. Final checkpoint - All tests pass
  - Unit: 284 passed, Integration: 7 passed, E2E: 12 passed.

- [ ] 27. Create database seed script
  - [ ] 27.1 Create seed.ts with sample data
    - Create admin user
    - Create sample deals in various statuses
    - Create sample participants with telegram_chat_id
    - Create sample payments, shipping proofs, disputes
    - _Requirements: 30_

- [ ] 28. Create API documentation
  - [ ] 28.1 Add Swagger/OpenAPI documentation
    - Install @nestjs/swagger
    - Add API decorators to all controllers
    - Generate OpenAPI spec
    - _Requirements: 26_

- [ ] 29. Final integration and deployment preparation
  - [ ] 29.1 Verify all environment variables documented
    - Document required variables in .env.e ample
    - Add validation for required variables at startup
    - _Requirements: 30_
  
  - [ ] 29.2 Run full test suite and verify coverage
    - Unit: 284 passed, Integration: 7 passed, E2E: 12 passed
    - _Requirements: All_
  
  - [ ] 29.3 Test with local MySQL and MinIO Docker containers
    - Dockerfile and docker-compose.yml present with MySQL and MinIO services
    - DOCKER.md documents full deployment workflow
    - _Requirements: 30_

## Notes

- All tasks reference specific requirements for traceability
- The implementation uses TypeScript with NestJS framework
- Database operations use Prisma ORM with MySQL
- Authentication uses bcrypt for token hashing and JWT for admin auth
- File storage integrates with MinIO object storage
- Telegram bot runs inside the NestJS process as a module
- All critical actions create audit log entries
- Notifications are event-driven and support multiple channels
- Rate limiting protects against abuse
- The status engine enforces all valid state transitions
- Ledger entries are append-only for audit compliance
- Integration tests validate database operations and service interactions
- E2E tests validate complete user flows through the HTTP API
- Unit tests focus on pure functions and business logic
