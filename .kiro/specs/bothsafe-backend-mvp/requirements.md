# Requirements Document: BothSafe Backend MVP

## Introduction

BothSafe is an escrow-based payment protection platform for Cambodia's social commerce ecosystem. The backend is a NestJS API that manages the complete Deal Room lifecycle, from creation through payment escrow, shipping verification, and dispute resolution. The system supports anonymous participant authentication, multi-language support (km, en, zh), and manual admin operations for payment verification and fund release.

The backend serves three primary clients: the Next.js web application, the integrated Telegram bot module, and the admin dashboard. All business logic, state transitions, and data integrity rules are enforced at the backend layer.

## Glossary

- **Deal_Room**: A protected transaction workspace containing product information, participant details, payment status, and escrow flow state
- **Participant**: A buyer or seller involved in a Deal Room transaction
- **Creator**: The participant who initiates the Deal Room (can be buyer or seller)
- **Counterparty**: The participant who joins an existing Deal Room via invite link
- **Escrow**: Temporary holding of buyer payment by BothSafe until delivery confirmation
- **Backend_API**: The NestJS REST API service that enforces all business rules
- **Status_Engine**: The state machine that manages valid Deal Room status transitions
- **Access_Token**: A secure token that grants participant access to their Deal Room
- **Invite_Token**: A one-time token that allows the counterparty to join a Deal Room
- **Admin**: A privileged user who manually verifies payments and releases funds
- **Ledger**: An append-only financial record system tracking all money movements
- **Payment_Proof**: Evidence uploaded by buyer showing payment to BothSafe
- **Shipping_Proof**: Evidence uploaded by seller showing product delivery
- **Audit_Log**: Immutable record of all critical actions in the system
- **KHQR**: Cambodia's Bakong QR payment system
- **Public_ID**: A short, shareable identifier for a Deal Room (used in URLs)
- **Missing_Fields_Calculator**: A service that determines which required fields are incomplete
- **Allowed_Actions**: A list of operations the current participant can perform based on deal state and role

## Requirements

### Requirement 1: Deal Room Creation

**User Story:** As a buyer or seller, I want to create a Deal Room from the web or Telegram, so that I can initiate a protected transaction.

#### Acceptance Criteria

1. WHEN a participant submits a deal creation request, THE Backend_API SHALL create a Deal_Room with status DRAFT
2. THE Backend_API SHALL generate a unique Public_ID for the Deal_Room
3. THE Backend_API SHALL generate a secure Invite_Token for counterparty joining
4. THE Backend_API SHALL generate a secure Access_Token for the Creator
5. THE Backend_API SHALL store the creator_role (buyer or seller) and source (web or telegram)
6. THE Backend_API SHALL return the Public_ID, creator access URL, invite URL, and missing_fields list
7. WHEN the Deal_Room has sufficient information for sharing, THE Backend_API SHALL transition status to AWAITING_COUNTERPARTY
8. THE Backend_API SHALL hash all Access_Tokens before storing in the database
9. FOR ALL Deal_Room creation requests with identical input data submitted within 1 second, THE Backend_API SHALL create distinct Deal_Rooms with unique Public_IDs (idempotency is NOT enforced for creation)

### Requirement 2: Counterparty Joining

**User Story:** As a counterparty, I want to join a Deal Room using an invite link, so that I can participate in the transaction.

#### Acceptance Criteria

1. WHEN a participant submits a join request with a valid Invite_Token, THE Backend_API SHALL create a Participant record with the counterparty role
2. THE Backend_API SHALL generate a secure Access_Token for the counterparty
3. THE Backend_API SHALL invalidate the Invite_Token after successful join
4. WHEN both buyer and seller Participants exist, THE Backend_API SHALL transition Deal_Room status to AWAITING_BOTH_APPROVAL
5. IF the Invite_Token is invalid or expired, THEN THE Backend_API SHALL return error message_key "invite.invalid_or_expired"
6. THE Backend_API SHALL prevent duplicate joins using the same Invite_Token
7. THE Backend_API SHALL automatically assign the counterparty role based on the Creator role (if creator is buyer, counterparty is seller)
8. WHEN a user opens a Deal_Room URL with a valid Invite_Token before joining, THE Backend_API SHALL allow a redacted preview through GET /v1/deals/:publicId?invite={inviteToken}
9. THE redacted preview SHALL include only join-safe fields: public_id, status, creator_role, counterparty_role, product summary, amount, currency, missing_fields, and allowed_actions limited to join
10. THE redacted preview SHALL exclude seller payout details, access tokens, payment proofs, shipping proofs, dispute evidence, admin notes, and private participant contact fields
11. IF a join request includes a role that does not match the automatically assigned counterparty role, THEN THE Backend_API SHALL reject it with message_key "deal.role_conflict"

