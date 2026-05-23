# Design Document: BothSafe Backend MVP

## Overview

The BothSafe Backend is a NestJS-based REST API that serves as the single source of truth for the escrow-based payment protection platform. It manages the complete Deal Room lifecycle from creation through payment escrow, shipping verification, and dispute resolution. The backend enforces all business logic, state transitions, and data integrity rules while serving three primary clients: the Next.js web application, the integrated Telegram bot module, and the admin dashboard.

### Key Design Principles

1. **Single Source of Truth**: All business logic resides in the backend; clients are thin presentation layers
2. **State Machine Driven**: Deal Room status transitions are strictly controlled by a centralized state engine
3. **Security First**: Token hashing, rate limiting, input validation, and role-based access control are built-in
4. **Audit Everything**: All critical actions are logged immutably for compliance and debugging
5. **Multi-Channel Support**: Same API serves web, Telegram bot, and admin dashboard with consistent behavior
6. **Manual Operations for MVP**: Admin manually verifies payments and releases funds; automation comes later

### System Context

```mermaid
graph TB
    Web[Next.js Web App]
    Bot[Telegram Bot Module]
    Admin[Admin Dashboard]
    Backend[NestJS Backend API]
    DB[(MySQL Database)]
    Storage[MinIO Object Storage]
    Telegram[Telegram Bot API]
    
    Web -->|REST API /v1| Backend
    Bot -->|Internal Service Calls| Backend
    Admin -->|REST API /v1/admin| Backend
    Backend -->|Prisma ORM| DB
    Backend -->|File Upload/Download| Storage
    Backend -->|Send Notifications| Telegram
    
    style Backend fill:#4a90e2
    style DB fill:#2ecc71
    style Storage fill:#f39c12
```

## Cross-Layer Alignment Contract

This section is the shared source of truth for the backend, frontend, and Telegram bot MVP specs. If one layer changes any item here, the other two specs must be reviewed in the same pass.

### Deal Status Contract

All clients SHALL use these exact status values and SHALL NOT invent UI-only or bot-only statuses:

```typescript
type DealStatus =
  | 'DRAFT'
  | 'AWAITING_COUNTERPARTY'
  | 'AWAITING_BOTH_APPROVAL'
  | 'READY_FOR_PAYMENT'
  | 'PAYMENT_PENDING_VERIFICATION'
  | 'PAID_ESCROWED'
  | 'SELLER_PREPARING'
  | 'SHIPPED'
  | 'BUYER_CONFIRMED'
  | 'DISPUTED'
  | 'RELEASE_PENDING'
  | 'RELEASED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'EXPIRED';
```

The backend MAY move through short-lived internal transitions such as `PAID_ESCROWED -> SELLER_PREPARING` and `BUYER_CONFIRMED -> RELEASE_PENDING` in one service operation. API consumers must render the returned status and use timeline events to show the intermediate milestone.

### URL and Token Contract

| Link | Format | Audience | Notes |
| --- | --- | --- | --- |
| Deal Room | `https://bothsafe.app/d/{publicId}` | Existing participant with stored token | Used by safe notification buttons when no raw token is available |
| Creator link | `https://bothsafe.app/d/{publicId}?access={creatorAccessToken}` | Creator only | Raw token returned once; never log or send to counterparty |
| Invite link | `https://bothsafe.app/d/{publicId}?invite={inviteToken}` | Counterparty | Allows redacted preview and one-time join |

Participant API requests use `X-Access-Token` after the frontend captures the `access` URL parameter. `Authorization: Bearer` is reserved for admin JWTs. The Telegram bot must not store raw access tokens; after the original creator link has been sent, later bot notifications should use tokenless Deal Room links unless a future token reissue flow is explicitly designed.

### Redacted Invite Preview

The frontend join flow depends on `GET /v1/deals/:publicId?invite={inviteToken}` before the counterparty submits the join form. The response must be safe for a non-participant:

- Include: public_id, status, creator_role, counterparty_role, product summary, amount, currency, missing_fields, and `allowed_actions: ['join']`.
- Exclude: seller payout details, access tokens, payment proofs, shipping proofs, dispute evidence, admin notes, and private participant contact fields.
- Invalid or expired invite tokens return `message_key: "invite.invalid_or_expired"`.

### Shared Client Rules

- Frontend action buttons render from backend `allowed_actions`; the bot calls the same services and must not duplicate deal status logic.
- Payment, shipping, and dispute uploads accept JPEG, PNG, and WebP images up to 10MB in MVP.
- Seller payout KHQR is never displayed to the buyer.
- User-facing text is represented by translation keys in backend responses, frontend UI, and bot messages.
- Telegram is implemented inside the backend NestJS process and calls services directly, not HTTP.

## Architecture

### High-Level Architecture

The backend follows a modular monolith architecture pattern, organized into domain-specific NestJS modules that share a common database through Prisma ORM. This approach provides clear separation of concerns while maintaining simplicity for MVP deployment.

**Architecture Layers:**

1. **API Layer**: REST controllers with versioned endpoints (`/v1`), input validation, and authentication guards
2. **Service Layer**: Business logic, state management, and orchestration
3. **Data Layer**: Prisma ORM with MySQL for persistence
4. **Integration Layer**: File storage, Telegram Bot API, notification dispatch

### Module Architecture

```mermaid
graph TB
    subgraph "API Layer"
        DealCtrl[Deal Controller]
        PaymentCtrl[Payment Controller]
        AdminCtrl[Admin Controller]
        ShippingCtrl[Shipping Controller]
        DisputeCtrl[Dispute Controller]
    end
    
    subgraph "Service Layer"
        AuthSvc[Auth Service]
        DealSvc[Deal Service]
        PaymentSvc[Payment Service]
        LedgerSvc[Ledger Service]
        ShippingSvc[Shipping Service]
        DisputeSvc[Dispute Service]
        NotifSvc[Notification Service]
        FileSvc[File Service]
        StatusEngine[Status Engine]
        MissingFields[Missing Fields Calculator]
    end
    
    subgraph "Data Layer"
        Prisma[Prisma Service]
        DB[(MySQL)]
    end
    
    subgraph "Integration Layer"
        BotModule[Telegram Bot Module]
        Storage[Object Storage]
        TelegramAPI[Telegram Bot API]
    end
    
    DealCtrl --> DealSvc
    PaymentCtrl --> PaymentSvc
    AdminCtrl --> DealSvc
    AdminCtrl --> PaymentSvc
    ShippingCtrl --> ShippingSvc
    DisputeCtrl --> DisputeSvc
    
    DealSvc --> StatusEngine
    DealSvc --> MissingFields
    DealSvc --> Prisma
    PaymentSvc --> LedgerSvc
    PaymentSvc --> Prisma
    LedgerSvc --> Prisma
    ShippingSvc --> Prisma
    DisputeSvc --> Prisma
    
    DealSvc --> NotifSvc
    PaymentSvc --> NotifSvc
    NotifSvc --> BotModule
    BotModule --> TelegramAPI
    
    FileSvc --> Storage
    Prisma --> DB
    
    style StatusEngine fill:#e74c3c
    style MissingFields fill:#e74c3c
    style Prisma fill:#2ecc71
```


## Components and Interfaces

### Core Modules

#### 1. Auth Module (`src/auth/`)

**Responsibility**: Manage authentication for anonymous participants, optional user accounts, and admin users.

**Components**:
- `AuthService`: Token generation, validation, and hashing
- `UserAuthService`: Optional user login (phone/email)
- `OAuthStateService`: Manage OAuth state for user sessions
- `AdminGuard`: Protect admin-only endpoints
- `DealAccessGuard`: Verify participant access to specific deals
- `UserSessionGuard`: Validate logged-in user sessions

**Key Interfaces**:
```typescript
interface TokenPair {
  accessToken: string;
  accessTokenHash: string;
}

interface ParticipantAuth {
  dealId: string;
  role: 'buyer' | 'seller';
  accessToken: string;
}

interface AdminAuth {
  adminId: string;
  email: string;
  jwtToken: string;
}
```

**Security Features**:
- Bcrypt hashing for access tokens (cost factor 10)
- JWT with RS256 for admin authentication
- Token expiration and refresh logic
- Rate limiting on authentication endpoints

---

#### 2. Deal Module (`src/deals/`)

**Responsibility**: Manage Deal Room lifecycle, status transitions, and information updates.

**Components**:
- `DealsService`: Core deal operations (create, update, retrieve)
- `StatusEngine`: State machine for valid status transitions
- `MissingFieldsCalculator`: Determine incomplete required fields
- `DealsController`: REST endpoints for deal operations

**Key Interfaces**:
```typescript
interface CreateDealDto {
  source: 'web' | 'telegram';
  creator_role: 'buyer' | 'seller';
  language: 'km' | 'en' | 'zh';
  product_title?: string;
  product_type?: string;
  amount?: number;
  currency?: string;
  creator_name?: string;
  creator_phone?: string;
  telegram_chat_id?: string;
}

interface DealResponse {
  public_id: string;
  status: DealStatus;
  creator_role: 'buyer' | 'seller';
  current_user_role?: 'buyer' | 'seller';
  participants: Participant[];
  product: Product;
  amount: number;
  fee_amount: number;
  net_seller_amount: number;
  payment_summary?: PaymentSummary;
  shipping_summary?: ShippingSummary;
  dispute_summary?: DisputeSummary;
  timeline: TimelineEvent[];
  missing_fields: string[];
  allowed_actions: string[];
}

interface StatusTransition {
  from: DealStatus;
  to: DealStatus;
  preconditions: () => boolean;
  sideEffects: () => Promise<void>;
}
```

**Status Engine Design**:

The Status Engine implements a finite state machine with explicit transition rules:

```typescript
const VALID_TRANSITIONS: Map<DealStatus, DealStatus[]> = {
  DRAFT: ['AWAITING_COUNTERPARTY', 'CANCELLED', 'EXPIRED'],
  AWAITING_COUNTERPARTY: ['AWAITING_BOTH_APPROVAL', 'CANCELLED', 'EXPIRED'],
  AWAITING_BOTH_APPROVAL: ['READY_FOR_PAYMENT', 'CANCELLED', 'EXPIRED'],
  READY_FOR_PAYMENT: ['PAYMENT_PENDING_VERIFICATION'],
  PAYMENT_PENDING_VERIFICATION: ['PAID_ESCROWED', 'READY_FOR_PAYMENT', 'DISPUTED'],
  PAID_ESCROWED: ['SELLER_PREPARING', 'DISPUTED'],
  SELLER_PREPARING: ['SHIPPED', 'DISPUTED'],
  SHIPPED: ['BUYER_CONFIRMED', 'DISPUTED'],
  BUYER_CONFIRMED: ['RELEASE_PENDING'],
  DISPUTED: ['RELEASE_PENDING', 'REFUNDED'],
  RELEASE_PENDING: ['RELEASED', 'REFUNDED'],
  RELEASED: [],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: []
};
```

**Missing Fields Calculator Logic**:

```typescript
function calculateMissingFields(deal: Deal): string[] {
  const missing: string[] = [];
  
  // Product fields
  if (!deal.product?.product_title) missing.push('product.title');
  if (!deal.product?.product_type) missing.push('product.type');
  if (!deal.amount) missing.push('product.amount');
  
  // Participant fields
  const buyer = deal.participants.find(p => p.role === 'buyer');
  const seller = deal.participants.find(p => p.role === 'seller');
  
  if (!buyer) missing.push('buyer');
  else if (!buyer.name) missing.push('buyer.name');
  
  if (!seller) missing.push('seller');
  else if (!seller.name) missing.push('seller.name');
  
  // Payout fields (required before payment)
  if (seller && !seller.payout_khqr_image_url) {
    missing.push('seller.payout_khqr');
  }
  
  return missing;
}
```

---

#### 3. Payment Module (`src/payments/`)

**Responsibility**: Handle payment proof upload, admin verification/rejection, and ledger integration.

**Components**:
- `PaymentsService`: Payment proof management
- `PaymentPollerService`: Background job for payment status checks (future)
- `PaymentsController`: REST endpoints for payment operations

**Key Interfaces**:
```typescript
interface UploadPaymentProofDto {
  proof_image: File;
  paid_amount: number;
  payment_method: 'bakong_khqr';
  buyer_note?: string;
}

interface PaymentProof {
  id: string;
  deal_id: string;
  expected_amount: number;
  paid_amount: number;
  currency: string;
  payment_method: string;
  receiver_account_label: string;
  proof_image_url: string;
  buyer_note?: string;
  admin_status: 'pending' | 'verified' | 'rejected';
  verified_by_admin_id?: string;
  verified_at?: Date;
  rejected_reason?: string;
  created_at: Date;
}

interface VerifyPaymentDto {
  admin_note?: string;
}

interface RejectPaymentDto {
  rejection_reason: string;
  admin_note?: string;
}
```

**Payment Verification Flow**:

1. Buyer uploads payment proof → Status: `PAYMENT_PENDING_VERIFICATION`
2. Admin reviews proof in dashboard
3. Admin verifies:
   - Create ledger entries: `ESCROW_RECEIVED`, `PLATFORM_FEE_RESERVED`
   - Transition to `PAID_ESCROWED` → `SELLER_PREPARING`
   - Notify seller to ship
4. Admin rejects:
   - Transition back to `READY_FOR_PAYMENT`
   - Store rejection reason
   - Notify buyer to re-upload

---

#### 4. Ledger Module (`src/ledger/`)

**Responsibility**: Maintain append-only financial records for audit and reconciliation.

**Components**:
- `LedgerService`: Create and query ledger entries

**Key Interfaces**:
```typescript
enum LedgerEntryType {
  ESCROW_RECEIVED = 'ESCROW_RECEIVED',
  PLATFORM_FEE_RESERVED = 'PLATFORM_FEE_RESERVED',
  SELLER_PAYOUT_PENDING = 'SELLER_PAYOUT_PENDING',
  SELLER_PAYOUT_SENT = 'SELLER_PAYOUT_SENT',
  BUYER_REFUND_PENDING = 'BUYER_REFUND_PENDING',
  BUYER_REFUND_SENT = 'BUYER_REFUND_SENT',
  ADJUSTMENT = 'ADJUSTMENT'
}

interface LedgerEntry {
  id: string;
  deal_id: string;
  entry_type: LedgerEntryType;
  amount: number;
  currency: string;
  description: string;
  reference_id?: string;
  created_by_admin_id?: string;
  created_at: Date;
}

interface CreateLedgerEntryDto {
  deal_id: string;
  entry_type: LedgerEntryType;
  amount: number;
  currency: string;
  description: string;
  reference_id?: string;
}
```