### Requirement 3: Deal Information Updates

**User Story:** As a participant, I want to update deal sections (product, participant, delivery, payout), so that I can complete the required information.

#### Acceptance Criteria

1. WHEN a buyer updates buyer participant information, THE Backend_API SHALL save the changes
2. WHEN a seller updates seller participant information, THE Backend_API SHALL save the changes
3. WHEN a seller updates payout information, THE Backend_API SHALL save the changes
4. WHEN either participant updates product information before both approvals, THE Backend_API SHALL save the changes
5. WHEN either participant updates delivery information before both approvals, THE Backend_API SHALL save the changes
6. IF a participant attempts to update locked fields after payment verification, THEN THE Backend_API SHALL reject the request with message_key "deal.fields_locked_after_payment"
7. THE Backend_API SHALL prevent price updates after both participants have approved
8. THE Backend_API SHALL prevent seller payout KHQR updates after payment proof upload
9. AFTER each update, THE Backend_API SHALL recalculate and return the missing_fields list

### Requirement 4: Missing Fields Calculation

**User Story:** As a participant, I want to see which required fields are missing, so that I know what information to provide before approval.

#### Acceptance Criteria

1. WHEN a Deal_Room is retrieved, THE Missing_Fields_Calculator SHALL identify all incomplete required fields
2. THE Backend_API SHALL return missing_fields as an array of field identifiers
3. THE Missing_Fields_Calculator SHALL check for: product_title, product_type, amount, buyer_name, seller_name, seller_payout_khqr
4. WHEN all required fields are complete and both participants have approved, THE Missing_Fields_Calculator SHALL return an empty array
5. THE Backend_API SHALL include missing_fields in every Deal_Room response

### Requirement 5: Deal Approval

**User Story:** As a participant, I want to approve the deal terms, so that we can proceed to payment.

#### Acceptance Criteria

1. WHEN a participant submits approval, THE Backend_API SHALL record the approval timestamp for that Participant
2. WHEN both buyer and seller have approved AND all required fields are complete, THE Backend_API SHALL transition Deal_Room status to READY_FOR_PAYMENT
3. IF required fields are missing when both approve, THEN THE Backend_API SHALL keep status as AWAITING_BOTH_APPROVAL
4. THE Backend_API SHALL prevent approval if the participant's own required fields are incomplete
5. THE Backend_API SHALL create an Audit_Log entry for each approval action

### Requirement 6: Status Transition Engine

**User Story:** As the system, I want to enforce valid status transitions, so that Deal Rooms cannot enter invalid states.

#### Acceptance Criteria

1. THE Status_Engine SHALL only allow transitions defined in the valid transition map
2. IF an invalid transition is attempted, THEN THE Status_Engine SHALL reject it with message_key "deal.invalid_status_transition"
3. THE Status_Engine SHALL enforce the sequence: DRAFT → AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL → READY_FOR_PAYMENT → PAYMENT_PENDING_VERIFICATION → PAID_ESCROWED → SELLER_PREPARING → SHIPPED → BUYER_CONFIRMED → RELEASE_PENDING → RELEASED
4. THE Status_Engine SHALL allow transition to DISPUTED from PAYMENT_PENDING_VERIFICATION, PAID_ESCROWED, SELLER_PREPARING, or SHIPPED
5. THE Status_Engine SHALL allow transition to CANCELLED from DRAFT, AWAITING_COUNTERPARTY, or AWAITING_BOTH_APPROVAL
6. THE Status_Engine SHALL allow transition to REFUNDED from DISPUTED or RELEASE_PENDING (admin action only)
7. FOR ALL status transitions, THE Status_Engine SHALL validate preconditions before allowing the transition

### Requirement 7: Payment Proof Upload

**User Story:** As a buyer, I want to upload payment proof, so that the admin can verify my payment to BothSafe.

#### Acceptance Criteria

1. WHEN a buyer uploads payment proof in READY_FOR_PAYMENT status, THE Backend_API SHALL store the proof image URL and payment details
2. THE Backend_API SHALL transition Deal_Room status to PAYMENT_PENDING_VERIFICATION
3. THE Backend_API SHALL validate that the uploaded file is an image (JPEG, PNG, or WebP)
4. THE Backend_API SHALL validate that the file size does not exceed 10MB
5. IF the Deal_Room is not in READY_FOR_PAYMENT status, THEN THE Backend_API SHALL reject the upload with message_key "payment.not_ready_for_payment"
6. THE Backend_API SHALL create an Audit_Log entry for the payment proof upload
7. THE Backend_API SHALL emit a PAYMENT_PROOF_UPLOADED notification event

### Requirement 8: Admin Payment Verification

**User Story:** As an admin, I want to verify or reject payment proofs, so that I can confirm escrow receipt before allowing the deal to proceed.

#### Acceptance Criteria

1. WHEN an admin verifies a payment proof, THE Backend_API SHALL transition Deal_Room status to PAID_ESCROWED then SELLER_PREPARING
2. WHEN an admin verifies a payment proof, THE Backend_API SHALL create Ledger entries: ESCROW_RECEIVED and PLATFORM_FEE_RESERVED
3. WHEN an admin rejects a payment proof, THE Backend_API SHALL transition Deal_Room status back to READY_FOR_PAYMENT
4. WHEN an admin rejects a payment proof, THE Backend_API SHALL store the rejection reason
5. THE Backend_API SHALL prevent non-admin users from accessing payment verification endpoints
6. THE Backend_API SHALL create an Audit_Log entry recording the admin user, action, and timestamp
7. THE Backend_API SHALL emit PAYMENT_VERIFIED or PAYMENT_REJECTED notification events
8. IF the payment proof is already verified, THEN THE Backend_API SHALL reject duplicate verification with message_key "payment.already_verified"

### Requirement 9: Shipping Proof Upload

**User Story:** As a seller, I want to upload shipping proof, so that the buyer knows the product has been sent.

#### Acceptance Criteria

1. WHEN a seller uploads shipping proof in PAID_ESCROWED or SELLER_PREPARING status, THE Backend_API SHALL store the shipping details
2. THE Backend_API SHALL transition Deal_Room status to SHIPPED
3. THE Backend_API SHALL accept optional fields: delivery_company, tracking_number, package_photo, delivery_receipt
4. IF the Deal_Room is not in PAID_ESCROWED or SELLER_PREPARING status, THEN THE Backend_API SHALL reject the upload with message_key "shipping.payment_not_verified"
5. THE Backend_API SHALL prevent non-seller participants from uploading shipping proof
6. THE Backend_API SHALL create an Audit_Log entry for the shipping proof upload
7. THE Backend_API SHALL emit a SHIPPING_UPLOADED notification event

### Requirement 10: Buyer Delivery Confirmation

**User Story:** As a buyer, I want to confirm that I received the product, so that the seller can be paid.

#### Acceptance Criteria

1. WHEN a buyer confirms delivery in SHIPPED status, THE Backend_API SHALL transition Deal_Room status to BUYER_CONFIRMED
2. THE Backend_API SHALL then transition Deal_Room status to RELEASE_PENDING
3. THE Backend_API SHALL create a Ledger entry with type SELLER_PAYOUT_PENDING
4. IF the Deal_Room is not in SHIPPED status, THEN THE Backend_API SHALL reject the confirmation with message_key "confirmation.not_shipped"
5. THE Backend_API SHALL prevent non-buyer participants from confirming delivery
6. THE Backend_API SHALL create an Audit_Log entry for the confirmation
7. THE Backend_API SHALL emit a BUYER_CONFIRMED notification event

### Requirement 11: Dispute Creation

**User Story:** As a participant, I want to open a dispute, so that an admin can resolve issues with the transaction.

#### Acceptance Criteria