**Ledger Rules**:
- Entries are immutable (no updates or deletes)
- Each entry has a monotonically increasing ID
- Entries are created transactionally with status changes
- Balance calculations are derived from entry sums

---

#### 5. Shipping Module (`src/shipping/`)

**Responsibility**: Handle seller shipping proof upload and delivery tracking.

**Components**:
- `ShippingService`: Shipping proof management
- `ShippingController`: REST endpoints for shipping operations

**Key Interfaces**:
```typescript
interface UploadShippingProofDto {
  delivery_company?: string;
  tracking_number?: string;
  package_photo?: File;
  delivery_receipt?: File;
  seller_note?: string;
}

interface ShippingProof {
  id: string;
  deal_id: string;
  delivery_company?: string;
  tracking_number?: string;
  package_photo_url?: string;
  delivery_receipt_url?: string;
  seller_note?: string;
  created_at: Date;
}
```

---

#### 6. Dispute Module (`src/disputes/`)

**Responsibility**: Handle dispute creation, evidence upload, and admin resolution.

**Components**:
- `DisputesService`: Dispute management
- `DisputesController`: REST endpoints for dispute operations

**Key Interfaces**:
```typescript
enum DisputeReason {
  ITEM_NOT_RECEIVED = 'ITEM_NOT_RECEIVED',
  WRONG_ITEM = 'WRONG_ITEM',
  DAMAGED_ITEM = 'DAMAGED_ITEM',
  FAKE_ITEM = 'FAKE_ITEM',
  PAYMENT_PROBLEM = 'PAYMENT_PROBLEM',
  OTHER = 'OTHER'
}

interface CreateDisputeDto {
  reason: DisputeReason;
  message: string;
  evidence_files?: File[];
}

interface Dispute {
  id: string;
  deal_id: string;
  opened_by_role: 'buyer' | 'seller';
  reason: DisputeReason;
  message: string;
  evidence_urls: string[];
  status: 'open' | 'under_review' | 'resolved_release' | 'resolved_refund';
  admin_note?: string;
  created_at: Date;
  resolved_at?: Date;
}

interface ResolveDisputeDto {
  decision: 'release' | 'refund';
  admin_note: string;
}
```

---

#### 7. Admin Module (`src/admin/`)

**Responsibility**: Provide admin-only operations for platform management.

**Components**:
- `AdminService`: Admin operations orchestration
- `AdminController`: REST endpoints for admin dashboard

**Key Interfaces**:
```typescript
interface AdminDealListQuery {
  status?: DealStatus;
  from_date?: Date;
  to_date?: Date;
  search?: string;
  page?: number;
  limit?: number;
}

interface AdminDealListResponse {
  deals: DealSummary[];
  total: number;
  page: number;
  limit: number;
}

interface ReleasePaymentDto {
  payout_reference: string;
  admin_note?: string;
}

interface RefundPaymentDto {
  refund_reference: string;
  admin_note?: string;
}
```

---

#### 8. Notification Module (`src/notifications/`)

**Responsibility**: Dispatch notifications to multiple channels (in-app, Telegram).

**Components**:
- `NotificationService`: Event-based notification dispatch
- `BotNotifierInterface`: Abstraction for Telegram notifications

**Key Interfaces**:
```typescript
enum NotificationEvent {
  COUNTERPARTY_JOINED = 'COUNTERPARTY_JOINED',
  DEAL_UPDATED = 'DEAL_UPDATED',
  BOTH_APPROVED = 'BOTH_APPROVED',
  PAYMENT_PROOF_UPLOADED = 'PAYMENT_PROOF_UPLOADED',
  PAYMENT_VERIFIED = 'PAYMENT_VERIFIED',
  PAYMENT_REJECTED = 'PAYMENT_REJECTED',
  SELLER_SHOULD_SHIP = 'SELLER_SHOULD_SHIP',
  SHIPPING_UPLOADED = 'SHIPPING_UPLOADED',
  BUYER_CONFIRMED = 'BUYER_CONFIRMED',
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  PAYOUT_RELEASED = 'PAYOUT_RELEASED',
  REFUND_COMPLETED = 'REFUND_COMPLETED'
}

interface NotificationPayload {
  event: NotificationEvent;
  deal_id: string;
  recipient_role: 'buyer' | 'seller';
  language: 'km' | 'en' | 'zh';
  data: Record<string, any>;
}

interface Notification {
  id: string;
  deal_id: string;
  recipient_participant_id: string;
  event: NotificationEvent;
  message_key: string;
  data: Record<string, any>;
  telegram_sent: boolean;
  telegram_sent_at?: Date;
  created_at: Date;
}
```

**Notification Dispatch Strategy**:
- Notifications are created in database first (for timeline)
- Telegram notifications are sent asynchronously
- Failed Telegram sends are logged but don't block transactions
- Retry logic with exponential backoff for transient failures

---

#### 9. File Storage Module (`src/files/`)

**Responsibility**: Handle file uploads, validation, and secure access.

**Components**:
- `FilesService`: File upload/download orchestration
- `FilesController`: REST endpoints for file operations

**Key Interfaces**:
```typescript
interface UploadFileDto {
  file: File;
  file_type: 'product_image' | 'payment_proof' | 'shipping_proof' | 'dispute_evidence';
  deal_id: string;
}

interface FileMetadata {
  id: string;
  deal_id: string;
  file_type: string;
  original_filename: string;
  storage_path: string;
  storage_url: string;
  signed_url?: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by_role: 'buyer' | 'seller' | 'admin';
  created_at: Date;
}
```

**File Validation Rules**:
- Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`
- Maximum file size: 10MB
- Filename sanitization to prevent path traversal
- Virus scanning (future enhancement)

**Access Control**:
- Product images: Public access
- Payment proofs: Admin and deal participants only
- Shipping proofs: Admin and deal participants only
- Dispute evidence: Admin and deal participants only

---

#### 10. Telegram Bot Module (`src/bot/`)

**Responsibility**: Provide Telegram interface for deal creation and notifications.

**Components**:
- `BotUpdate`: Handle incoming Telegram updates
- `BotTelegramService`: Telegram Bot API integration
- `BotStateService`: Manage conversation state
- `BotMessages`: Localized message templates

**Key Interfaces**:
```typescript
interface BotConversationState {
  telegram_chat_id: string;
  current_command: string;
  state_data: Record<string, any>;
  created_at: Date;
  expires_at: Date;
}

interface TelegramIdentity {
  telegram_chat_id: string;
  telegram_username?: string;
  first_name?: string;
  last_name?: string;
  preferred_language: 'km' | 'en' | 'zh';
  created_at: Date;
}
```

**Bot Commands**:
- `/start`: Welcome message, store chat ID
- `/newdeal`: Guided deal creation flow
- `/mydeals`: List user's recent deals
- `/help`: Explain escrow concept

**Bot Integration Pattern**:
- Bot runs inside NestJS process (not separate service)
- Bot calls `DealsService` directly (internal service calls)
- Request/response shape matches public API contract
- No bot-specific business logic

---

#### 11. Audit Module (`src/common/services/audit.module.ts`)

**Responsibility**: Log all critical actions for compliance and debugging.

**Components**:
- `AuditService`: Create and query audit logs

**Key Interfaces**:
```typescript
enum AuditAction {
  DEAL_CREATED = 'DEAL_CREATED',
  PARTICIPANT_JOINED = 'PARTICIPANT_JOINED',
  DEAL_UPDATED = 'DEAL_UPDATED',
  DEAL_APPROVED = 'DEAL_APPROVED',
  PAYMENT_PROOF_UPLOADED = 'PAYMENT_PROOF_UPLOADED',
  PAYMENT_VERIFIED = 'PAYMENT_VERIFIED',
  PAYMENT_REJECTED = 'PAYMENT_REJECTED',
  SHIPPING_UPLOADED = 'SHIPPING_UPLOADED',
  BUYER_CONFIRMED = 'BUYER_CONFIRMED',
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  PAYMENT_RELEASED = 'PAYMENT_RELEASED',
  PAYMENT_REFUNDED = 'PAYMENT_REFUNDED'
}

interface AuditLog {
  id: string;
  action: AuditAction;
  actor_type: 'participant' | 'admin' | 'system';
  actor_id?: string;
  deal_id?: string;
  metadata: Record<string, any>;
  ip_address?: string;
  user_agent?: string;
  created_at: Date;
}
```


## Data Models

### Database Schema Design

The database uses MySQL with Prisma ORM. The schema is designed for data integrity, audit trails, and efficient querying. Prisma datasource configuration should use `provider = "mysql"` and a `mysql://` `DATABASE_URL`.

```mermaid
erDiagram
    DEALS ||--o{ PARTICIPANTS : has
    DEALS ||--o| PRODUCTS : has
    DEALS ||--o{ PAYMENTS : has
    DEALS ||--o{ LEDGER_ENTRIES : has
    DEALS ||--o{ SHIPPING_PROOFS : has
    DEALS ||--o{ DISPUTES : has
    DEALS ||--o{ AUDIT_LOGS : has
    DEALS ||--o{ NOTIFICATIONS : has
    PARTICIPANTS ||--o{ NOTIFICATIONS : receives
    PARTICIPANTS ||--o| TELEGRAM_IDENTITIES : links
    TELEGRAM_IDENTITIES ||--o{ BOT_CONVERSATION_STATES : has
    PAYMENTS ||--o{ FILES : has
    SHIPPING_PROOFS ||--o{ FILES : has
    DISPUTES ||--o{ FILES : has
    PRODUCTS ||--o{ FILES : has
    
    DEALS {
        uuid id PK
        string public_id UK
        enum creator_role
        enum source
        enum status
        string currency
        decimal amount
        decimal fee_amount
        decimal net_seller_amount
        uuid created_by_user_id FK
        string created_by_telegram_chat_id
        timestamp expires_at
        timestamp created_at
        timestamp updated_at
    }
    
    PARTICIPANTS {
        uuid id PK
        uuid deal_id FK
        enum role
        string name
        string phone
        string telegram_chat_id
        string wechat_id
        string messenger_name
        enum preferred_language
        string access_token_hash
        string payout_khqr_image_url
        timestamp approved_at
        timestamp joined_at
        timestamp created_at
    }
    
    PRODUCTS {
        uuid id PK
        uuid deal_id FK
        string product_title
        string product_type
        text product_description
        string product_image_url
        integer quantity
        string condition
        timestamp created_at
        timestamp updated_at
    }
    
    PAYMENTS {
        uuid id PK
        uuid deal_id FK
        decimal expected_amount
        decimal paid_amount
        string currency
        enum payment_method
        string receiver_account_label
        string proof_image_url
        text buyer_note
        enum admin_status
        uuid verified_by_admin_id FK
        timestamp verified_at
        text rejected_reason
        timestamp created_at
    }
    
    LEDGER_ENTRIES {
        uuid id PK
        uuid deal_id FK
        enum entry_type
        decimal amount
        string currency
        text description
        string reference_id
        uuid created_by_admin_id FK
        timestamp created_at
    }
    
    SHIPPING_PROOFS {
        uuid id PK
        uuid deal_id FK
        string delivery_company
        string tracking_number
        string package_photo_url
        string delivery_receipt_url
        text seller_note
        timestamp created_at
    }
    
    DISPUTES {
        uuid id PK
        uuid deal_id FK
        enum opened_by_role
        enum reason
        text message
        jsonb evidence_urls
        enum status
        text admin_note
        timestamp created_at
        timestamp resolved_at
    }
    
    FILES {
        uuid id PK
        uuid deal_id FK
        enum file_type
        string original_filename
        string storage_path
        string storage_url
        string mime_type
        integer size_bytes
        enum uploaded_by_role
        timestamp created_at
    }
    
    AUDIT_LOGS {
        uuid id PK
        enum action
        enum actor_type
        uuid actor_id
        uuid deal_id FK
        jsonb metadata
        string ip_address
        string user_agent
        timestamp created_at
    }
    
    NOTIFICATIONS {
        uuid id PK
        uuid deal_id FK
        uuid recipient_participant_id FK
        enum event
        string message_key
        jsonb data
        boolean telegram_sent
        timestamp telegram_sent_at
        timestamp created_at
    }
    
    TELEGRAM_IDENTITIES {
        string telegram_chat_id PK
        string telegram_username
        string first_name
        string last_name
        enum preferred_language
        timestamp created_at
        timestamp updated_at
    }
    
    BOT_CONVERSATION_STATES {
        uuid id PK
        string telegram_chat_id FK
        string current_command
        jsonb state_data
        timestamp created_at
        timestamp expires_at
    }
```

### Key Database Indexes

**Performance Indexes**:
```sql
-- Deal lookups
CREATE INDEX idx_deals_public_id ON deals(public_id);
CREATE INDEX idx_deals_status ON deals(status);
CREATE INDEX idx_deals_created_at ON deals(created_at DESC);
CREATE INDEX idx_deals_creator_telegram ON deals(created_by_telegram_chat_id);

-- Participant lookups
CREATE INDEX idx_participants_deal_id ON participants(deal_id);
CREATE INDEX idx_participants_telegram ON participants(telegram_chat_id);
CREATE INDEX idx_participants_access_token ON participants(access_token_hash);

-- Payment lookups
CREATE INDEX idx_payments_deal_id ON payments(deal_id);
CREATE INDEX idx_payments_admin_status ON payments(admin_status);

-- Ledger queries
CREATE INDEX idx_ledger_deal_id ON ledger_entries(deal_id);
CREATE INDEX idx_ledger_created_at ON ledger_entries(created_at DESC);

-- Audit log queries
CREATE INDEX idx_audit_deal_id ON audit_logs(deal_id);
CREATE INDEX idx_audit_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- Notification queries
CREATE INDEX idx_notifications_deal_id ON notifications(deal_id);
CREATE INDEX idx_notifications_recipient ON notifications(recipient_participant_id);
CREATE INDEX idx_notifications_telegram_sent ON notifications(telegram_sent, created_at);
```

### Data Integrity Constraints

**Foreign Key Constraints**:
- All foreign keys use `ON DELETE RESTRICT` to prevent orphaned records
- Cascade deletes are not used; deletion requires explicit service logic