1. WHEN a participant opens a dispute, THE Backend_API SHALL create a Dispute record with status "open"
2. THE Backend_API SHALL transition Deal_Room status to DISPUTED
3. THE Backend_API SHALL accept dispute reasons: ITEM_NOT_RECEIVED, WRONG_ITEM, DAMAGED_ITEM, FAKE_ITEM, PAYMENT_PROBLEM, OTHER
4. THE Backend_API SHALL allow disputes from PAYMENT_PENDING_VERIFICATION, PAID_ESCROWED, SELLER_PREPARING, or SHIPPED statuses
5. THE Backend_API SHALL store the dispute message and optional evidence file URLs
6. THE Backend_API SHALL record which participant (buyer or seller) opened the dispute
7. THE Backend_API SHALL create an Audit_Log entry for the dispute creation
8. THE Backend_API SHALL emit a DISPUTE_OPENED notification event
9. WHEN a Deal_Room is in DISPUTED status, THE Backend_API SHALL prevent normal buyer confirmation flow

### Requirement 12: Admin Dispute Resolution

**User Story:** As an admin, I want to resolve disputes by releasing payment to seller or refunding buyer, so that disputed transactions can be concluded.

#### Acceptance Criteria

1. WHEN an admin resolves a dispute with "release" decision, THE Backend_API SHALL transition Deal_Room status to RELEASE_PENDING
2. WHEN an admin resolves a dispute with "refund" decision, THE Backend_API SHALL transition Deal_Room status to REFUNDED
3. WHEN an admin resolves a dispute with "refund" decision, THE Backend_API SHALL create Ledger entries: BUYER_REFUND_PENDING and BUYER_REFUND_SENT
4. THE Backend_API SHALL update the Dispute status to "resolved_release" or "resolved_refund"
5. THE Backend_API SHALL store the admin's resolution note
6. THE Backend_API SHALL prevent non-admin users from resolving disputes
7. THE Backend_API SHALL create an Audit_Log entry recording the admin user, decision, and timestamp

### Requirement 13: Admin Payment Release

**User Story:** As an admin, I want to manually release payment to the seller, so that the seller receives their payout after successful delivery.

#### Acceptance Criteria

1. WHEN an admin releases payment in RELEASE_PENDING status, THE Backend_API SHALL transition Deal_Room status to RELEASED
2. THE Backend_API SHALL create Ledger entries: SELLER_PAYOUT_SENT
3. THE Backend_API SHALL store the payout reference identifier
4. IF the Deal_Room is not in RELEASE_PENDING status, THEN THE Backend_API SHALL reject the release with message_key "admin.not_ready_for_release"
5. THE Backend_API SHALL prevent non-admin users from releasing payments
6. THE Backend_API SHALL create an Audit_Log entry recording the admin user, payout reference, and timestamp
7. THE Backend_API SHALL emit a PAYOUT_RELEASED notification event
8. IF the payment has already been released, THEN THE Backend_API SHALL reject duplicate release with message_key "admin.already_released"

### Requirement 14: Admin Payment Refund

**User Story:** As an admin, I want to manually refund payment to the buyer, so that the buyer receives their money back when appropriate.

#### Acceptance Criteria

1. WHEN an admin refunds payment, THE Backend_API SHALL transition Deal_Room status to REFUNDED
2. THE Backend_API SHALL create Ledger entries: BUYER_REFUND_PENDING and BUYER_REFUND_SENT
3. THE Backend_API SHALL store the refund reference identifier
4. THE Backend_API SHALL allow refunds from DISPUTED or RELEASE_PENDING statuses
5. THE Backend_API SHALL prevent non-admin users from issuing refunds
6. THE Backend_API SHALL create an Audit_Log entry recording the admin user, refund reference, and timestamp
7. THE Backend_API SHALL emit a REFUND_COMPLETED notification event
8. IF the payment has already been refunded, THEN THE Backend_API SHALL reject duplicate refund with message_key "admin.already_refunded"

### Requirement 15: Ledger System

**User Story:** As the system, I want to maintain an append-only ledger of all financial transactions, so that money movements can be audited and reconciled.

#### Acceptance Criteria

1. THE Ledger SHALL record entries with types: ESCROW_RECEIVED, PLATFORM_FEE_RESERVED, SELLER_PAYOUT_PENDING, SELLER_PAYOUT_SENT, BUYER_REFUND_PENDING, BUYER_REFUND_SENT, ADJUSTMENT
2. WHEN payment is verified, THE Ledger SHALL create an ESCROW_RECEIVED entry with the full payment amount
3. WHEN payment is verified, THE Ledger SHALL create a PLATFORM_FEE_RESERVED entry with the calculated fee amount
4. WHEN buyer confirms delivery, THE Ledger SHALL create a SELLER_PAYOUT_PENDING entry with the net seller amount
5. WHEN admin releases payment, THE Ledger SHALL create a SELLER_PAYOUT_SENT entry
6. WHEN admin refunds payment, THE Ledger SHALL create BUYER_REFUND_PENDING and BUYER_REFUND_SENT entries
7. THE Ledger SHALL never delete or modify existing entries (append-only)
8. FOR ALL Deal_Rooms, THE Ledger SHALL allow calculation of total escrow received, fees reserved, and payouts sent

### Requirement 16: Authentication and Authorization

**User Story:** As the system, I want to authenticate participants and admins securely, so that only authorized users can access their Deal Rooms and admin functions.

#### Acceptance Criteria

1. WHEN a participant accesses a Deal_Room, THE Backend_API SHALL validate their Access_Token
2. THE Backend_API SHALL hash Access_Tokens using a secure one-way hash before storage
3. THE Backend_API SHALL prevent participants from accessing Deal_Rooms they are not part of
4. WHEN an admin accesses admin endpoints, THE Backend_API SHALL validate their admin JWT token
5. THE Backend_API SHALL prevent non-admin users from accessing admin-only endpoints
6. IF an Access_Token is invalid, THEN THE Backend_API SHALL return error message_key "auth.invalid_token"
7. THE Backend_API SHALL support optional user login for participants who want persistent accounts
8. THE Backend_API SHALL allow anonymous participants to access Deal Rooms using only their Access_Token
9. THE Backend_API SHALL accept participant Access_Tokens through the X-Access-Token header or the initial access query parameter, while reserving Authorization: Bearer for admin JWT authentication

### Requirement 17: Notification System

**User Story:** As a participant, I want to receive notifications about deal events, so that I stay informed about transaction progress.

#### Acceptance Criteria

1. WHEN a notification event occurs, THE Backend_API SHALL create a notification record
2. THE Backend_API SHALL emit notification events: COUNTERPARTY_JOINED, DEAL_UPDATED, BOTH_APPROVED, PAYMENT_PROOF_UPLOADED, PAYMENT_VERIFIED, PAYMENT_REJECTED, SELLER_SHOULD_SHIP, SHIPPING_UPLOADED, BUYER_CONFIRMED, DISPUTE_OPENED, PAYOUT_RELEASED, REFUND_COMPLETED
3. WHEN a participant has a telegram_chat_id, THE Backend_API SHALL send notifications via Telegram
4. THE Backend_API SHALL store notification records for in-app timeline display
5. IF Telegram notification delivery fails, THEN THE Backend_API SHALL log the failure but not rollback the Deal_Room status change
6. THE Backend_API SHALL include the Deal_Room Public_ID and a deep link in all notifications
7. THE Backend_API SHALL send notifications in the participant's preferred language (km, en, or zh)

### Requirement 18: File Storage

**User Story:** As a participant, I want to upload images securely, so that I can provide payment proof, shipping proof, and dispute evidence.

#### Acceptance Criteria

1. WHEN a participant uploads a file, THE Backend_API SHALL validate the file type (JPEG, PNG, WebP)
2. WHEN a participant uploads a file, THE Backend_API SHALL validate the file size (maximum 10MB)
3. THE Backend_API SHALL store files in MinIO object storage running in the project Docker setup
4. THE Backend_API SHALL generate signed URLs for accessing sensitive files (payment proofs, dispute evidence)
5. THE Backend_API SHALL prevent public access to payment proof and dispute evidence files
6. THE Backend_API SHALL allow product images to be publicly accessible
7. IF an uploaded file is not a valid image type, THEN THE Backend_API SHALL reject it with message_key "file.invalid_type"
8. THE Backend_API SHALL store file metadata (original filename, size, upload timestamp) in the database

### Requirement 19: Audit Logging

**User Story:** As an admin, I want to see a complete audit trail of all critical actions, so that I can investigate issues and ensure accountability.

#### Acceptance Criteria

1. THE Backend_API SHALL create Audit_Log entries for: deal creation, participant join, approval, payment proof upload, payment verification, payment rejection, shipping upload, buyer confirmation, dispute creation, dispute resolution, payment release, refund
2. THE Audit_Log SHALL record: action type, actor (participant or admin), Deal_Room ID, timestamp, and relevant metadata
3. THE Backend_API SHALL make Audit_Log entries immutable (no updates or deletes)
4. THE Backend_API SHALL allow admins to query Audit_Log entries by Deal_Room ID
5. THE Backend_API SHALL allow admins to query Audit_Log entries by date range
6. THE Backend_API SHALL include Audit_Log entries in the Deal_Room timeline response