**Check Constraints**:
```sql
-- Amount validations
ALTER TABLE deals ADD CONSTRAINT chk_deals_amount_positive 
  CHECK (amount > 0);
ALTER TABLE deals ADD CONSTRAINT chk_deals_fee_non_negative 
  CHECK (fee_amount >= 0);

-- Status validations
ALTER TABLE deals ADD CONSTRAINT chk_deals_status_valid 
  CHECK (status IN ('DRAFT', 'AWAITING_COUNTERPARTY', ...));

-- Role validations
ALTER TABLE participants ADD CONSTRAINT chk_participants_role_valid 
  CHECK (role IN ('buyer', 'seller'));
```

**Unique Constraints**:
```sql
-- One product per deal
ALTER TABLE products ADD CONSTRAINT uq_products_deal_id UNIQUE (deal_id);

-- One buyer and one seller per deal
CREATE UNIQUE INDEX uq_participants_deal_buyer 
  ON participants(deal_id) WHERE role = 'buyer';
CREATE UNIQUE INDEX uq_participants_deal_seller 
  ON participants(deal_id) WHERE role = 'seller';
```

### Data Migration Strategy

**Version Control**:
- Prisma migrations stored in `prisma/migrations/`
- Each migration has timestamp and descriptive name
- Rollback scripts generated automatically

**Seed Data**:
- Development seed creates sample deals in various statuses
- Admin user seed for local testing
- Telegram identity seed for bot testing


## Status State Machine

### State Diagram

```mermaid
stateDiagram-v2
    [*] --> DRAFT: Create Deal
    
    DRAFT --> AWAITING_COUNTERPARTY: Add Required Info
    DRAFT --> CANCELLED: Cancel
    DRAFT --> EXPIRED: Timeout
    
    AWAITING_COUNTERPARTY --> AWAITING_BOTH_APPROVAL: Counterparty Joins
    AWAITING_COUNTERPARTY --> CANCELLED: Cancel
    AWAITING_COUNTERPARTY --> EXPIRED: Timeout
    
    AWAITING_BOTH_APPROVAL --> READY_FOR_PAYMENT: Both Approve
    AWAITING_BOTH_APPROVAL --> CANCELLED: Cancel
    AWAITING_BOTH_APPROVAL --> EXPIRED: Timeout
    
    READY_FOR_PAYMENT --> PAYMENT_PENDING_VERIFICATION: Upload Payment Proof
    
    PAYMENT_PENDING_VERIFICATION --> PAID_ESCROWED: Admin Verifies
    PAYMENT_PENDING_VERIFICATION --> READY_FOR_PAYMENT: Admin Rejects
    PAYMENT_PENDING_VERIFICATION --> DISPUTED: Open Dispute
    
    PAID_ESCROWED --> SELLER_PREPARING: Auto Transition
    PAID_ESCROWED --> DISPUTED: Open Dispute
    
    SELLER_PREPARING --> SHIPPED: Upload Shipping Proof
    SELLER_PREPARING --> DISPUTED: Open Dispute
    
    SHIPPED --> BUYER_CONFIRMED: Buyer Confirms
    SHIPPED --> DISPUTED: Open Dispute
    
    BUYER_CONFIRMED --> RELEASE_PENDING: Auto Transition
    
    DISPUTED --> RELEASE_PENDING: Admin Resolves (Release)
    DISPUTED --> REFUNDED: Admin Resolves (Refund)
    
    RELEASE_PENDING --> RELEASED: Admin Releases Payment
    RELEASE_PENDING --> REFUNDED: Admin Refunds
    
    RELEASED --> [*]
    REFUNDED --> [*]
    CANCELLED --> [*]
    EXPIRED --> [*]
```

### Transition Rules

#### Early Stage Transitions

**DRAFT → AWAITING_COUNTERPARTY**
- **Trigger**: Creator completes minimum required fields
- **Preconditions**: 
  - Product title exists
  - Amount exists
  - Creator participant info exists
- **Side Effects**: 
  - Generate invite token
  - Create audit log entry

**AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL**
- **Trigger**: Counterparty joins via invite link
- **Preconditions**: 
  - Valid invite token
  - Counterparty role is opposite of creator role
- **Side Effects**: 
  - Invalidate invite token
  - Create counterparty participant record
  - Generate counterparty access token
  - Send COUNTERPARTY_JOINED notification
  - Create audit log entry

**AWAITING_BOTH_APPROVAL → READY_FOR_PAYMENT**
- **Trigger**: Both participants approve
- **Preconditions**: 
  - Both buyer and seller exist
  - Both have approved (approved_at is set)
  - All required fields complete (missing_fields is empty)
  - Product title, type, amount exist
  - Seller payout KHQR exists
- **Side Effects**: 
  - Send BOTH_APPROVED notification
  - Send payment instructions to buyer
  - Create audit log entry

#### Payment Stage Transitions

**READY_FOR_PAYMENT → PAYMENT_PENDING_VERIFICATION**
- **Trigger**: Buyer uploads payment proof
- **Preconditions**: 
  - Current user is buyer
  - Valid image file uploaded
  - Paid amount matches expected amount (within tolerance)
- **Side Effects**: 
  - Store payment proof record
  - Send PAYMENT_PROOF_UPLOADED notification to admin
  - Create audit log entry

**PAYMENT_PENDING_VERIFICATION → PAID_ESCROWED**
- **Trigger**: Admin verifies payment
- **Preconditions**: 
  - Current user is admin
  - Payment proof exists
  - Payment not already verified
- **Side Effects**: 
  - Update payment admin_status to 'verified'
  - Create ledger entry: ESCROW_RECEIVED
  - Create ledger entry: PLATFORM_FEE_RESERVED
  - Send PAYMENT_VERIFIED notification
  - Create audit log entry

**PAID_ESCROWED → SELLER_PREPARING**
- **Trigger**: Automatic after payment verification
- **Preconditions**: None (automatic)
- **Side Effects**: 
  - Send SELLER_SHOULD_SHIP notification
  - Create audit log entry

**PAYMENT_PENDING_VERIFICATION → READY_FOR_PAYMENT**
- **Trigger**: Admin rejects payment proof
- **Preconditions**: 
  - Current user is admin
  - Rejection reason provided
- **Side Effects**: 
  - Update payment admin_status to 'rejected'
  - Store rejection reason
  - Send PAYMENT_REJECTED notification to buyer
  - Create audit log entry

#### Fulfillment Stage Transitions

**SELLER_PREPARING → SHIPPED**
- **Trigger**: Seller uploads shipping proof
- **Preconditions**: 
  - Current user is seller
  - At least one shipping detail provided (tracking, photo, or receipt)
- **Side Effects**: 
  - Store shipping proof record
  - Send SHIPPING_UPLOADED notification to buyer
  - Create audit log entry

**SHIPPED → BUYER_CONFIRMED**
- **Trigger**: Buyer confirms delivery
- **Preconditions**: 
  - Current user is buyer
- **Side Effects**: 
  - Send BUYER_CONFIRMED notification
  - Create audit log entry

**BUYER_CONFIRMED → RELEASE_PENDING**
- **Trigger**: Automatic after buyer confirmation
- **Preconditions**: None (automatic)
- **Side Effects**: 
  - Create ledger entry: SELLER_PAYOUT_PENDING
  - Notify admin of pending release
  - Create audit log entry

#### Completion Stage Transitions

**RELEASE_PENDING → RELEASED**
- **Trigger**: Admin releases payment to seller
- **Preconditions**: 
  - Current user is admin
  - Payout reference provided
  - Not already released
- **Side Effects**: 
  - Create ledger entry: SELLER_PAYOUT_SENT
  - Send PAYOUT_RELEASED notification to seller
  - Create audit log entry

**RELEASE_PENDING → REFUNDED**
- **Trigger**: Admin refunds payment to buyer
- **Preconditions**: 
  - Current user is admin
  - Refund reference provided
  - Not already refunded
- **Side Effects**: 
  - Create ledger entry: BUYER_REFUND_PENDING
  - Create ledger entry: BUYER_REFUND_SENT
  - Send REFUND_COMPLETED notification to buyer
  - Create audit log entry

#### Dispute Transitions

**{PAYMENT_PENDING_VERIFICATION, PAID_ESCROWED, SELLER_PREPARING, SHIPPED} → DISPUTED**
- **Trigger**: Buyer or seller opens dispute
- **Preconditions**: 
  - Dispute reason provided
  - Dispute message provided
- **Side Effects**: 
  - Create dispute record
  - Send DISPUTE_OPENED notification to counterparty and admin
  - Create audit log entry

**DISPUTED → RELEASE_PENDING**
- **Trigger**: Admin resolves dispute in favor of seller
- **Preconditions**: 
  - Current user is admin
  - Resolution note provided
- **Side Effects**: 
  - Update dispute status to 'resolved_release'
  - Create ledger entry: SELLER_PAYOUT_PENDING
  - Create audit log entry

**DISPUTED → REFUNDED**
- **Trigger**: Admin resolves dispute in favor of buyer
- **Preconditions**: 
  - Current user is admin
  - Resolution note provided
  - Refund reference provided
- **Side Effects**: 
  - Update dispute status to 'resolved_refund'
  - Create ledger entry: BUYER_REFUND_PENDING
  - Create ledger entry: BUYER_REFUND_SENT
  - Send REFUND_COMPLETED notification
  - Create audit log entry

#### Cancellation and Expiration

**{DRAFT, AWAITING_COUNTERPARTY, AWAITING_BOTH_APPROVAL} → CANCELLED**
- **Trigger**: Creator cancels deal
- **Preconditions**: 
  - No payment has been made
  - Current user is creator
- **Side Effects**: 
  - Create audit log entry

**{DRAFT, AWAITING_COUNTERPARTY, AWAITING_BOTH_APPROVAL} → EXPIRED**
- **Trigger**: Background job checks expiration
- **Preconditions**: 
  - Current time > expires_at
  - Deal has not reached READY_FOR_PAYMENT or any later status
- **Side Effects**: 
  - Send expiration notification
  - Create audit log entry

### Transition Validation

The Status Engine validates transitions using this algorithm:

```typescript
class StatusEngine {
  async transition(
    deal: Deal,
    targetStatus: DealStatus,
    actor: Actor,
    context: TransitionContext
  ): Promise<Deal> {
    // 1. Check if transition is valid
    const validTargets = VALID_TRANSITIONS.get(deal.status);
    if (!validTargets?.includes(targetStatus)) {
      throw new InvalidTransitionError(
        `Cannot transition from ${deal.status} to ${targetStatus}`
      );
    }
    
    // 2. Check preconditions
    const preconditions = this.getPreconditions(deal.status, targetStatus);
    const preconditionsMet = await preconditions(deal, actor, context);
    if (!preconditionsMet) {
      throw new PreconditionsNotMetError(
        `Preconditions not met for ${deal.status} → ${targetStatus}`
      );
    }
    
    // 3. Execute transition in transaction
    return await this.prisma.$transaction(async (tx) => {
      // Update deal status
      const updatedDeal = await tx.deal.update({
        where: { id: deal.id },
        data: { status: targetStatus, updated_at: new Date() }
      });
      
      // Execute side effects
      const sideEffects = this.getSideEffects(deal.status, targetStatus);
      await sideEffects(updatedDeal, actor, context, tx);
      
      return updatedDeal;
    });
  }
}
```


## Security Architecture

### Authentication Strategy

#### Anonymous Participant Authentication

**Token Generation**:
```typescript
function generateAccessToken(): TokenPair {
  // Generate cryptographically secure random token
  const rawToken = crypto.randomBytes(32).toString('base64url');
  
  // Hash for storage
  const hash = await bcrypt.hash(rawToken, 10);
  
  return {
    accessToken: rawToken,
    accessTokenHash: hash
  };
}
```

**Token Validation**:
```typescript
async function validateAccessToken(
  dealId: string,
  providedToken: string
): Promise<Participant | null> {
  const participants = await prisma.participant.findMany({
    where: { deal_id: dealId }
  });
  
  for (const participant of participants) {
    const isValid = await bcrypt.compare(
      providedToken,
      participant.access_token_hash
    );
    if (isValid) return participant;
  }
  
  return null;
}
```

**Token Delivery**:
- Creator token: Returned once in API response, never logged
- Counterparty token: Returned once after join, never logged
- Tokens are not sent via email/SMS in MVP (user must save the URL)

#### Admin Authentication

**JWT Strategy**:
- Algorithm: RS256 (asymmetric)
- Token expiration: 8 hours
- Refresh token: 30 days
- Claims: `{ sub: adminId, email, role: 'admin' }`

**Admin Login Flow**:
1. Admin submits email + password
2. Backend validates credentials
3. Backend generates JWT access token + refresh token
4. Frontend stores tokens in httpOnly cookies
5. Frontend includes JWT in Authorization header for admin requests

### Authorization Guards

#### DealAccessGuard

```typescript
@Injectable()
export class DealAccessGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const dealId = request.params.publicId;
    const accessToken = request.headers['x-access-token'] || 
                       request.query.access;
    
    if (!accessToken) {
      throw new UnauthorizedException('auth.missing_token');
    }
    
    const participant = await this.authService.validateAccessToken(
      dealId,
      accessToken
    );
    
    if (!participant) {
      throw new UnauthorizedException('auth.invalid_token');
    }
    
    // Attach participant to request for use in controllers
    request.currentParticipant = participant;
    return true;
  }
}
```

#### AdminGuard

```typescript
@Injectable()
export class AdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    
    if (!token) {
      throw new UnauthorizedException('auth.missing_admin_token');
    }
    
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_PUBLIC_KEY
      });
      
      if (payload.role !== 'admin') {
        throw new ForbiddenException('auth.not_admin');
      }
      
      request.currentAdmin = payload;
      return true;
    } catch {
      throw new UnauthorizedException('auth.invalid_admin_token');
    }
  }
}
```

### Input Validation

**DTO Validation with class-validator**:

```typescript
export class CreateDealDto {
  @IsEnum(['web', 'telegram'])
  source: string;
  
  @IsEnum(['buyer', 'seller'])
  creator_role: string;
  
  @IsEnum(['km', 'en', 'zh'])
  language: string;
  
  @IsOptional()
  @IsString()
  @MaxLength(200)
  product_title?: string;
  
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1000000)
  amount?: number;
  
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/)
  creator_phone?: string;
}
```

**Sanitization**:

```typescript
function sanitizeText(input: string): string {
  // Remove null bytes
  let sanitized = input.replace(/\0/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length
  sanitized = sanitized.substring(0, 10000);
  
  // HTML encode for XSS prevention (done by frontend, but defense in depth)
  return sanitized;
}
```

### Rate Limiting

**Configuration**:

```typescript
@Module({
  imports: [
    ThrottlerModule.forRoot({
      ttl: 60,
      limit: 10, // Default: 10 requests per minute
    }),
  ],
})
export class AppModule {}
```

**Endpoint-Specific Limits**:

```typescript
// Deal creation: 5 per minute per IP
@Throttle(5, 60)
@Post('/v1/deals')
async createDeal() { ... }

// Payment proof upload: 3 per hour per deal
@Throttle(3, 3600)
@Post('/v1/deals/:publicId/payment-proofs')
async uploadPaymentProof() { ... }

// Admin login: 5 attempts per 15 minutes per IP
@Throttle(5, 900)
@Post('/v1/admin/login')
async adminLogin() { ... }
```

### CORS Configuration

```typescript
app.enableCors({
  origin: [
    process.env.FRONTEND_URL, // https://bothsafe.app
    process.env.ADMIN_URL,    // https://admin.bothsafe.app
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Token'],
});
```

### File Upload Security

**Validation**:

```typescript
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp'
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function validateFile(file: Express.Multer.File): void {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException('file.invalid_type');
  }
  
  if (file.size > MAX_FILE_SIZE) {
    throw new BadRequestException('file.too_large');
  }
  
  // Check file extension matches MIME type
  const ext = path.extname(file.originalname).toLowerCase();
  const expectedExts = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/webp': ['.webp']
  };
  
  if (!expectedExts[file.mimetype]?.includes(ext)) {
    throw new BadRequestException('file.extension_mismatch');
  }
}
```

**Filename Sanitization**:

```typescript
function sanitizeFilename(filename: string): string {
  // Remove path traversal attempts
  let safe = filename.replace(/\.\./g, '');
  
  // Remove special characters except dots and dashes
  safe = safe.replace(/[^a-zA-Z0-9.-]/g, '_');
  
  // Generate unique prefix
  const prefix = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  
  return `${prefix}_${safe}`;
}
```

### SQL Injection Prevention

**Prisma Parameterization**:
- All queries use Prisma's parameterized query builder
- Raw SQL is avoided; if necessary, use `prisma.$queryRaw` with tagged templates

```typescript
// SAFE: Prisma parameterizes automatically
const deal = await prisma.deal.findUnique({
  where: { public_id: userInput }
});

// SAFE: Tagged template for raw queries
const results = await prisma.$queryRaw`
  SELECT * FROM deals WHERE public_id = ${userInput}
`;

// UNSAFE: Never do this
const results = await prisma.$queryRawUnsafe(
  `SELECT * FROM deals WHERE public_id = '${userInput}'`
);
```

### Secrets Management

**Environment Variables**:
- Database credentials
- JWT signing keys
- Object storage credentials
- Telegram bot token
- Admin password hashes

**Never Log**:
- Raw access tokens
- Admin passwords
- JWT tokens
- Telegram bot token
- Database credentials

**Logging Sanitization**:

```typescript
function sanitizeForLogging(obj: any): any {
  const sensitive = [
    'password',
    'token',
    'access_token',
    'jwt',
    'secret',
    'api_key'
  ];
  
  const sanitized = { ...obj };
  
  for (const key of Object.keys(sanitized)) {
    if (sensitive.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  
  return sanitized;
}
```


## Error Handling

### Error Response Format

All API errors follow a consistent structure:

```typescript
interface ErrorResponse {
  statusCode: number;
  message_key: string;
  message: string; // English fallback
  errors?: ValidationError[];
  timestamp: string;
  path: string;
  request_id: string;
}

interface ValidationError {
  field: string;
  message_key: string;
  constraints: Record<string, string>;
}
```

**Example Error Responses**:

```json
// 400 Bad Request - Validation Error
{
  "statusCode": 400,
  "message_key": "validation.failed",
  "message": "Validation failed",
  "errors": [
    {
      "field": "amount",
      "message_key": "validation.amount.min",
      "constraints": {
        "min": "Amount must be at least 0.01"
      }
    }
  ],
  "timestamp": "2026-05-06T12:00:00.000Z",
  "path": "/v1/deals",
  "request_id": "req_abc123"
}

// 401 Unauthorized
{
  "statusCode": 401,
  "message_key": "auth.invalid_token",
  "message": "Invalid access token",
  "timestamp": "2026-05-06T12:00:00.000Z",
  "path": "/v1/deals/abc123",
  "request_id": "req_def456"
}

// 403 Forbidden
{
  "statusCode": 403,
  "message_key": "deal.not_authorized",
  "message": "You are not authorized to perform this action",
  "timestamp": "2026-05-06T12:00:00.000Z",
  "path": "/v1/deals/abc123/approval",
  "request_id": "req_ghi789"
}

// 409 Conflict
{
  "statusCode": 409,
  "message_key": "deal.invalid_status_transition",
  "message": "Cannot transition from SHIPPED to DRAFT",
  "timestamp": "2026-05-06T12:00:00.000Z",
  "path": "/v1/deals/abc123",
  "request_id": "req_jkl012"
}

// 500 Internal Server Error
{
  "statusCode": 500,
  "message_key": "error.internal",
  "message": "An internal error occurred",
  "timestamp": "2026-05-06T12:00:00.000Z",
  "path": "/v1/deals/abc123",
  "request_id": "req_mno345"
}
```

### Global Exception Filter

```typescript
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}
  
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let messageKey = 'error.internal';
    let message = 'An internal error occurred';
    let errors: ValidationError[] | undefined;
    
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      
      if (typeof exceptionResponse === 'object') {
        messageKey = exceptionResponse['message_key'] || messageKey;
        message = exceptionResponse['message'] || message;
        errors = exceptionResponse['errors'];
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Handle Prisma errors
      status = HttpStatus.BAD_REQUEST;
      
      if (exception.code === 'P2002') {
        messageKey = 'error.duplicate_entry';
        message = 'A record with this value already exists';
      } else if (exception.code === 'P2025') {
        messageKey = 'error.not_found';
        message = 'Record not found';
      }
    }
    
    const errorResponse: ErrorResponse = {
      statusCode: status,
      message_key: messageKey,
      message,
      errors,
      timestamp: new Date().toISOString(),
      path: request.url,
      request_id: request['id'] || 'unknown'
    };
    
    // Log error (sanitized)
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : exception
      );
    }
    
    response.status(status).json(errorResponse);
  }
}
```

### Domain-Specific Exceptions

```typescript
// Deal exceptions
export class InvalidStatusTransitionException extends HttpException {
  constructor(from: DealStatus, to: DealStatus) {
    super(
      {
        message_key: 'deal.invalid_status_transition',
        message: `Cannot transition from ${from} to ${to}`
      },
      HttpStatus.CONFLICT
    );
  }
}

export class MissingFieldsException extends HttpException {
  constructor(fields: string[]) {
    super(
      {
        message_key: 'deal.missing_fields',
        message: 'Required fields are missing',
        errors: fields.map(f => ({
          field: f,
          message_key: `validation.${f}.required`,
          constraints: { required: 'This field is required' }
        }))
      },
      HttpStatus.BAD_REQUEST
    );
  }
}

export class FieldsLockedException extends HttpException {
  constructor() {
    super(
      {
        message_key: 'deal.fields_locked_after_payment',
        message: 'These fields cannot be modified after payment'
      },
      HttpStatus.FORBIDDEN
    );
  }
}

// Payment exceptions
export class PaymentNotReadyException extends HttpException {
  constructor() {
    super(
      {
        message_key: 'payment.not_ready_for_payment',
        message: 'Deal is not ready for payment'
      },
      HttpStatus.BAD_REQUEST
    );
  }
}

export class PaymentAlreadyVerifiedException extends HttpException {
  constructor() {
    super(
      {
        message_key: 'payment.already_verified',
        message: 'Payment has already been verified'
      },
      HttpStatus.CONFLICT
    );
  }
}

// Auth exceptions
export class InvalidTokenException extends HttpException {
  constructor() {
    super(
      {
        message_key: 'auth.invalid_token',
        message: 'Invalid access token'
      },
      HttpStatus.UNAUTHORIZED
    );
  }
}

export class InviteExpiredException extends HttpException {
  constructor() {
    super(
      {
        message_key: 'invite.invalid_or_expired',
        message: 'Invite link is invalid or expired'
      },
      HttpStatus.BAD_REQUEST
    );
  }
}

// File exceptions
export class InvalidFileTypeException extends HttpException {
  constructor() {
    super(
      {
        message_key: 'file.invalid_type',
        message: 'File type not allowed'
      },
      HttpStatus.BAD_REQUEST
    );
  }
}

export class FileTooLargeException extends HttpException {
  constructor() {
    super(
      {
        message_key: 'file.too_large',
        message: 'File size exceeds maximum allowed'
      },
      HttpStatus.BAD_REQUEST
    );
  }
}
```

### Message Key Catalog

All message keys for i18n support:

```typescript
const MESSAGE_KEYS = {
  // Auth
  'auth.invalid_token': 'Invalid access token',
  'auth.missing_token': 'Access token is required',
  'auth.invalid_admin_token': 'Invalid admin token',
  'auth.not_admin': 'Admin access required',
  
  // Deal
  'deal.invalid_status_transition': 'Invalid status transition',
  'deal.missing_fields': 'Required fields are missing',
  'deal.fields_locked_after_payment': 'Fields locked after payment',
  'deal.not_authorized': 'Not authorized for this action',
  
  // Invite
  'invite.invalid_or_expired': 'Invite link is invalid or expired',
  
  // Payment
  'payment.not_ready_for_payment': 'Deal is not ready for payment',
  'payment.already_verified': 'Payment already verified',
  
  // Shipping
  'shipping.payment_not_verified': 'Payment must be verified first',
  
  // Confirmation
  'confirmation.not_shipped': 'Product must be shipped first',
  
  // Admin
  'admin.not_ready_for_release': 'Deal is not ready for release',
  'admin.already_released': 'Payment already released',
  'admin.already_refunded': 'Payment already refunded',
  
  // File
  'file.invalid_type': 'Invalid file type',
  'file.too_large': 'File too large',
  
  // Validation
  'validation.failed': 'Validation failed',
  'validation.amount.min': 'Amount must be positive',
  'validation.amount.max': 'Amount exceeds maximum',
  
  // Generic
  'error.internal': 'Internal server error',
  'error.not_found': 'Resource not found',
  'error.duplicate_entry': 'Duplicate entry'
};
```

### Retry and Idempotency

**Idempotency Keys** (for critical operations):

```typescript
@Post('/v1/admin/deals/:id/release')
async releasePayment(
  @Param('id') dealId: string,
  @Body() dto: ReleasePaymentDto,
  @Headers('idempotency-key') idempotencyKey?: string
) {
  // Check if operation already completed
  const deal = await this.dealsService.findOne(dealId);
  
  if (deal.status === DealStatus.RELEASED) {
    throw new PaymentAlreadyReleasedException();
  }
  
  // If idempotency key provided, check for duplicate request
  if (idempotencyKey) {
    const existing = await this.idempotencyService.check(idempotencyKey);
    if (existing) {
      return existing.response; // Return cached response
    }
  }
  
  // Perform operation
  const result = await this.adminService.releasePayment(dealId, dto);
  
  // Cache result if idempotency key provided
  if (idempotencyKey) {
    await this.idempotencyService.store(idempotencyKey, result);
  }
  
  return result;
}
```

**Notification Retry Logic**:

```typescript
async sendTelegramNotification(
  chatId: string,
  message: string,
  retries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await this.telegram.sendMessage(chatId, message);
      return; // Success
    } catch (error) {
      if (attempt === retries) {
        // Log failure but don't throw (notifications are non-critical)
        this.logger.error(
          `Failed to send Telegram notification after ${retries} attempts`,
          error
        );
        return;
      }
      
      // Exponential backoff
      await this.sleep(Math.pow(2, attempt) * 1000);
    }
  }
}
```


## Testing Strategy

### Testing Pyramid

```
                    /\
                   /  \
                  / E2E \
                 /--------\
                /          \
               / Integration \
              /--------------\
             /                \
            /   Unit Tests     \
           /____________________\
```

**Distribution**:
- Unit Tests: 70% (fast, isolated, comprehensive)
- Integration Tests: 25% (database, external services)
- E2E Tests: 5% (critical user flows)

### Unit Testing

**Framework**: Jest (built-in with NestJS)

**Coverage Targets**:
- Overall: 80% minimum
- Critical modules (Deal, Payment, Status Engine): 95% minimum
- Utility functions: 100%

**Unit Test Examples**:

```typescript
// Status Engine Tests
describe('StatusEngine', () => {
  describe('transition validation', () => {
    it('should allow DRAFT → AWAITING_COUNTERPARTY', () => {
      const engine = new StatusEngine();
      const isValid = engine.isValidTransition(
        DealStatus.DRAFT,
        DealStatus.AWAITING_COUNTERPARTY
      );
      expect(isValid).toBe(true);
    });
    
    it('should reject SHIPPED → DRAFT', () => {
      const engine = new StatusEngine();
      const isValid = engine.isValidTransition(
        DealStatus.SHIPPED,
        DealStatus.DRAFT
      );
      expect(isValid).toBe(false);
    });
    
    it('should allow DISPUTED → RELEASE_PENDING', () => {
      const engine = new StatusEngine();
      const isValid = engine.isValidTransition(
        DealStatus.DISPUTED,
        DealStatus.RELEASE_PENDING
      );
      expect(isValid).toBe(true);
    });
  });
  
  describe('precondition checks', () => {
    it('should require both approvals for READY_FOR_PAYMENT', async () => {
      const deal = createMockDeal({
        status: DealStatus.AWAITING_BOTH_APPROVAL,
        participants: [
          { role: 'buyer', approved_at: new Date() },
          { role: 'seller', approved_at: null }
        ]
      });
      
      const engine = new StatusEngine();
      const canTransition = await engine.checkPreconditions(
        deal,
        DealStatus.READY_FOR_PAYMENT
      );
      
      expect(canTransition).toBe(false);
    });
  });
});

// Missing Fields Calculator Tests
describe('MissingFieldsCalculator', () => {
  it('should identify missing product title', () => {
    const deal = createMockDeal({
      product: { product_title: null, amount: 100 }
    });
    
    const calculator = new MissingFieldsCalculator();
    const missing = calculator.calculate(deal);
    
    expect(missing).toContain('product.title');
  });
  
  it('should identify missing seller payout KHQR', () => {
    const deal = createMockDeal({
      participants: [
        { role: 'buyer', name: 'John' },
        { role: 'seller', name: 'Jane', payout_khqr_image_url: null }
      ]
    });
    
    const calculator = new MissingFieldsCalculator();
    const missing = calculator.calculate(deal);
    
    expect(missing).toContain('seller.payout_khqr');
  });
  
  it('should return empty array when all fields complete', () => {
    const deal = createMockDeal({
      product: { product_title: 'iPhone', product_type: 'electronics', amount: 500 },
      participants: [
        { role: 'buyer', name: 'John' },
        { role: 'seller', name: 'Jane', payout_khqr_image_url: 'https://...' }
      ]
    });
    
    const calculator = new MissingFieldsCalculator();
    const missing = calculator.calculate(deal);
    
    expect(missing).toEqual([]);
  });
});

// Token Hashing Tests
describe('TokenService', () => {
  it('should generate unique tokens', () => {
    const service = new TokenService();
    const token1 = service.generateAccessToken();
    const token2 = service.generateAccessToken();
    
    expect(token1.accessToken).not.toEqual(token2.accessToken);
  });
  
  it('should hash tokens securely', async () => {
    const service = new TokenService();
    const { accessToken, accessTokenHash } = service.generateAccessToken();
    
    expect(accessTokenHash).not.toEqual(accessToken);
    expect(accessTokenHash.length).toBeGreaterThan(50);
  });
  
  it('should validate correct tokens', async () => {
    const service = new TokenService();
    const { accessToken, accessTokenHash } = service.generateAccessToken();
    
    const isValid = await service.validateToken(accessToken, accessTokenHash);
    expect(isValid).toBe(true);
  });
  
  it('should reject incorrect tokens', async () => {
    const service = new TokenService();
    const { accessTokenHash } = service.generateAccessToken();
    
    const isValid = await service.validateToken('wrong-token', accessTokenHash);
    expect(isValid).toBe(false);
  });
});
```

### Integration Testing

**Framework**: Jest with Test Containers (MySQL)

**Scope**:
- Database operations (Prisma)
- Service layer interactions
- Transaction handling
- Notification dispatch

**Integration Test Examples**:

```typescript
describe('DealsService Integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dealsService: DealsService;
  
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    
    app = moduleRef.createNestApplication();
    await app.init();
    
    prisma = app.get(PrismaService);
    dealsService = app.get(DealsService);
  });
  
  afterAll(async () => {
    await app.close();
  });
  
  beforeEach(async () => {
    // Clean database before each test
    await prisma.deal.deleteMany();
    await prisma.participant.deleteMany();
  });
  
  describe('buyer-created flow', () => {
    it('should create deal with buyer as creator', async () => {
      const dto: CreateDealDto = {
        source: 'web',
        creator_role: 'buyer',
        language: 'en',
        product_title: 'iPhone 15',
        amount: 500,
        creator_name: 'John Doe'
      };
      
      const result = await dealsService.create(dto);
      
      expect(result.public_id).toBeDefined();
      expect(result.status).toBe(DealStatus.AWAITING_COUNTERPARTY);
      expect(result.creator_access_url).toContain(result.public_id);
      expect(result.invite_url).toContain('invite=');
      
      // Verify database state
      const deal = await prisma.deal.findUnique({
        where: { public_id: result.public_id },
        include: { participants: true }
      });
      
      expect(deal).toBeDefined();
      expect(deal.participants).toHaveLength(1);
      expect(deal.participants[0].role).toBe('buyer');
    });
    
    it('should allow seller to join', async () => {
      // Create deal
      const createDto: CreateDealDto = {
        source: 'web',
        creator_role: 'buyer',
        language: 'en',
        product_title: 'iPhone 15',
        amount: 500,
        creator_name: 'John Doe'
      };
      
      const deal = await dealsService.create(createDto);
      const inviteToken = extractInviteToken(deal.invite_url);
      
      // Join as seller
      const joinDto: JoinDealDto = {
        invite_token: inviteToken,
        name: 'Jane Smith',
        preferred_language: 'en'
      };
      
      const result = await dealsService.join(deal.public_id, joinDto);
      
      expect(result.status).toBe(DealStatus.AWAITING_BOTH_APPROVAL);
      expect(result.participant_access_url).toBeDefined();
      
      // Verify database state
      const updatedDeal = await prisma.deal.findUnique({
        where: { public_id: deal.public_id },
        include: { participants: true }
      });
      
      expect(updatedDeal.participants).toHaveLength(2);
      expect(updatedDeal.participants.find(p => p.role === 'seller')).toBeDefined();
    });
  });
  
  describe('payment verification flow', () => {
    it('should create ledger entries on payment verification', async () => {
      // Setup: Create deal in PAYMENT_PENDING_VERIFICATION status
      const deal = await createTestDeal({
        status: DealStatus.PAYMENT_PENDING_VERIFICATION,
        amount: 100,
        fee_amount: 5
      });
      
      const payment = await createTestPayment({
        deal_id: deal.id,
        paid_amount: 100
      });
      
      // Verify payment
      await paymentsService.verify(payment.id, { admin_note: 'Verified' });
      
      // Check ledger entries
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { deal_id: deal.id },
        orderBy: { created_at: 'asc' }
      });
      
      expect(ledgerEntries).toHaveLength(2);
      expect(ledgerEntries[0].entry_type).toBe(LedgerEntryType.ESCROW_RECEIVED);
      expect(ledgerEntries[0].amount).toBe(100);
      expect(ledgerEntries[1].entry_type).toBe(LedgerEntryType.PLATFORM_FEE_RESERVED);
      expect(ledgerEntries[1].amount).toBe(5);
      
      // Check deal status
      const updatedDeal = await prisma.deal.findUnique({
        where: { id: deal.id }
      });
      expect(updatedDeal.status).toBe(DealStatus.SELLER_PREPARING);
    });
  });
  
  describe('dispute resolution flow', () => {
    it('should refund buyer when dispute resolved in their favor', async () => {
      // Setup: Create disputed deal
      const deal = await createTestDeal({
        status: DealStatus.DISPUTED,
        amount: 100
      });
      
      const dispute = await createTestDispute({
        deal_id: deal.id,
        opened_by_role: 'buyer',
        reason: DisputeReason.ITEM_NOT_RECEIVED
      });
      
      // Resolve dispute with refund
      await disputesService.resolve(dispute.id, {
        decision: 'refund',
        admin_note: 'Item not received, refunding buyer'
      });
      
      // Check ledger entries
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { deal_id: deal.id, entry_type: { in: [
          LedgerEntryType.BUYER_REFUND_PENDING,
          LedgerEntryType.BUYER_REFUND_SENT
        ]}}
      });
      
      expect(ledgerEntries).toHaveLength(2);
      
      // Check deal status
      const updatedDeal = await prisma.deal.findUnique({
        where: { id: deal.id }
      });
      expect(updatedDeal.status).toBe(DealStatus.REFUNDED);
    });
  });
});
```

### End-to-End Testing

**Framework**: Supertest (HTTP testing)

**Scope**:
- Complete user flows
- API contract validation
- Authentication flows

**E2E Test Examples**:

```typescript
describe('Complete Buyer-Created Flow (E2E)', () => {
  let app: INestApplication;
  let buyerToken: string;
  let sellerToken: string;
  let publicId: string;
  
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    
    app = moduleRef.createNestApplication();
    await app.init();
  });
  
  afterAll(async () => {
    await app.close();
  });
  
  it('1. Buyer creates deal', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/deals')
      .send({
        source: 'web',
        creator_role: 'buyer',
        language: 'en',
        product_title: 'iPhone 15 Pro',
        product_type: 'electronics',
        amount: 800,
        currency: 'USD',
        creator_name: 'John Buyer',
        creator_phone: '+85512345678'
      })
      .expect(201);
    
    expect(response.body.public_id).toBeDefined();
    expect(response.body.status).toBe('AWAITING_COUNTERPARTY');
    expect(response.body.creator_access_url).toBeDefined();
    expect(response.body.invite_url).toBeDefined();
    
    publicId = response.body.public_id;
    buyerToken = extractAccessToken(response.body.creator_access_url);
  });
  
  it('2. Seller joins deal', async () => {
    // First, get invite token from previous step
    const dealResponse = await request(app.getHttpServer())
      .get(`/v1/deals/${publicId}`)
      .set('X-Access-Token', buyerToken)
      .expect(200);
    
    const inviteToken = extractInviteToken(dealResponse.body.invite_url);
    
    // Join as seller
    const response = await request(app.getHttpServer())
      .post(`/v1/deals/${publicId}/join`)
      .send({
        invite_token: inviteToken,
        name: 'Jane Seller',
        phone: '+85587654321',
        preferred_language: 'en'
      })
      .expect(200);
    
    expect(response.body.status).toBe('AWAITING_BOTH_APPROVAL');
    expect(response.body.participant_access_url).toBeDefined();
    
    sellerToken = extractAccessToken(response.body.participant_access_url);
  });
  
  it('3. Seller adds payout KHQR', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/deals/${publicId}/sections/payout`)
      .set('X-Access-Token', sellerToken)
      .send({
        payout_khqr_image_url: 'https://storage.example.com/khqr123.jpg'
      })
      .expect(200);
  });
  
  it('4. Both participants approve', async () => {
    // Buyer approves
    await request(app.getHttpServer())
      .post(`/v1/deals/${publicId}/approval`)
      .set('X-Access-Token', buyerToken)
      .send({ approve: true })
      .expect(200);
    
    // Seller approves
    const response = await request(app.getHttpServer())
      .post(`/v1/deals/${publicId}/approval`)
      .set('X-Access-Token', sellerToken)
      .send({ approve: true })
      .expect(200);
    
    expect(response.body.status).toBe('READY_FOR_PAYMENT');
  });
  
  it('5. Buyer uploads payment proof', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/deals/${publicId}/payment-proofs`)
      .set('X-Access-Token', buyerToken)
      .attach('proof_image', Buffer.from('fake-image'), 'receipt.jpg')
      .field('paid_amount', '800')
      .field('buyer_note', 'Paid via ABA Bank')
      .expect(201);
    
    expect(response.body.status).toBe('PAYMENT_PENDING_VERIFICATION');
  });
  
  // Remaining steps would continue the flow...
});
```

### Test Data Factories

```typescript
// Test data factories for consistent test setup
export class TestDataFactory {
  static createDeal(overrides?: Partial<Deal>): Deal {
    return {
      id: uuid(),
      public_id: generatePublicId(),
      creator_role: 'buyer',
      source: 'web',
      status: DealStatus.DRAFT,
      currency: 'USD',
      amount: 100,
      fee_amount: 5,
      net_seller_amount: 95,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: addDays(new Date(), 30),
      ...overrides
    };
  }
  
  static createParticipant(overrides?: Partial<Participant>): Participant {
    return {
      id: uuid(),
      deal_id: uuid(),
      role: 'buyer',
      name: 'Test User',
      preferred_language: 'en',
      access_token_hash: 'hashed_token',
      created_at: new Date(),
      ...overrides
    };
  }
  
  static createPayment(overrides?: Partial<Payment>): Payment {
    return {
      id: uuid(),
      deal_id: uuid(),
      expected_amount: 100,
      paid_amount: 100,
      currency: 'USD',
      payment_method: 'bakong_khqr',
      receiver_account_label: 'BothSafe Escrow',
      proof_image_url: 'https://storage.example.com/proof.jpg',
      admin_status: 'pending',
      created_at: new Date(),
      ...overrides
    };
  }
}
```


### Property-Based Testing Assessment

**Conclusion**: Property-based testing is **NOT the primary testing strategy** for this backend system.

**Rationale**:

1. **Infrastructure-Heavy**: The system primarily involves database operations, external service integration (Telegram Bot API, object storage), and configuration management. These are not pure functions suitable for PBT.

2. **State Machine with Side Effects**: The Deal Room status transitions have significant side effects (creating ledger entries, sending notifications, updating multiple database tables). PBT works best with pure functions.

3. **Manual Operations**: Core operations require manual admin verification and intervention, not algorithmic transformations that can be tested with generated inputs.

4. **CRUD Operations**: Most endpoints are create/read/update operations on database records, which are better tested with example-based integration tests.

**Limited PBT Opportunities**:

While PBT is not the primary strategy, a few utility functions could benefit from property-based tests:

- **Token Generation/Validation**: Round-trip property (generate → hash → validate)
- **Missing Fields Calculator**: Deterministic output based on deal state
- **Status Transition Validator**: Pure function checking if transition is valid

**Recommended Testing Approach**:

- **Unit Tests (70%)**: Example-based tests for service methods, validators, utilities
- **Integration Tests (25%)**: Database operations, service interactions, transaction handling
- **E2E Tests (5%)**: Complete user flows through HTTP API
- **Limited PBT**: Only for pure utility functions (token validation, field calculation)


## API Endpoint Specifications

### Public API Endpoints (`/v1`)

#### Deal Management

**POST /v1/deals**
- **Description**: Create a new Deal Room
- **Authentication**: None (anonymous)
- **Rate Limit**: 5 requests/minute per IP
- **Request Body**:
  ```typescript
  {
    source: 'web' | 'telegram';
    creator_role: 'buyer' | 'seller';
    language: 'km' | 'en' | 'zh';
    product_title?: string;
    product_type?: string;
    product_description?: string;
    amount?: number;
    currency?: string;
    creator_name?: string;
    creator_phone?: string;
    telegram_chat_id?: string;
  }
  ```
- **Response**: `201 Created`
  ```typescript
  {
    public_id: string;
    status: DealStatus;
    creator_access_url: string;
    invite_url: string;
    missing_fields: string[];
    next_required_action: string;
  }
  ```

**GET /v1/deals/:publicId**
- **Description**: Retrieve Deal Room details
- **Authentication**: Participant `X-Access-Token`, `?access=...` during initial link capture, admin `Authorization: Bearer`, or `?invite=...` for redacted join preview
- **Rate Limit**: 30 requests/minute per token
- **Response**: `200 OK`
  ```typescript
  {
    public_id: string;
    status: DealStatus;
    creator_role: 'buyer' | 'seller';
    current_user_role?: 'buyer' | 'seller';
    participants: Participant[];
    product: Product;
    amount: number;
    fee_amount: number;
    net_seller_amount: number;
    payment_summary?: PaymentSummary;
    shipping_summary?: ShippingSummary;
    dispute_summary?: DisputeSummary;
    timeline: TimelineEvent[];
    missing_fields: string[];
    allowed_actions: string[];
  }
  ```
- **Invite Preview Response**: `200 OK` with redacted fields only
  ```typescript
  {
    public_id: string;
    status: DealStatus;
    creator_role: 'buyer' | 'seller';
    counterparty_role: 'buyer' | 'seller';
    product: Pick<Product, 'title' | 'type' | 'description'>;
    amount: number;
    currency: string;
    missing_fields: string[];
    allowed_actions: ['join'];
  }
  ```

**POST /v1/deals/:publicId/join**
- **Description**: Join Deal Room as counterparty
- **Authentication**: Invite token in request body
- **Rate Limit**: 10 requests/minute per IP
- **Request Body**:
  ```typescript
  {
    invite_token: string;
    role: 'buyer' | 'seller'; // must match server-derived counterparty_role
    name: string;
    phone?: string;
    preferred_language: 'km' | 'en' | 'zh';
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    participant_access_url: string;
    status: DealStatus;
    missing_fields: string[];
    allowed_actions: string[];
  }
  ```

**PATCH /v1/deals/:publicId/sections/product**
- **Description**: Update product information
- **Authentication**: Access token
- **Request Body**:
  ```typescript
  {
    product_title?: string;
    product_type?: string;
    product_description?: string;
    product_image_url?: string;
    quantity?: number;
    condition?: string;
  }
  ```
- **Response**: `200 OK` (full deal response)

**PATCH /v1/deals/:publicId/sections/participant**
- **Description**: Update participant information
- **Authentication**: Access token
- **Request Body**:
  ```typescript
  {
    name?: string;
    phone?: string;
    telegram_chat_id?: string;
    wechat_id?: string;
    messenger_name?: string;
  }
  ```
- **Response**: `200 OK` (full deal response)

**PATCH /v1/deals/:publicId/sections/delivery**
- **Description**: Update delivery information
- **Authentication**: Access token
- **Request Body**:
  ```typescript
  {
    delivery_address?: string;
    delivery_city?: string;
    delivery_notes?: string;
  }
  ```
- **Response**: `200 OK` (full deal response)

**PATCH /v1/deals/:publicId/sections/payout**
- **Description**: Update seller payout information
- **Authentication**: Access token (seller only)
- **Request Body**:
  ```typescript
  {
    payout_khqr_image_url: string;
  }
  ```
- **Response**: `200 OK` (full deal response)

**POST /v1/deals/:publicId/approval**
- **Description**: Approve deal terms
- **Authentication**: Access token
- **Request Body**:
  ```typescript
  {
    approve: true;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    status: DealStatus;
    approved_by: 'buyer' | 'seller';
    missing_approvals: string[];
    allowed_actions: string[];
  }
  ```

#### Payment Operations

**POST /v1/deals/:publicId/payment-proofs**
- **Description**: Upload payment proof
- **Authentication**: Access token (buyer only)
- **Rate Limit**: 3 requests/hour per deal
- **Request**: Multipart form data
  ```typescript
  {
    proof_image: File;
    paid_amount: number;
    buyer_note?: string;
  }
  ```
- **Response**: `201 Created`
  ```typescript
  {
    payment_id: string;
    status: 'PAYMENT_PENDING_VERIFICATION';
    message_key: 'payment.proof_uploaded';
  }
  ```

#### Shipping Operations

**POST /v1/deals/:publicId/shipping-proofs**
- **Description**: Upload shipping proof
- **Authentication**: Access token (seller only)
- **Request**: Multipart form data
  ```typescript
  {
    delivery_company?: string;
    tracking_number?: string;
    package_photo?: File;
    delivery_receipt?: File;
    seller_note?: string;
  }
  ```
- **Response**: `201 Created`
  ```typescript
  {
    shipping_id: string;
    status: 'SHIPPED';
    message_key: 'shipping.proof_uploaded';
  }
  ```

#### Confirmation Operations

**POST /v1/deals/:publicId/confirm-received**
- **Description**: Buyer confirms product received
- **Authentication**: Access token (buyer only)
- **Response**: `200 OK`
  ```typescript
  {
    status: 'RELEASE_PENDING';
    message_key: 'confirmation.received';
  }
  ```

#### Dispute Operations

**POST /v1/deals/:publicId/disputes**
- **Description**: Open a dispute
- **Authentication**: Access token
- **Request**: Multipart form data
  ```typescript
  {
    reason: DisputeReason;
    message: string;
    evidence_files?: File[];
  }
  ```
- **Response**: `201 Created`
  ```typescript
  {
    dispute_id: string;
    status: 'DISPUTED';
    message_key: 'dispute.opened';
  }
  ```

### Admin API Endpoints (`/v1/admin`)

**POST /v1/admin/login**
- **Description**: Admin login
- **Authentication**: None
- **Rate Limit**: 5 attempts/15 minutes per IP
- **Request Body**:
  ```typescript
  {
    email: string;
    password: string;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }
  ```

**GET /v1/admin/deals**
- **Description**: List all deals with filters
- **Authentication**: Admin JWT
- **Query Parameters**:
  ```typescript
  {
    status?: DealStatus;
    from_date?: string;
    to_date?: string;
    search?: string;
    page?: number;
    limit?: number;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    deals: DealSummary[];
    total: number;
    page: number;
    limit: number;
  }
  ```

**GET /v1/admin/deals/:id**
- **Description**: Get full deal details
- **Authentication**: Admin JWT
- **Response**: `200 OK` (full deal response with admin-only fields)

**POST /v1/admin/payment-proofs/:id/verify**
- **Description**: Verify payment proof
- **Authentication**: Admin JWT
- **Request Body**:
  ```typescript
  {
    admin_note?: string;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    deal_status: 'SELLER_PREPARING';
    ledger_entries: LedgerEntry[];
    message_key: 'admin.payment_verified';
  }
  ```

**POST /v1/admin/payment-proofs/:id/reject**
- **Description**: Reject payment proof
- **Authentication**: Admin JWT
- **Request Body**:
  ```typescript
  {
    rejection_reason: string;
    admin_note?: string;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    deal_status: 'READY_FOR_PAYMENT';
    rejected_reason: string;
    message_key: 'admin.payment_rejected';
  }
  ```

**POST /v1/admin/deals/:id/release**
- **Description**: Release payment to seller
- **Authentication**: Admin JWT
- **Request Body**:
  ```typescript
  {
    payout_reference: string;
    admin_note?: string;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    status: 'RELEASED';
    ledger_entries: LedgerEntry[];
    message_key: 'admin.payment_released';
  }
  ```

**POST /v1/admin/deals/:id/refund**
- **Description**: Refund payment to buyer
- **Authentication**: Admin JWT
- **Request Body**:
  ```typescript
  {
    refund_reference: string;
    admin_note?: string;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    status: 'REFUNDED';
    ledger_entries: LedgerEntry[];
    message_key: 'admin.payment_refunded';
  }
  ```

**POST /v1/admin/disputes/:id/resolve**
- **Description**: Resolve a dispute
- **Authentication**: Admin JWT
- **Request Body**:
  ```typescript
  {
    decision: 'release' | 'refund';
    admin_note: string;
  }
  ```
- **Response**: `200 OK`
  ```typescript
  {
    dispute_status: 'resolved_release' | 'resolved_refund';
    deal_status: 'RELEASE_PENDING' | 'REFUNDED';
    message_key: 'admin.dispute_resolved';
  }
  ```

### Health Check Endpoint

**GET /health**
- **Description**: System health check
- **Authentication**: None
- **Response**: `200 OK` or `503 Service Unavailable`
  ```typescript
  {
    status: 'ok' | 'error';
    timestamp: string;
    checks: {
      database: 'up' | 'down';
      storage: 'up' | 'down';
      telegram_bot?: 'up' | 'down' | 'disabled';
    }
  }
  ```


## Notification System Design

### Architecture

```mermaid
graph LR
    Service[Deal/Payment/Shipping Service] -->|Emit Event| NotificationService
    NotificationService -->|Create Record| DB[(Database)]
    NotificationService -->|Dispatch| BotNotifier[Bot Notifier]
    BotNotifier -->|Send Message| TelegramAPI[Telegram Bot API]
    NotificationService -->|Future| EmailNotifier[Email Notifier]
    NotificationService -->|Future| SMSNotifier[SMS Notifier]
    
    style NotificationService fill:#3498db
    style BotNotifier fill:#9b59b6
```

### Event-Driven Notification Flow

**1. Event Emission**:
```typescript
// In DealsService
async approveByParticipant(dealId: string, participantId: string) {
  // ... business logic ...
  
  // Emit notification event
  await this.notificationService.emit({
    event: NotificationEvent.BOTH_APPROVED,
    deal_id: dealId,
    recipient_role: 'buyer', // and 'seller'
    language: participant.preferred_language,
    data: {
      deal_public_id: deal.public_id,
      product_title: deal.product.product_title,
      amount: deal.amount
    }
  });
}
```

**2. Notification Creation**:
```typescript
// In NotificationService
async emit(payload: NotificationPayload): Promise<void> {
  // Create notification record in database
  const notification = await this.prisma.notification.create({
    data: {
      deal_id: payload.deal_id,
      recipient_participant_id: this.getRecipientId(payload),
      event: payload.event,
      message_key: this.getMessageKey(payload.event),
      data: payload.data,
      telegram_sent: false
    }
  });
  
  // Dispatch to channels (async, non-blocking)
  this.dispatchToChannels(notification, payload).catch(error => {
    this.logger.error('Notification dispatch failed', error);
    // Don't throw - notification failure should not block transaction
  });
}
```

**3. Channel Dispatch**:
```typescript
private async dispatchToChannels(
  notification: Notification,
  payload: NotificationPayload
): Promise<void> {
  const participant = await this.getRecipient(payload);
  
  // Telegram notification
  if (participant.telegram_chat_id) {
    await this.dispatchToTelegram(notification, participant, payload);
  }
  
  // Future: Email notification
  if (participant.email) {
    await this.dispatchToEmail(notification, participant, payload);
  }
  
  // Future: SMS notification
  if (participant.phone) {
    await this.dispatchToSMS(notification, participant, payload);
  }
}
```

**4. Telegram Dispatch**:
```typescript
private async dispatchToTelegram(
  notification: Notification,
  participant: Participant,
  payload: NotificationPayload
): Promise<void> {
  try {
    const message = this.formatTelegramMessage(payload);
    const keyboard = this.createInlineKeyboard(payload);
    
    await this.botNotifier.sendNotification(
      participant.telegram_chat_id,
      message,
      keyboard
    );
    
    // Mark as sent
    await this.prisma.notification.update({
      where: { id: notification.id },
      data: {
        telegram_sent: true,
        telegram_sent_at: new Date()
      }
    });
  } catch (error) {
    this.logger.error(
      `Failed to send Telegram notification ${notification.id}`,
      error
    );
    // Don't throw - log and continue
  }
}
```

### Notification Message Templates

**Message Formatting**:
```typescript
class NotificationMessageFormatter {
  format(event: NotificationEvent, data: any, language: string): string {
    const templates = this.getTemplates(language);
    const template = templates[event];
    
    return this.interpolate(template, data);
  }
  
  private getTemplates(language: string): Record<NotificationEvent, string> {
    const templates = {
      km: {
        COUNTERPARTY_JOINED: '🎉 {counterparty_name} បានចូលរួមក្នុង Deal Room របស់អ្នក',
        BOTH_APPROVED: '✅ ភាគីទាំងពីរបានយល់ព្រម! ឥឡូវអ្នកទិញអាចបង់ប្រាក់',
        PAYMENT_VERIFIED: '💰 ការទូទាត់ត្រូវបានផ្ទៀងផ្ទាត់! អ្នកលក់សូមដឹកជញ្ជូនផលិតផល',
        SHIPPING_UPLOADED: '📦 អ្នកលក់បានដឹកជញ្ជូនផលិតផល',
        BUYER_CONFIRMED: '✅ អ្នកទិញបានបញ្ជាក់ថាបានទទួលផលិតផល',
        PAYOUT_RELEASED: '💸 ការទូទាត់របស់អ្នកត្រូវបានដោះលែង!',
        DISPUTE_OPENED: '⚠️ មានវិវាទត្រូវបានបើក',
        REFUND_COMPLETED: '💵 ការសងប្រាក់វិញបានបញ្ចប់'
      },
      en: {
        COUNTERPARTY_JOINED: '🎉 {counterparty_name} joined your Deal Room',
        BOTH_APPROVED: '✅ Both parties approved! Buyer can now pay',
        PAYMENT_VERIFIED: '💰 Payment verified! Seller please ship the product',
        SHIPPING_UPLOADED: '📦 Seller has shipped the product',
        BUYER_CONFIRMED: '✅ Buyer confirmed product received',
        PAYOUT_RELEASED: '💸 Your payout has been released!',
        DISPUTE_OPENED: '⚠️ A dispute has been opened',
        REFUND_COMPLETED: '💵 Refund completed'
      },
      zh: {
        COUNTERPARTY_JOINED: '🎉 {counterparty_name} 加入了您的交易室',
        BOTH_APPROVED: '✅ 双方已批准！买家现在可以付款',
        PAYMENT_VERIFIED: '💰 付款已验证！卖家请发货',
        SHIPPING_UPLOADED: '📦 卖家已发货',
        BUYER_CONFIRMED: '✅ 买家确认收到产品',
        PAYOUT_RELEASED: '💸 您的付款已发放！',
        DISPUTE_OPENED: '⚠️ 已开启争议',
        REFUND_COMPLETED: '💵 退款完成'
      }
    };
    
    return templates[language] || templates.en;
  }
  
  private interpolate(template: string, data: any): string {
    return template.replace(/{(\w+)}/g, (match, key) => {
      return data[key] || match;
    });
  }
}
```

### Inline Keyboard Buttons

```typescript
class TelegramKeyboardBuilder {
  createForNotification(event: NotificationEvent, dealPublicId: string): InlineKeyboard {
    const baseUrl = process.env.FRONTEND_URL;
    
    const buttons = [
      [
        {
          text: '🔗 Open Deal Room',
          url: `${baseUrl}/d/${dealPublicId}`
        }
      ]
    ];
    
    // Event-specific buttons
    if (event === NotificationEvent.PAYMENT_VERIFIED) {
      buttons.push([
        {
          text: '📦 Upload Shipping Proof',
          url: `${baseUrl}/d/${dealPublicId}#shipping`
        }
      ]);
    } else if (event === NotificationEvent.SHIPPING_UPLOADED) {
      buttons.push([
        {
          text: '✅ Confirm Received',
          url: `${baseUrl}/d/${dealPublicId}#confirm`
        }
      ]);
    }
    
    return { inline_keyboard: buttons };
  }
}
```

### Notification Timeline

**In-App Timeline Display**:
```typescript
async getTimeline(dealId: string): Promise<TimelineEvent[]> {
  const notifications = await this.prisma.notification.findMany({
    where: { deal_id: dealId },
    orderBy: { created_at: 'desc' },
    include: {
      recipient_participant: {
        select: { role: true, name: true }
      }
    }
  });
  
  const auditLogs = await this.prisma.auditLog.findMany({
    where: { deal_id: dealId },
    orderBy: { created_at: 'desc' }
  });
  
  // Merge and sort by timestamp
  return this.mergeTimeline(notifications, auditLogs);
}
```

### Retry Strategy

**Exponential Backoff**:
```typescript
async sendWithRetry(
  chatId: string,
  message: string,
  maxRetries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await this.telegram.sendMessage(chatId, message);
      return; // Success
    } catch (error) {
      if (attempt === maxRetries) {
        throw error; // Final attempt failed
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      await this.sleep(delay);
    }
  }
}
```

### Notification Preferences (Future)

```typescript
interface NotificationPreferences {
  participant_id: string;
  telegram_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  events: {
    [key in NotificationEvent]: boolean;
  };
}
```


## File Storage Integration

### Storage Architecture

```mermaid
graph TB
    Client[Client App] -->|1. Request Upload URL| Backend[Backend API]
    Backend -->|2. Generate Signed URL| Storage[Object Storage]
    Backend -->|3. Return Signed URL| Client
    Client -->|4. Upload File| Storage
    Client -->|5. Confirm Upload| Backend
    Backend -->|6. Store Metadata| DB[(Database)]
    
    style Backend fill:#3498db
    style Storage fill:#f39c12