### Requirement 20: Multi-Language Support

**User Story:** As a participant, I want to use the system in my preferred language (Khmer, English, or Chinese), so that I can understand the interface.

#### Acceptance Criteria

1. THE Backend_API SHALL store each participant's preferred language (km, en, or zh)
2. THE Backend_API SHALL return message_key identifiers instead of hardcoded text in all responses
3. THE Backend_API SHALL send notifications in the participant's preferred language
4. THE Backend_API SHALL support language preference in deal creation and participant join requests
5. THE Backend_API SHALL default to English (en) if no language preference is specified

### Requirement 21: Rate Limiting and Security

**User Story:** As the system, I want to prevent abuse and attacks, so that the platform remains secure and available.

#### Acceptance Criteria

1. THE Backend_API SHALL rate-limit deal creation to 5 requests per IP address per minute
2. THE Backend_API SHALL rate-limit payment proof uploads to 3 requests per Deal_Room per hour
3. THE Backend_API SHALL rate-limit admin login attempts to 5 attempts per IP address per 15 minutes
4. THE Backend_API SHALL sanitize all text inputs to prevent XSS attacks
5. THE Backend_API SHALL validate all request DTOs using class-validator
6. THE Backend_API SHALL configure CORS to allow only the configured frontend domain
7. THE Backend_API SHALL never log raw Access_Tokens or admin passwords
8. THE Backend_API SHALL use parameterized database queries to prevent SQL injection

### Requirement 22: Admin Dashboard API

**User Story:** As an admin, I want to view and manage all deals, so that I can operate the escrow platform.

#### Acceptance Criteria

1. THE Backend_API SHALL provide an endpoint to list all Deal_Rooms with pagination
2. THE Backend_API SHALL allow filtering Deal_Rooms by status
3. THE Backend_API SHALL allow filtering Deal_Rooms by date range
4. THE Backend_API SHALL allow searching Deal_Rooms by Public_ID or participant name
5. THE Backend_API SHALL provide an endpoint to view full Deal_Room details including all proofs and audit logs
6. THE Backend_API SHALL provide endpoints for admin actions: verify payment, reject payment, release payment, refund payment, resolve dispute
7. THE Backend_API SHALL allow admins to add internal notes to Deal_Rooms
8. THE Backend_API SHALL prevent non-admin users from accessing any admin endpoints

### Requirement 23: Allowed Actions Calculation

**User Story:** As a participant, I want to see which actions I can perform, so that I know what to do next.

#### Acceptance Criteria

1. WHEN a Deal_Room is retrieved, THE Backend_API SHALL calculate allowed_actions based on current status and participant role
2. THE Backend_API SHALL include allowed_actions in every Deal_Room response
3. THE Backend_API SHALL return actions such as: "update_product", "update_participant", "approve", "upload_payment_proof", "upload_shipping_proof", "confirm_received", "open_dispute"
4. WHEN a Deal_Room is in READY_FOR_PAYMENT status AND the current user is the buyer, THE Backend_API SHALL include "upload_payment_proof" in allowed_actions
5. WHEN a Deal_Room is in SHIPPED status AND the current user is the buyer, THE Backend_API SHALL include "confirm_received" and "open_dispute" in allowed_actions
6. THE Backend_API SHALL exclude actions that are not valid for the current status or participant role

### Requirement 24: Deal Expiration

**User Story:** As the system, I want to expire inactive deals, so that stale Deal Rooms do not accumulate.

#### Acceptance Criteria

1. WHEN a Deal_Room is created, THE Backend_API SHALL set an expires_at timestamp (default 30 days)
2. THE Backend_API SHALL provide a background job that checks for expired Deal_Rooms
3. WHEN a Deal_Room expires in DRAFT, AWAITING_COUNTERPARTY, or AWAITING_BOTH_APPROVAL status, THE Backend_API SHALL transition it to EXPIRED
4. THE Backend_API SHALL not expire Deal_Rooms that have reached READY_FOR_PAYMENT or later statuses
5. THE Backend_API SHALL allow admins to manually extend the expiration date

### Requirement 25: Telegram Bot Integration