```

### Storage Providers

**Supported Providers**:
1. **MinIO** (Primary and required for MVP)
2. **Local Filesystem** (optional developer fallback only, not the default MVP path)

**Configuration**:
```typescript
// config/storage.config.ts
export const storageConfig = {
  provider: process.env.STORAGE_PROVIDER || 'minio',
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
    publicEndpoint: process.env.MINIO_PUBLIC_ENDPOINT || 'http://localhost:9000',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    bucket: process.env.MINIO_BUCKET || 'bothsafe-files',
    region: process.env.MINIO_REGION || 'us-east-1',
    forcePathStyle: true
  },
  local: {
    uploadDir: process.env.LOCAL_UPLOAD_DIR || './uploads'
  }
};
```

### File Upload Flow

**1. Request Upload URL**:
```typescript
@Post('/v1/files/upload-url')
@UseGuards(DealAccessGuard)
async getUploadUrl(
  @Body() dto: RequestUploadUrlDto,
  @CurrentActor() actor: Actor
): Promise<UploadUrlResponse> {
  // Validate file type and size
  this.validateFileRequest(dto);
  
  // Generate unique file path
  const filePath = this.generateFilePath(dto.file_type, dto.deal_id);
  
  // Generate signed upload URL (valid for 5 minutes)
  const signedUrl = await this.storageService.generateUploadUrl(
    filePath,
    dto.mime_type,
    300 // 5 minutes
  );
  
  // Create pending file record
  const fileRecord = await this.prisma.file.create({
    data: {
      deal_id: dto.deal_id,
      file_type: dto.file_type,
      storage_path: filePath,
      mime_type: dto.mime_type,
      uploaded_by_role: actor.role,
      upload_status: 'pending'
    }
  });
  
  return {
    file_id: fileRecord.id,
    upload_url: signedUrl,
    expires_at: new Date(Date.now() + 300000)
  };
}
```

**2. Client Uploads File**:
```typescript
// Client-side (example)
async function uploadFile(file: File, uploadUrl: string) {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: {
      'Content-Type': file.type
    }
  });
  
  if (!response.ok) {
    throw new Error('Upload failed');
  }
  
  return response;
}
```

**3. Confirm Upload**:
```typescript
@Post('/v1/files/:fileId/confirm')
@UseGuards(DealAccessGuard)
async confirmUpload(
  @Param('fileId') fileId: string,
  @Body() dto: ConfirmUploadDto
): Promise<FileMetadata> {
  // Verify file exists in storage
  const fileRecord = await this.prisma.file.findUnique({
    where: { id: fileId }
  });
  
  const exists = await this.storageService.fileExists(fileRecord.storage_path);
  if (!exists) {
    throw new BadRequestException('file.upload_incomplete');
  }
  
  // Get file size from storage
  const metadata = await this.storageService.getMetadata(fileRecord.storage_path);
  
  // Update file record
  const updatedFile = await this.prisma.file.update({
    where: { id: fileId },
    data: {
      upload_status: 'completed',
      size_bytes: metadata.size,
      storage_url: metadata.url,
      original_filename: dto.original_filename,
      uploaded_at: new Date()
    }
  });
  
  return this.toFileMetadata(updatedFile);
}
```

### File Access Control

**Public vs Private Files**:

```typescript
enum FileAccessLevel {
  PUBLIC = 'public',      // Product images
  PRIVATE = 'private',    // Payment proofs, shipping proofs, dispute evidence
  ADMIN_ONLY = 'admin'    // Internal admin files
}

function getAccessLevel(fileType: string): FileAccessLevel {
  const publicTypes = ['product_image'];
  const adminTypes = ['admin_note_attachment'];
  
  if (publicTypes.includes(fileType)) {
    return FileAccessLevel.PUBLIC;
  } else if (adminTypes.includes(fileType)) {
    return FileAccessLevel.ADMIN_ONLY;
  } else {
    return FileAccessLevel.PRIVATE;
  }
}
```

**Signed URL Generation**:

```typescript
@Get('/v1/files/:fileId/download')
@UseGuards(DealAccessGuard)
async getDownloadUrl(
  @Param('fileId') fileId: string,
  @CurrentActor() actor: Actor
): Promise<DownloadUrlResponse> {
  const file = await this.prisma.file.findUnique({
    where: { id: fileId },
    include: { deal: true }
  });
  
  // Check access permissions
  this.checkFileAccess(file, actor);
  
  // Generate signed download URL (valid for 1 hour)
  const signedUrl = await this.storageService.generateDownloadUrl(
    file.storage_path,
    3600 // 1 hour
  );
  
  return {
    download_url: signedUrl,
    expires_at: new Date(Date.now() + 3600000),
    filename: file.original_filename
  };
}

private checkFileAccess(file: File, actor: Actor): void {
  const accessLevel = getAccessLevel(file.file_type);
  
  if (accessLevel === FileAccessLevel.PUBLIC) {
    return; // Anyone can access
  }
  
  if (accessLevel === FileAccessLevel.ADMIN_ONLY && actor.type !== 'admin') {
    throw new ForbiddenException('file.admin_only');
  }
  
  if (accessLevel === FileAccessLevel.PRIVATE) {
    // Check if actor is participant in the deal
    const isParticipant = file.deal.participants.some(
      p => p.id === actor.participant_id
    );
    
    if (!isParticipant && actor.type !== 'admin') {
      throw new ForbiddenException('file.not_authorized');
    }
  }
}
```

### Storage Service Abstraction

```typescript
interface StorageService {
  generateUploadUrl(path: string, mimeType: string, expiresIn: number): Promise<string>;
  generateDownloadUrl(path: string, expiresIn: number): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  getMetadata(path: string): Promise<FileMetadata>;
  deleteFile(path: string): Promise<void>;
}

@Injectable()
export class MinioStorageService implements StorageService {
  private client: S3Client;
  
  constructor() {
    this.client = new S3Client({
      endpoint: storageConfig.minio.endpoint,
      region: storageConfig.minio.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: storageConfig.minio.accessKey,
        secretAccessKey: storageConfig.minio.secretKey
      }
    });
  }
  
  async generateUploadUrl(
    path: string,
    mimeType: string,
    expiresIn: number
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: storageConfig.minio.bucket,
      Key: path,
      ContentType: mimeType
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
  
  async generateDownloadUrl(path: string, expiresIn: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: storageConfig.minio.bucket,
      Key: path
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
  
  async fileExists(path: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: storageConfig.minio.bucket,
        Key: path
      }));
      return true;
    } catch {
      return false;
    }
  }
  
  async getMetadata(path: string): Promise<FileMetadata> {
    const metadata = await this.client.send(new HeadObjectCommand({
      Bucket: storageConfig.minio.bucket,
      Key: path
    }));
    
    return {
      size: metadata.ContentLength ?? 0,
      url: this.getPublicUrl(path),
      contentType: metadata.ContentType
    };
  }
  
  async deleteFile(path: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: storageConfig.minio.bucket,
      Key: path
    }));
  }
  
  private getPublicUrl(path: string): string {
    return `${storageConfig.minio.publicEndpoint}/${storageConfig.minio.bucket}/${path}`;
  }
}
```

### File Path Structure

```
/{bucket}/
  /deals/
    /{deal_public_id}/
      /product/
        /{timestamp}_{random}_{filename}
      /payment/
        /{timestamp}_{random}_{filename}
      /shipping/
        /{timestamp}_{random}_{filename}
      /dispute/
        /{timestamp}_{random}_{filename}
```

**Path Generation**:
```typescript
function generateFilePath(
  fileType: string,
  dealPublicId: string,
  originalFilename: string
): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  const sanitized = sanitizeFilename(originalFilename);
  
  const typeFolder = {
    'product_image': 'product',
    'payment_proof': 'payment',
    'shipping_proof': 'shipping',
    'dispute_evidence': 'dispute'
  }[fileType] || 'other';
  
  return `deals/${dealPublicId}/${typeFolder}/${timestamp}_${random}_${sanitized}`;
}
```

### Cleanup Strategy

**Orphaned File Cleanup**:
```typescript
@Cron('0 2 * * *') // Run daily at 2 AM
async cleanupOrphanedFiles(): Promise<void> {
  // Find files in 'pending' status older than 24 hours
  const orphanedFiles = await this.prisma.file.findMany({
    where: {
      upload_status: 'pending',
      created_at: {
        lt: new Date(Date.now() - 24 * 60 * 60 * 1000)
      }
    }
  });
  
  for (const file of orphanedFiles) {
    try {
      // Delete from storage
      await this.storageService.deleteFile(file.storage_path);
      
      // Delete database record
      await this.prisma.file.delete({
        where: { id: file.id }
      });
      
      this.logger.log(`Cleaned up orphaned file: ${file.id}`);
    } catch (error) {
      this.logger.error(`Failed to cleanup file ${file.id}`, error);
    }
  }
}
```


## Deployment Architecture

### Environment Configuration

**Development**:
```bash
NODE_ENV=development
PORT=3001
DATABASE_URL=mysql://bothsafe:dev_password@localhost:3306/bothsafe_dev
FRONTEND_URL=http://localhost:3000
TELEGRAM_BOT_TOKEN=dev_bot_token
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_PUBLIC_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=bothsafe_minio
MINIO_SECRET_KEY=bothsafe_minio_password
MINIO_BUCKET=bothsafe-files
JWT_SECRET=dev_secret
CORS_ORIGINS=http://localhost:3000
```

**Staging**:
```bash
NODE_ENV=staging
PORT=3001
DATABASE_URL=mysql://bothsafe:staging_password@staging-mysql:3306/bothsafe_staging
FRONTEND_URL=https://staging.bothsafe.app
TELEGRAM_BOT_TOKEN=staging_bot_token
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=https://staging-minio.bothsafe.internal
MINIO_PUBLIC_ENDPOINT=https://staging-files.bothsafe.app
MINIO_ACCESS_KEY=staging_minio_key
MINIO_SECRET_KEY=staging_minio_secret
MINIO_BUCKET=bothsafe-files
JWT_SECRET=staging_secret
CORS_ORIGINS=https://staging.bothsafe.app
```

**Production**:
```bash
NODE_ENV=production
PORT=3001
DATABASE_URL=mysql://bothsafe:prod_password@prod-mysql:3306/bothsafe_prod
FRONTEND_URL=https://bothsafe.app
TELEGRAM_BOT_TOKEN=prod_bot_token
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=https://prod-minio.bothsafe.internal
MINIO_PUBLIC_ENDPOINT=https://files.bothsafe.app
MINIO_ACCESS_KEY=prod_minio_key
MINIO_SECRET_KEY=prod_minio_secret
MINIO_BUCKET=bothsafe-files
JWT_SECRET=prod_secret
CORS_ORIGINS=https://bothsafe.app,https://admin.bothsafe.app
```

### Docker Configuration

**Dockerfile**:
```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "dist/main.js"]
```

**docker-compose.yml** (Development):
```yaml
version: '3.8'

services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_DATABASE: bothsafe_dev
      MYSQL_USER: bothsafe
      MYSQL_PASSWORD: dev_password
      MYSQL_ROOT_PASSWORD: root_dev_password
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -ubothsafe -pdev_password"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: bothsafe_minio
      MINIO_ROOT_PASSWORD: bothsafe_minio_password
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build: .
    ports:
      - "3001:3001"
    environment:
      DATABASE_URL: mysql://bothsafe:dev_password@mysql:3306/bothsafe_dev
      NODE_ENV: development
      STORAGE_PROVIDER: minio
      MINIO_ENDPOINT: http://minio:9000
      MINIO_PUBLIC_ENDPOINT: http://localhost:9000
      MINIO_ACCESS_KEY: bothsafe_minio
      MINIO_SECRET_KEY: bothsafe_minio_password
      MINIO_BUCKET: bothsafe-files
    depends_on:
      mysql:
        condition: service_healthy
      minio:
        condition: service_healthy
    volumes:
      - ./src:/app/src
    command: npm run start:dev

volumes:
  mysql_data:
  minio_data:
```

### Database Migration Strategy

**Development**:
```bash
# Create migration
npx prisma migrate dev --name add_feature_x

# Apply migrations
npx prisma migrate dev

# Reset database (destructive)
npx prisma migrate reset
```

**Production**:
```bash
# Deploy migrations (non-interactive)
npx prisma migrate deploy

# Check migration status
npx prisma migrate status
```

**Migration Rollback**:
```bash
# Manual rollback (no built-in command)
# 1. Identify migration to rollback
# 2. Create new migration that reverses changes
# 3. Apply new migration
```

### Scaling Considerations

**Horizontal Scaling**:
- Backend is stateless and can be scaled horizontally
- Use load balancer (Nginx, AWS ALB) to distribute traffic
- Session state stored in database, not in-memory

**Database Scaling**:
- Read replicas for read-heavy operations (admin dashboard)
- MySQL connection pooling or ProxySQL for high concurrency
- Partitioning for large tables (audit_logs, notifications)

**Caching Strategy** (Future):
- Redis for session storage
- Redis for rate limiting counters
- CDN for static assets and public images

### Monitoring and Observability

**Logging**:
```typescript
// Winston logger configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: 'logs/combined.log'
    })
  ]
});
```

**Metrics** (Future):
```typescript
// Prometheus metrics
import { Counter, Histogram, Gauge } from 'prom-client';

const dealCreationCounter = new Counter({
  name: 'deals_created_total',
  help: 'Total number of deals created',
  labelNames: ['source', 'creator_role']
});

const paymentVerificationDuration = new Histogram({
  name: 'payment_verification_duration_seconds',
  help: 'Time taken to verify payment',
  buckets: [0.1, 0.5, 1, 2, 5]
});

const activeDealGauge = new Gauge({
  name: 'active_deals_total',
  help: 'Number of active deals by status',
  labelNames: ['status']
});
```

**Health Checks**:
```typescript
@Controller('health')
export class HealthController {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService
  ) {}
  
  @Get()
  async check(): Promise<HealthCheckResponse> {
    const checks = {
      database: await this.checkDatabase(),
      storage: await this.checkStorage()
    };
    
    const allHealthy = Object.values(checks).every(c => c === 'up');
    
    return {
      status: allHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks
    };
  }
  
  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }
  
  private async checkStorage(): Promise<'up' | 'down'> {
    try {
      await this.storageService.healthCheck();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
```

**Error Tracking** (Future):
- Sentry for error tracking and alerting
- Structured logging for debugging
- Request ID tracking across services

### Backup and Disaster Recovery

**Database Backups**:
```bash
# Daily automated backups
0 3 * * * mysqldump -u bothsafe -p"$MYSQL_PASSWORD" bothsafe_prod | gzip > /backups/bothsafe_$(date +\%Y\%m\%d).sql.gz

# Retention: 30 days
find /backups -name "bothsafe_*.sql.gz" -mtime +30 -delete
```

**File Storage Backups**:
- MinIO bucket versioning should be enabled for `bothsafe-files`
- MinIO data volume snapshots should be included in the Docker host backup plan
- Regular backup verification tests

**Disaster Recovery Plan**:
1. Database restore from latest backup (< 24 hours old)
2. File storage restore from object storage provider
3. Redeploy application from Docker image
4. Verify data integrity with automated tests
5. RTO (Recovery Time Objective): 4 hours
6. RPO (Recovery Point Objective): 24 hours


## Future Enhancements

### Phase 2: Automation

**Automatic Payment Verification**:
- Integration with Bakong API for payment status polling
- KHQR MD5 hash matching for automatic verification
- Reduce admin manual verification workload

**Automatic Payout**:
- Integration with bank APIs for automated seller payouts
- Scheduled batch payout processing
- Payout status tracking and reconciliation

**Auto-Release Timer**:
- Automatic release after N days if buyer doesn't confirm
- Configurable timeout per deal or globally
- Notification reminders before auto-release

### Phase 3: Advanced Features

**Telegram Mini App**:
- Full Deal Room interface inside Telegram
- Payment proof upload within Telegram
- Inline deal management without leaving chat

**Merchant API**:
- REST API for merchants to create deals programmatically
- API keys and rate limiting per merchant
- Webhook notifications for deal events

**iframe Embed Widget**:
- Embeddable Deal Room for merchant websites
- Customizable branding and styling
- Secure cross-origin communication

**Delivery Tracking Integration**:
- Integration with delivery company APIs
- Real-time tracking updates
- Automatic status updates based on delivery events

### Phase 4: Platform Expansion

**Multi-Currency Support**:
- Support for USD, KHR, THB, VND
- Real-time exchange rate integration
- Currency conversion at payment time

**International Payments**:
- Binance Pay integration
- Cryptocurrency escrow support
- Cross-border payment handling

**Subscription Escrow**:
- Recurring payment escrow
- Milestone-based releases
- Subscription management

**Digital Product Escrow**:
- Instant delivery verification
- License key escrow
- Digital asset transfer

**Freelancer Milestone Escrow**:
- Multi-milestone deals
- Partial releases
- Work verification system

### Phase 5: Intelligence and Optimization

**Fraud Detection**:
- ML-based fraud scoring
- Pattern recognition for suspicious behavior
- Automatic flagging for admin review

**KYC/Identity Verification**:
- Government ID verification
- Selfie verification
- Risk-based verification requirements

**Seller/Buyer Ratings**:
- Post-transaction ratings
- Reputation scores
- Trust badges for verified users

**Analytics Dashboard**:
- Transaction volume metrics
- Success rate tracking
- User behavior analytics
- Revenue reporting

### Technical Debt and Refactoring

**Service Decomposition** (if needed at scale):
- Extract Payment Service to separate microservice
- Extract Notification Service to separate microservice
- Event-driven architecture with message queue (RabbitMQ, Kafka)

**Performance Optimization**:
- Database query optimization
- Caching layer (Redis)
- CDN for static assets
- GraphQL API for flexible queries

**Security Enhancements**:
- Two-factor authentication for admin
- Biometric authentication for mobile
- Advanced rate limiting with IP reputation
- DDoS protection

**Developer Experience**:
- OpenAPI/Swagger documentation
- SDK generation for multiple languages
- Sandbox environment for testing
- Comprehensive API examples


## Appendix

### Technology Stack Summary

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Runtime | Node.js | 20 LTS | JavaScript runtime |
| Framework | NestJS | 10.x | Backend framework |
| Language | TypeScript | 5.x | Type-safe development |
| Database | MySQL | 8.x | Primary data store |
| ORM | Prisma | 7.x | Database access layer |
| Authentication | JWT | - | Admin authentication |
| Hashing | bcrypt | - | Token hashing |
| Validation | class-validator | - | DTO validation |
| Rate Limiting | @nestjs/throttler | - | API rate limiting |
| File Storage | MinIO | Latest stable | S3-compatible object storage in Docker |
| Bot Framework | nestjs-telegraf / telegraf | - | Telegram integration |
| Testing | Jest | - | Unit & integration tests |
| Logging | Winston | - | Application logging |
| Documentation | OpenAPI/Swagger | - | API documentation |

### Key Design Decisions

**1. Monolithic Architecture for MVP**
- **Decision**: Use single NestJS application instead of microservices
- **Rationale**: Simpler deployment, faster development, easier debugging for MVP
- **Trade-off**: May need to decompose later at scale
- **Mitigation**: Clear module boundaries enable future extraction

**2. Manual Admin Operations**
- **Decision**: Admin manually verifies payments and releases funds
- **Rationale**: Reduces integration complexity, allows business process refinement
- **Trade-off**: Slower processing, requires admin availability
- **Mitigation**: Clear admin dashboard, notification system for pending actions

**3. Anonymous Participant Authentication**
- **Decision**: Use hashed access tokens instead of requiring user accounts
- **Rationale**: Lower friction for users, faster onboarding
- **Trade-off**: Users can lose access if they lose the link
- **Mitigation**: Optional user account linking, Telegram identity linking

**4. Telegram Bot as Integrated Module**
- **Decision**: Run bot inside NestJS process instead of separate service
- **Rationale**: Simpler deployment, shared business logic, easier development
- **Trade-off**: Bot downtime affects entire backend
- **Mitigation**: Robust error handling, bot failures don't block API

**5. Append-Only Ledger**
- **Decision**: Never update or delete ledger entries
- **Rationale**: Audit trail integrity, financial reconciliation
- **Trade-off**: Cannot correct mistakes easily
- **Mitigation**: ADJUSTMENT entry type for corrections

**6. Event-Driven Notifications**
- **Decision**: Emit events from services, dispatch asynchronously
- **Rationale**: Decouples notification logic from business logic
- **Trade-off**: Notification failures don't block transactions
- **Mitigation**: Retry logic, notification status tracking

**7. Signed URLs for File Access**
- **Decision**: Use time-limited signed URLs instead of proxy downloads
- **Rationale**: Reduces backend load, leverages CDN, better performance
- **Trade-off**: URLs can be shared within expiration window
- **Mitigation**: Short expiration times, access control checks

**8. Status State Machine**
- **Decision**: Centralized state machine with explicit transitions
- **Rationale**: Prevents invalid states, clear business logic, easier testing
- **Trade-off**: Rigid flow, harder to add new statuses
- **Mitigation**: Well-documented transition rules, extensible design

### Glossary of Terms

| Term | Definition |
|------|------------|
| **Deal Room** | A protected transaction workspace containing all deal information |
| **Public ID** | Short, shareable identifier for a Deal Room (e.g., `abc123`) |
| **Access Token** | Secure token granting participant access to their Deal Room |
| **Invite Token** | One-time token allowing counterparty to join a Deal Room |
| **Creator** | The participant who initiates the Deal Room |
| **Counterparty** | The participant who joins an existing Deal Room |
| **Status Engine** | State machine managing valid Deal Room status transitions |
| **Missing Fields Calculator** | Service determining incomplete required fields |
| **Ledger Entry** | Immutable financial record in the append-only ledger |
| **Audit Log** | Immutable record of critical actions in the system |
| **Notification Event** | Trigger for sending notifications to participants |
| **Admin** | Privileged user who manually verifies payments and releases funds |
| **KHQR** | Cambodia's Bakong QR payment system |
| **Escrow** | Temporary holding of buyer payment until delivery confirmation |

### API Response Examples

**Successful Deal Creation**:
```json
{
  "public_id": "abc123xyz",
  "status": "AWAITING_COUNTERPARTY",
  "creator_access_url": "https://bothsafe.app/d/abc123xyz?access=tok_creator_abc123",
  "invite_url": "https://bothsafe.app/d/abc123xyz?invite=tok_invite_xyz789",
  "missing_fields": ["seller"],
  "next_required_action": "share_invite_link"
}
```

**Deal Room Details**:
```json
{
  "public_id": "abc123xyz",
  "status": "READY_FOR_PAYMENT",
  "creator_role": "buyer",
  "current_user_role": "buyer",
  "participants": [
    {
      "role": "buyer",
      "name": "John Doe",
      "phone": "+85512345678",
      "approved_at": "2026-05-06T10:00:00Z"
    },
    {
      "role": "seller",
      "name": "Jane Smith",
      "phone": "+85587654321",
      "approved_at": "2026-05-06T10:05:00Z"
    }
  ],
  "product": {
    "product_title": "iPhone 15 Pro",
    "product_type": "electronics",
    "product_description": "Brand new, sealed box",
    "amount": 800,
    "currency": "USD",
    "quantity": 1,
    "condition": "new"
  },
  "amount": 800,
  "fee_amount": 40,
  "net_seller_amount": 760,
  "timeline": [
    {
      "event": "DEAL_CREATED",
      "timestamp": "2026-05-06T09:00:00Z",
      "actor": "buyer"
    },
    {
      "event": "COUNTERPARTY_JOINED",
      "timestamp": "2026-05-06T09:30:00Z",
      "actor": "seller"
    },
    {
      "event": "BOTH_APPROVED",
      "timestamp": "2026-05-06T10:05:00Z",
      "actor": "system"
    }
  ],
  "missing_fields": [],
  "allowed_actions": ["upload_payment_proof", "cancel_deal"]
}
```

**Error Response**:
```json
{
  "statusCode": 400,
  "message_key": "deal.missing_fields",
  "message": "Required fields are missing",
  "errors": [
    {
      "field": "product.title",
      "message_key": "validation.product.title.required",
      "constraints": {
        "required": "Product title is required"
      }
    }
  ],
  "timestamp": "2026-05-06T12:00:00.000Z",
  "path": "/v1/deals/abc123xyz/approval",
  "request_id": "req_abc123"
}
```

### Database Schema Reference

See the complete Prisma schema in `backend/prisma/schema.prisma`.

Key tables:
- `deals`: Core deal information
- `participants`: Buyer and seller records
- `products`: Product details
- `payments`: Payment proof records
- `ledger_entries`: Financial transaction log
- `shipping_proofs`: Delivery evidence
- `disputes`: Dispute records
- `files`: File metadata
- `audit_logs`: Action audit trail
- `notifications`: Notification records
- `telegram_identities`: Telegram user mapping
- `bot_conversation_states`: Bot conversation state

### Environment Variables Reference

**Required**:
- `DATABASE_URL`: MySQL connection string
- `JWT_SECRET`: Secret for JWT signing
- `TELEGRAM_BOT_TOKEN`: Telegram bot API token
- `FRONTEND_URL`: Frontend application URL
- `MINIO_ENDPOINT`: Internal MinIO endpoint for backend access
- `MINIO_PUBLIC_ENDPOINT`: Public MinIO endpoint used in signed/public URLs
- `MINIO_ACCESS_KEY`: MinIO access key
- `MINIO_SECRET_KEY`: MinIO secret key
- `MINIO_BUCKET`: MinIO bucket name

**Optional**:
- `PORT`: Server port (default: 3001)
- `NODE_ENV`: Environment (development, staging, production)
- `LOG_LEVEL`: Logging level (debug, info, warn, error)
- `CORS_ORIGINS`: Comma-separated allowed origins
- `STORAGE_PROVIDER`: Storage provider (minio)
- `MINIO_REGION`: MinIO/S3 signing region (default: us-east-1)
- `PLATFORM_FEE_PERCENTAGE`: Platform fee percentage (default: 5)
- `DEAL_EXPIRATION_DAYS`: Deal expiration days (default: 30)

### Contact and Support

**Development Team**:
- Backend Lead: [Contact Info]
- DevOps: [Contact Info]
- Security: [Contact Info]

**Documentation**:
- API Documentation: `/api/docs` (Swagger UI)
- Developer Guide: `docs/developer-guide.md`
- Deployment Guide: `docs/deployment.md`

**Issue Tracking**:
- GitHub Issues: [Repository URL]
- Bug Reports: [Issue Template]
- Feature Requests: [Issue Template]

---

**Document Version**: 1.0  
**Last Updated**: 2026-05-06  
**Status**: Draft for Review  
**Next Review Date**: TBD