**User Story:** As a Telegram user, I want to create and manage deals through the bot, so that I can use BothSafe without leaving Telegram.

#### Acceptance Criteria

1. THE Backend_API SHALL provide a Telegram bot module that runs within the NestJS process
2. WHEN a user sends /start to the bot, THE Backend_API SHALL store their telegram_chat_id
3. WHEN a user creates a deal via /newdeal, THE Backend_API SHALL call the same Deal creation service used by the web API
4. THE Backend_API SHALL send Deal_Room links to Telegram users with inline keyboard buttons
5. THE Backend_API SHALL send notification messages to participants who have telegram_chat_id
6. THE Backend_API SHALL rate-limit bot deal creation to 3 deals per telegram_chat_id per hour
7. THE Backend_API SHALL never send the Creator Access_Token to the counterparty via Telegram

### Requirement 26: API Versioning

**User Story:** As a developer, I want API versioning, so that future changes do not break existing clients.

#### Acceptance Criteria

1. THE Backend_API SHALL use the /v1 prefix for all API endpoints
2. THE Backend_API SHALL maintain backward compatibility within the v1 API version
3. THE Backend_API SHALL return API version information in response headers

### Requirement 27: Health Check and Monitoring

**User Story:** As an operator, I want to monitor system health, so that I can detect and respond to issues.

#### Acceptance Criteria

1. THE Backend_API SHALL provide a /health endpoint that returns system status
2. THE Backend_API SHALL check database connectivity in the health check
3. THE Backend_API SHALL check file storage connectivity in the health check
4. THE Backend_API SHALL return HTTP 200 when all systems are healthy
5. THE Backend_API SHALL return HTTP 503 when critical systems are unavailable
6. THE Backend_API SHALL include Telegram bot connectivity in the health check when the bot module is enabled

### Requirement 28: Idempotency for Critical Operations

**User Story:** As the system, I want to prevent duplicate critical operations, so that repeated requests do not cause double-processing.

#### Acceptance Criteria

1. WHEN an admin releases payment, THE Backend_API SHALL check if the Deal_Room is already in RELEASED status
2. IF a release is attempted on an already-released Deal_Room, THEN THE Backend_API SHALL return error message_key "admin.already_released" without creating duplicate Ledger entries
3. WHEN an admin refunds payment, THE Backend_API SHALL check if the Deal_Room is already in REFUNDED status
4. IF a refund is attempted on an already-refunded Deal_Room, THEN THE Backend_API SHALL return error message_key "admin.already_refunded" without creating duplicate Ledger entries
5. WHEN a payment proof is verified, THE Backend_API SHALL check if it is already verified
6. IF verification is attempted on an already-verified payment, THEN THE Backend_API SHALL return error message_key "payment.already_verified" without creating duplicate Ledger entries

### Requirement 29: Parser and Serializer for Deal Room State

**User Story:** As a developer, I want to serialize and deserialize Deal Room state, so that I can store and retrieve complex deal data reliably.

#### Acceptance Criteria

1. THE Backend_API SHALL parse incoming Deal_Room JSON payloads into Deal_Room domain objects
2. WHEN parsing fails due to invalid JSON structure, THE Backend_API SHALL return error message_key "parse.invalid_json"
3. THE Backend_API SHALL serialize Deal_Room domain objects into JSON responses
4. THE Backend_API SHALL include a pretty printer that formats Deal_Room JSON with consistent field ordering
5. FOR ALL valid Deal_Room objects, parsing the JSON representation then serializing then parsing again SHALL produce an equivalent object (round-trip property)
6. THE Backend_API SHALL validate that serialized Deal_Room JSON conforms to the API response schema

### Requirement 30: Configuration Management

**User Story:** As an operator, I want to configure system parameters via environment variables, so that I can deploy to different environments without code changes.

#### Acceptance Criteria

1. THE Backend_API SHALL read database connection settings from environment variables
2. THE Backend_API SHALL read MinIO file storage credentials from environment variables
3. THE Backend_API SHALL read Telegram bot token from environment variables
4. THE Backend_API SHALL read CORS allowed origins from environment variables
5. THE Backend_API SHALL read platform fee percentage from environment variables
6. THE Backend_API SHALL read deal expiration days from environment variables
7. THE Backend_API SHALL validate that all required environment variables are present at startup
8. IF required environment variables are missing, THEN THE Backend_API SHALL fail to start with a clear error message
