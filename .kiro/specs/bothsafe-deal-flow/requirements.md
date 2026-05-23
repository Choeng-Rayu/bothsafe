# Requirements Document

## Introduction

BothSafe Deal Flow is the evolved end-to-end protected transaction experience for the BothSafe escrow platform. It supersedes the manual MVP flow by adding authenticated user accounts, an internal BothSafe wallet for buyers and sellers, auto-generated Bakong KHQR codes for buyer payments, automatic release of escrowed funds to the seller's wallet on buyer confirmation, and an admin-gated withdrawal flow that supports any KHQR-compatible bank or traditional bank account.

The feature covers four flows that converge on the same Deal Room state machine:
1. Flow A — Seller creates the deal and invites the buyer.
2. Flow B — Buyer creates the deal and invites the seller.
3. Dispute flow — Either party opens a dispute that the admin resolves.
4. Telegram create flow — A user creates a deal through the Telegram bot, then both parties continue in the web Deal Room.

The system MUST integrate with existing BothSafe modules (Auth, Deal, Invite, Payment, Ledger, Shipping, Confirmation, Dispute, Admin, Notification, Storage, Telegram Bot) and use the canonical Deal Status enum.

## Glossary

- **BothSafe**: The escrow platform that holds buyer payment until delivery is confirmed.
- **Deal_Room**: The shared transaction page identified by a public id where both parties review, edit, approve, pay, ship, confirm, and dispute.
- **Deal_Service**: The backend service that owns the Deal Room lifecycle and status state machine.
- **Auth_Service**: The backend service responsible for user authentication via Email/password, Telegram, or Google.
- **User**: An authenticated account on BothSafe that can act as buyer, seller, or admin in different deals.
- **Buyer**: The participant role that pays for the product in a given Deal Room.
- **Seller**: The participant role that delivers the product in a given Deal Room.
- **Admin**: A privileged BothSafe operator who verifies payments (when auto-check fails), resolves disputes, and approves withdrawal payouts.
- **Creator_Access_Token**: A high-privilege token issued to the Deal Room creator that grants creator-side access via the private creator link.
- **Participant_Access_Token**: A token issued to the counterparty after they join the Deal Room.
- **Invite_Token**: A single-use token embedded in the invite link that allows the counterparty to join as the opposite role.
- **Invite_Link**: The shareable URL `https://bothsafe.app/d/{publicId}?invite={inviteToken}` sent to the counterparty.
- **Creator_Link**: The private URL `https://bothsafe.app/d/{publicId}?access={creatorAccessToken}` retained by the creator.
- **Bakong**: The Cambodian National Bank interbank payment network that issues and processes KHQR codes.
- **KHQR**: The standardized Cambodian QR payment format supported by Bakong and any participating bank.
- **KHQR_Generator**: The component that creates a dynamic KHQR string and image for a buyer payment instruction.
- **KHQR_Verifier**: The component that queries Bakong (or an equivalent provider) to confirm receipt of a KHQR payment.
- **Wallet**: The internal BothSafe balance ledger held per User and per currency. A User has at most one Wallet per supported currency.
- **Wallet_Service**: The backend service that owns Wallet balances and append-only Wallet ledger entries.
- **Withdrawal_Request**: A seller-initiated request to move funds out of the seller Wallet to a destination KHQR or bank account.
- **Admin_Service**: The backend service exposing admin-only endpoints for payment verification (fallback), dispute resolution, and withdrawal approval.
- **Notification_Service**: The backend service that dispatches in-app timeline events, Telegram messages, and admin notifications.
- **Telegram_Bot**: The BothSafe bot module that runs inside the NestJS backend and supports `/start`, `/newdeal`, `/mydeals`, and `/help`.
- **Deal_Status**: The current state of a Deal Room, drawn from the canonical enum (`DRAFT`, `AWAITING_COUNTERPARTY`, `AWAITING_BOTH_APPROVAL`, `READY_FOR_PAYMENT`, `PAYMENT_PENDING_VERIFICATION`, `PAID_ESCROWED`, `SELLER_PREPARING`, `SHIPPED`, `BUYER_CONFIRMED`, `DISPUTED`, `RELEASE_PENDING`, `RELEASED`, `REFUNDED`, `CANCELLED`, `EXPIRED`).
- **Audit_Log**: Append-only record of important actions, used for traceability and dispute review.
- **USD**: United States Dollar, one of the two supported deal currencies.
- **KHR**: Cambodian Riel, one of the two supported deal currencies.

## Requirements

### Requirement 1: User Authentication

**User Story:** As a buyer or seller, I want to sign in to BothSafe using Email/password, Telegram, or Google, so that my deals are tied to my account and my wallet balance is securely tracked.

#### Acceptance Criteria

1. THE Auth_Service SHALL support sign-in via Email/password, Telegram login, and Google login.
2. WHEN a User signs in successfully, THE Auth_Service SHALL issue a session credential bound to a single User record with a session lifetime of 24 hours from issuance.
3. IF the same external identity (Telegram id or Google sub) signs in for a second time, THEN THE Auth_Service SHALL link the session to the existing User record without creating a duplicate.
4. WHEN a User signs in with Email/password for the first time using a syntactically valid email and a password between 8 and 128 characters, THE Auth_Service SHALL create a new User record with a salted password hash.
5. IF a sign-up request fails email format validation or password length validation, THEN THE Auth_Service SHALL return an `auth.invalid_signup_data` error and SHALL NOT create a User record.
6. IF an authentication attempt fails because of invalid credentials, THEN THE Auth_Service SHALL return an `auth.invalid_credentials` error within 2 seconds and SHALL NOT issue a session credential.
7. IF a User exceeds 5 failed authentication attempts within a rolling 15-minute window, THEN THE Auth_Service SHALL reject further attempts from the same identity with an `auth.rate_limited` error until the window expires.
8. WHEN an unauthenticated request reaches a Deal Room action that requires authentication, THE Auth_Service SHALL respond with an `auth.required` error and a redirect target to the sign-in page.
9. THE Auth_Service SHALL store user passwords only as salted hashes and SHALL NOT include plaintext passwords in any response, log entry, or audit record.

### Requirement 2: Deal Creation by Seller (Flow A)

**User Story:** As a signed-in seller, I want to create a protected deal with the minimum required information, so that I can quickly share an invite link with my buyer.

#### Acceptance Criteria

1. WHEN an authenticated User submits a deal-creation request with role `seller`, THE Deal_Service SHALL require Seller_Name (1–100 characters), Product_Title (1–200 characters), Deal_Amount (between 0.01 and 999,999,999.99 with at most 2 decimal places), and Currency.
2. THE Deal_Service SHALL accept Currency values only from the case-sensitive set {USD, KHR}.
3. IF a deal-creation request from a seller is missing any of Seller_Name, Product_Title, Deal_Amount, or Currency — where "missing" means null, absent, an empty string, or a whitespace-only value — THEN THE Deal_Service SHALL reject the request with a `deal.missing_required_fields` error and SHALL NOT create a Deal Room.
4. IF a deal-creation request from a seller contains a Currency outside {USD, KHR}, a Seller_Name or Product_Title outside its length bounds, or a Deal_Amount outside its allowed range or precision, THEN THE Deal_Service SHALL reject the request with a `deal.invalid_field` error and SHALL NOT create a Deal Room.
5. THE Deal_Service SHALL NOT request optional fields (phone number, product type, product description, seller payout KHQR, payout bank info) at the seller deal-creation step, and SHALL ignore and not persist any such fields if submitted.
6. WHEN a valid seller deal-creation request succeeds, THE Deal_Service SHALL create a Deal Room with a unique public id, a Creator_Access_Token, an Invite_Token, and Deal_Status `AWAITING_COUNTERPARTY`.
7. THE Deal_Service SHALL return a Creator_Link of the form `https://bothsafe.app/d/{publicId}?access={creatorAccessToken}` and an Invite_Link of the form `https://bothsafe.app/d/{publicId}?invite={inviteToken}`.
8. THE Deal_Service SHALL store the creator role as `seller` and the linked User id on the new Deal Room.
9. THE Deal_Service SHALL store the Creator_Access_Token and Invite_Token only as hashes and SHALL return raw token values exactly once in the creation response.

### Requirement 3: Deal Creation by Buyer (Flow B)

**User Story:** As a signed-in buyer, I want to create a protected deal as the buyer, so that I can request a seller to fulfill the transaction safely.

#### Acceptance Criteria

1. WHEN an authenticated User submits a deal-creation request with role `buyer`, THE Deal_Service SHALL require Buyer_Name (1–100 characters), Product_Title (1–200 characters), Deal_Amount (between 0.01 and 999,999,999.99 with at most 2 decimal places), and Currency from the set {USD, KHR}.
2. THE Deal_Service SHALL accept optional fields Buyer_Phone (≤20 characters), Product_Type (≤50 characters), and Product_Description (≤2000 characters) on a buyer-created deal, and SHALL persist any omitted optional field as null.
3. IF a deal-creation request from a buyer is missing any of Buyer_Name, Product_Title, Deal_Amount, or Currency, or contains any field whose value violates the bounds defined in criteria 1 and 2, THEN THE Deal_Service SHALL reject the request with a `deal.missing_required_fields` error for missing required fields or a `deal.invalid_field` error for out-of-bound values, and SHALL NOT create a Deal Room.
4. WHEN a buyer deal-creation request satisfies criteria 1 and 2, THE Deal_Service SHALL create a Deal Room with a unique public id, a Creator_Access_Token, an Invite_Token, and Deal_Status `AWAITING_COUNTERPARTY`.
5. WHEN the Deal Room from criterion 4 is created, THE Deal_Service SHALL store the creator role as `buyer` and the linked User id on the new Deal Room.
6. WHEN the Deal Room from criterion 4 is created, THE Deal_Service SHALL return a Creator_Link and an Invite_Link in the same URL format as Requirement 2.

### Requirement 4: Invite Link Preview

**User Story:** As an invited counterparty, I want to see a safe preview of the deal before signing in, so that I can decide whether to join.

#### Acceptance Criteria

1. WHEN a request is received for a Deal Room URL with an Invite_Token that is non-empty, has not passed its expiration timestamp, and has not been invalidated, THE Deal_Service SHALL return within 2 seconds a preview response containing Product_Title (truncated to a maximum of 200 characters), Deal_Amount, and Currency.
2. THE Deal_Service SHALL NOT include the Creator_Access_Token, Participant_Access_Token, raw token values, token hashes, or any other creator-side or participant-side secret in the invite preview response.
3. IF the Invite_Token is missing, malformed, expired, already invalidated, or associated with a deal in `CANCELLED` or `EXPIRED` status, THEN THE Deal_Service SHALL return an `invite.invalid` error response and SHALL NOT include Product_Title, Deal_Amount, Currency, participant identities, or any deal id beyond the URL the caller already supplied.
4. THE Deal_Service SHALL serve the invite preview endpoint without requiring any authentication credential, session cookie, or access token from the caller.
5. THE Deal_Service SHALL rate-limit invite preview requests to a maximum of 30 requests per minute per source IP address.
6. IF the invite preview rate limit is exceeded, THEN THE Deal_Service SHALL return a `rate.exceeded` error response without indicating whether the supplied Invite_Token was valid.

### Requirement 5: Counterparty Join

**User Story:** As an invited counterparty, I want to sign in and join the Deal Room as the opposite role, so that the deal can move forward.

#### Acceptance Criteria

1. WHILE Deal_Status is `AWAITING_COUNTERPARTY`, THE Deal_Service SHALL accept join requests using an Invite_Token that exists for the target Deal Room, has not been invalidated, and has not passed its expiration timestamp.
2. IF an authenticated User submits a join request with an Invite_Token that satisfies criterion 1 and a valid join payload, THEN THE Deal_Service SHALL assign that User the opposite role of the creator role.
3. WHEN the joining role resolved in criterion 2 is `buyer`, THE Deal_Service SHALL require Buyer_Name (1–120 characters after trim).
4. WHEN the joining role resolved in criterion 2 is `seller`, THE Deal_Service SHALL require Seller_Name (1–120 characters after trim).
5. THE Deal_Service SHALL accept an optional phone field at the join step constrained to 5–32 characters containing only digits, spaces, hyphens, parentheses, and a single optional leading `+`.
6. WHEN a join request satisfies criteria 1 through 5, THE Deal_Service SHALL within a single database transaction set Deal_Status to `AWAITING_BOTH_APPROVAL`, issue a Participant_Access_Token to the joining User, and invalidate the Invite_Token used for the join, rolling back all three changes if any step fails.
7. IF a join request arrives after the Invite_Token has been invalidated or has passed its expiration timestamp, THEN THE Deal_Service SHALL reject the request with an `invite.consumed` error and SHALL NOT modify Deal_Status, Invite_Token state, or any participant record.
8. THE Deal_Service SHALL store the Participant_Access_Token only as a hash and SHALL return its raw value exactly once in the join response.
9. IF an unauthenticated request attempts to join, THEN THE Deal_Service SHALL reject the join request and return an `auth.required` error without modifying Deal_Status, the Invite_Token, or any participant record.
10. IF a join request fails name length validation, phone format validation, or any other field-level constraint defined in criteria 3 through 5, THEN THE Deal_Service SHALL reject the request with a `join.invalid_field` error and SHALL NOT modify Deal_Status, the Invite_Token, or any participant record.

### Requirement 6: Required Fields Before Payment

**User Story:** As either participant, I want the system to block payment until all required fields are present, so that disputes are reduced.

#### Acceptance Criteria

1. THE Deal_Service SHALL define the pre-payment required field set as Product_Title, Product_Type, Deal_Amount, Buyer_Name, and Seller_Name; a field is considered empty when its value is null, absent, or whitespace-only, and Deal_Amount is additionally considered empty when its value is outside the range 0.01 to 999,999,999.99.
2. THE Deal_Service SHALL include `missing_fields` as an array in every Deal Room response, listing each pre-payment required field that is currently empty per criterion 1, and SHALL return the array as empty when all required fields are present.
3. IF any pre-payment required field is missing per criterion 1, THEN THE Deal_Service SHALL omit `pay_now` and `submit_khqr_receipt` from `allowed_actions` and SHALL NOT transition Deal_Status to `READY_FOR_PAYMENT`.
4. WHEN every pre-payment required field is present and both participants have approved, THE Deal_Service SHALL set Deal_Status to `READY_FOR_PAYMENT`.
5. IF a required field is cleared or set to an empty value while Deal_Status is `READY_FOR_PAYMENT`, THEN THE Deal_Service SHALL revert Deal_Status to `AWAITING_BOTH_APPROVAL`, reset both participant approvals, and return a `deal.missing_required_fields` error indicator on the response.

### Requirement 7: Editable Sections and Approval Reset

**User Story:** As either participant, I want to edit product and participant information, so that I can correct mistakes before paying, while material changes force a re-approval.

#### Acceptance Criteria

1. WHILE Deal_Status is in `AWAITING_BOTH_APPROVAL` or `READY_FOR_PAYMENT`, THE Deal_Service SHALL allow either participant to edit Product_Title (1–200 characters), Product_Type (1–100 characters), Product_Description (0–2000 characters), Quantity (integer 1–999,999), Condition (`new` or `used`), Deal_Amount (0.01–999,999,999.99 with at most 2 decimal places), and Currency (one of {USD, KHR}).
2. WHILE Deal_Status is in `AWAITING_BOTH_APPROVAL` or `READY_FOR_PAYMENT`, THE Deal_Service SHALL allow each participant to edit only the Name (1–100 characters), Phone (up to 20 characters), Preferred_Language (one of {km, en, zh}), Telegram_Chat_Id, WeChat_Id, and Messenger_Name fields linked to that participant's own User id.
3. WHEN a participant edits Product_Title, Product_Description, Deal_Amount, or Currency, THE Deal_Service SHALL clear both prior approvals and SHALL set Deal_Status back to `AWAITING_BOTH_APPROVAL`.
4. WHEN an edit modifies only fields outside the set {Product_Title, Product_Description, Deal_Amount, Currency} — including Product_Type, Quantity, Condition, and any participant-owned personal fields from criterion 2 — THE Deal_Service SHALL preserve existing participant approvals and SHALL leave Deal_Status unchanged.
5. IF an edit attempt occurs while Deal_Status is in {`PAYMENT_PENDING_VERIFICATION`, `PAID_ESCROWED`, `SELLER_PREPARING`, `SHIPPED`, `BUYER_CONFIRMED`, `RELEASE_PENDING`, `RELEASED`, `DISPUTED`, `REFUNDED`, `CANCELLED`, `EXPIRED`}, THEN THE Deal_Service SHALL reject the edit with a `deal.locked_after_payment` error and SHALL NOT mutate any deal field, participant field, approval, or Deal_Status.
6. IF a participant attempts to edit personal fields linked to the other participant's User id, THEN THE Deal_Service SHALL reject the edit with an `auth.role_forbidden` error and SHALL NOT mutate any field.
7. IF an edit submits a value outside the bounds defined in criteria 1 and 2, THEN THE Deal_Service SHALL reject the edit with a `deal.invalid_field` error and SHALL NOT mutate any field, approval, or Deal_Status.

### Requirement 8: Approval State Machine

**User Story:** As either participant, I want to explicitly approve the deal terms, so that we both consent before money moves.

#### Acceptance Criteria

1. WHEN a participant submits an approval, THE Deal_Service SHALL record an approval bound to that participant's User id, role, and the current deal terms hash, where the deal terms hash is computed over the product section (Product_Title, Product_Type, Product_Description, Quantity, Condition, Deal_Amount, Currency) and the participant section (Buyer_Name, Seller_Name).
2. IF a participant submits an approval while Deal_Status is not `AWAITING_BOTH_APPROVAL`, THEN THE Deal_Service SHALL reject the request with a `deal.approval_not_allowed` error and SHALL NOT modify approvals or Deal_Status.
3. WHEN both participants have an active approval — defined as an approval that has not been invalidated and whose recorded deal terms hash equals the current deal terms hash — and the `missing_fields` array from Requirement 6 is empty, THE Deal_Service SHALL set Deal_Status to `READY_FOR_PAYMENT`.
4. WHEN a material edit defined in Requirement 7 occurs, THE Deal_Service SHALL invalidate prior approvals as defined in that requirement.
5. WHEN Deal_Status transitions to `READY_FOR_PAYMENT` per criterion 3, THE Notification_Service SHALL emit a `BOTH_APPROVED` notification event exactly once for that transition.
6. IF a User who is not a recorded participant of the Deal Room submits an approval, THEN THE Deal_Service SHALL reject the request with an `auth.role_forbidden` error and SHALL NOT modify approvals or Deal_Status.
7. IF a participant who already has an active approval submits another approval for the same deal terms hash, THEN THE Deal_Service SHALL treat the request as idempotent, SHALL NOT create a duplicate approval record, and SHALL NOT re-emit the `BOTH_APPROVED` event.

### Requirement 9: Wallet Payment Option

**User Story:** As a buyer with sufficient BothSafe wallet balance, I want to pay directly from my wallet, so that the deal moves forward instantly without leaving the app.

#### Acceptance Criteria

1. WHILE Deal_Status is `READY_FOR_PAYMENT`, THE Wallet_Service SHALL include `pay_from_wallet` in `allowed_actions` within 2 seconds when the buyer's Wallet balance for the deal Currency is greater than or equal to Deal_Amount, and SHALL omit it otherwise.
2. WHEN the buyer triggers a wallet payment with sufficient balance, THE Wallet_Service SHALL within 5 seconds atomically debit the buyer Wallet by Deal_Amount, credit the BothSafe escrow Wallet by Deal_Amount, write append-only Wallet ledger entries for both sides, and set Deal_Status to `PAID_ESCROWED`, with all four steps committed in a single transaction.
3. IF the buyer triggers a wallet payment when the buyer Wallet balance is less than Deal_Amount, THEN THE Wallet_Service SHALL reject the request with a `wallet.insufficient_balance` error including the current balance and the required Deal_Amount, SHALL NOT change Deal_Status, and SHALL NOT write any ledger entry.
4. IF a non-buyer participant or an unauthenticated caller triggers a wallet payment, THEN THE Wallet_Service SHALL reject the request with an `auth.role_forbidden` error and SHALL NOT change Deal_Status or write any ledger entry.
5. IF a wallet payment is triggered while Deal_Status is not `READY_FOR_PAYMENT`, THEN THE Wallet_Service SHALL reject the request with a `wallet.invalid_deal_state` error and SHALL NOT change Deal_Status or write any ledger entry.
6. IF the buyer Wallet currency does not match the deal Currency, THEN THE Wallet_Service SHALL reject the request with a `wallet.currency_mismatch` error and SHALL NOT change Deal_Status or write any ledger entry.
7. WHEN a wallet payment succeeds per criterion 2, THE Deal_Service SHALL transition Deal_Status from `PAID_ESCROWED` to `SELLER_PREPARING` in the same transaction.
8. THE Wallet_Service SHALL ensure the debit, credit, both ledger entries, and the Deal_Status transition for a single payment all succeed together or all fail together.
9. IF atomicity cannot be guaranteed for a wallet payment operation, THEN THE Wallet_Service SHALL fail the operation with a `wallet.transaction_failed` error, SHALL NOT write any partial ledger entries, and SHALL leave Wallet balances and Deal_Status unchanged.

### Requirement 10: Bakong KHQR Payment Option

**User Story:** As a buyer, I want to pay via Bakong KHQR using my banking app, so that I can complete payment when I do not hold a BothSafe wallet balance.

#### Acceptance Criteria

1. WHILE Deal_Status is `READY_FOR_PAYMENT`, THE KHQR_Generator SHALL produce a dynamic KHQR string and a KHQR PNG image of at least 256x256 pixels bound to Deal_Amount, Currency, the BothSafe receiver account, the BothSafe Bakong account id, and a Reference_Note of 8 to 32 alphanumeric characters that is unique across all deals.
2. WHEN the buyer chooses the KHQR option, THE Deal_Service SHALL display Amount_Due, Currency, BothSafe_Receiver_Account, BothSafe_Bakong_Account_Id, KHQR_Image, KHQR_String, and Reference_Note within 3 seconds.
3. WHILE the KHQR view is active for the buyer on a Deal Room in `READY_FOR_PAYMENT`, THE Deal_Service SHALL provide an `Open Bakong App to Pay` deeplink action.
4. WHEN the buyer submits payment receipt details after paying by KHQR, THE Deal_Service SHALL accept optional Paid_Amount (between 0.01 and 999,999,999.99 with at most 2 decimal places), Receipt_Attachment (image or PDF), and Buyer_Note (up to 500 characters), and SHALL set Deal_Status to `PAYMENT_PENDING_VERIFICATION`.
5. IF the buyer submits payment receipt details with no Paid_Amount and no Receipt_Attachment, THEN THE Deal_Service SHALL reject the request with a `payment.empty_receipt` error and SHALL leave Deal_Status at `READY_FOR_PAYMENT`.
6. THE Storage service SHALL accept Receipt_Attachment uploads of MIME types image/png, image/jpeg, and application/pdf, with a maximum size of 10 MB per file.
7. IF the Receipt_Attachment exceeds 10 MB or has a MIME type outside the allowed set in criterion 6, THEN THE Storage service SHALL reject the upload with a `storage.invalid_file` error and SHALL leave Deal_Status at `READY_FOR_PAYMENT`.
8. IF the KHQR_Generator fails to produce the KHQR string or image, THEN THE Deal_Service SHALL leave Deal_Status at `READY_FOR_PAYMENT`, return a `payment.khqr_unavailable` error, and offer a retry action to the buyer.

### Requirement 11: Payment Verification

**User Story:** As a seller, I want payment to be verified automatically when possible and by an admin otherwise, so that I can start preparing the item without unnecessary delay.

#### Acceptance Criteria

1. WHEN Deal_Status enters `PAYMENT_PENDING_VERIFICATION`, THE KHQR_Verifier SHALL attempt automatic verification against Bakong using the deal Reference_Note and Deal_Amount, retrying up to 3 times within a verification window of 60 seconds.
2. WHEN automatic verification confirms a matching credit to the BothSafe receiver account, THE Payment service SHALL write an `ESCROW_RECEIVED` ledger entry and SHALL set Deal_Status to `PAID_ESCROWED` within the same database transaction.
3. IF automatic verification is unavailable or returns no match within the 60-second verification window, THEN THE Notification_Service SHALL emit a `PAYMENT_PROOF_UPLOADED` event to the admin queue.
4. WHEN the admin verifies a payment proof while Deal_Status is `PAYMENT_PENDING_VERIFICATION`, THE Admin_Service SHALL set Deal_Status to `PAID_ESCROWED` and SHALL write an `ESCROW_RECEIVED` ledger entry within the same database transaction.
5. WHEN the admin rejects a payment proof while Deal_Status is `PAYMENT_PENDING_VERIFICATION` and provides a rejection reason of 1 to 500 characters, THE Admin_Service SHALL set Deal_Status back to `READY_FOR_PAYMENT` and SHALL emit a `PAYMENT_REJECTED` notification event including the rejection reason.
6. IF the admin submits a verify or reject action while Deal_Status is not `PAYMENT_PENDING_VERIFICATION`, THEN THE Admin_Service SHALL reject the action with a `payment.invalid_state` error and SHALL NOT change Deal_Status or write any ledger entry.
7. IF the admin submits a reject action with no rejection reason or with a rejection reason outside the 1–500 character range, THEN THE Admin_Service SHALL reject the action with a `payment.invalid_reason` error and SHALL NOT change Deal_Status.
8. WHEN Deal_Status transitions to `PAID_ESCROWED`, THE Deal_Service SHALL transition Deal_Status to `SELLER_PREPARING` in the same database transaction.

### Requirement 12: Shipping Proof

**User Story:** As a seller, I want to upload shipping proof, so that the buyer can see that I have shipped the product.

#### Acceptance Criteria

1. WHILE Deal_Status is `SELLER_PREPARING`, THE Shipping service SHALL include `submit_shipping_proof` in `allowed_actions` for the seller participant only.
2. WHEN the seller submits shipping proof, THE Shipping service SHALL accept optional Delivery_Company (≤100 chars), Tracking_Number (≤100 chars), Package_Photo, Delivery_Receipt, and Seller_Note (≤1000 chars); the request SHALL contain at least one of Delivery_Company, Tracking_Number, Package_Photo, or Delivery_Receipt; and on success the Shipping service SHALL set Deal_Status to `SHIPPED`.
3. IF a non-seller participant attempts to submit shipping proof, THEN THE Shipping service SHALL reject the request with an `auth.role_forbidden` error and SHALL NOT change Deal_Status or persist any uploaded file.
4. THE Storage service SHALL apply the MIME (image/png, image/jpeg, application/pdf) and 10 MB size limits defined in Requirement 10 to Package_Photo and Delivery_Receipt uploads.
5. IF the seller submits shipping proof while Deal_Status is not `SELLER_PREPARING`, THEN THE Shipping service SHALL reject the request with a `shipping.invalid_state` error and SHALL NOT change Deal_Status.
6. IF the seller submits shipping proof with no Delivery_Company, Tracking_Number, Package_Photo, or Delivery_Receipt, THEN THE Shipping service SHALL reject the request with a `shipping.empty_proof` error and SHALL NOT change Deal_Status.
7. WHEN Deal_Status transitions to `SHIPPED` per criterion 2, THE Notification_Service SHALL emit a `SHIPPING_UPLOADED` event to both participants.

### Requirement 13: Buyer Confirmation and Auto-Release

**User Story:** As a buyer, I want to confirm I received the product and have the money released to the seller automatically, so that the deal closes without an extra admin step.

#### Acceptance Criteria

1. WHILE Deal_Status is `SHIPPED` and no Dispute is active on the Deal Room, THE Confirmation service SHALL include `confirm_received` and `open_dispute` in `allowed_actions` for the authenticated buyer participant only and SHALL exclude them for the seller and unauthenticated callers.
2. WHEN the authenticated buyer submits a `confirm_received` action while Deal_Status is `SHIPPED`, THE Confirmation service SHALL set Deal_Status to `RELEASE_PENDING` exactly once and SHALL ignore subsequent `confirm_received` submissions on the same Deal Room.
3. WHEN Deal_Status transitions to `RELEASE_PENDING`, THE Wallet_Service SHALL within 5 seconds atomically debit the BothSafe escrow Wallet by Deal_Amount, credit the seller User Wallet for the deal Currency by Deal_Amount, write append-only Wallet ledger entries for both sides, and set Deal_Status to `RELEASED`.
4. THE Confirmation service SHALL NOT require admin verification for the auto-release path defined in this requirement.
5. WHEN auto-release completes per criterion 3, THE Notification_Service SHALL emit a `PAYOUT_RELEASED` event to both participants within 5 seconds of the `RELEASED` transition.
6. IF the wallet ledger update fails during auto-release, THEN THE Wallet_Service SHALL leave Deal_Status at `RELEASE_PENDING`, SHALL NOT debit the escrow Wallet, SHALL NOT credit the seller Wallet, and SHALL emit an admin alert event within 5 seconds identifying the Deal Room id and the failure cause.
7. IF a non-buyer participant submits `confirm_received`, or the buyer submits `confirm_received` while Deal_Status is not `SHIPPED`, THEN THE Confirmation service SHALL reject the request with an `auth.role_forbidden` or `confirmation.invalid_state` error and SHALL NOT change Deal_Status or write any ledger entry.

### Requirement 14: Wallet Ledger Integrity

**User Story:** As a platform operator, I want every wallet movement to be append-only and reconcilable, so that I can trust the balance shown to users.

#### Acceptance Criteria

1. WHEN a credit or debit occurs on any Wallet, THE Wallet_Service SHALL write an append-only ledger entry containing Wallet_Id, Amount (decimal greater than 0 with at most 2 decimal places), Currency (one of {USD, KHR}), Direction (`credit` or `debit`), Entry_Type (one of `ESCROW_RECEIVED`, `PLATFORM_FEE_RESERVED`, `SELLER_PAYOUT_PENDING`, `SELLER_PAYOUT_SENT`, `BUYER_REFUND_PENDING`, `BUYER_REFUND_SENT`, `ADJUSTMENT`), Related_Deal_Id (the originating Deal Room id, or null when the entry is not deal-related), and Created_At (UTC timestamp with millisecond precision).
2. IF any caller attempts to update or delete an existing Wallet ledger entry, THEN THE Wallet_Service SHALL reject the operation with a `ledger.immutable` error, SHALL leave the targeted entry unchanged, and SHALL NOT modify any other ledger entry.
3. THE Wallet_Service SHALL compute the balance of any Wallet as the signed sum of all ledger entries for that Wallet, where credits contribute the entry Amount as a positive value and debits contribute the entry Amount as a negative value.
4. WHEN a single business operation produces multiple ledger entries, THE Wallet_Service SHALL write all entries inside the same database transaction such that either all entries are committed or none are.
5. IF the database transaction containing one or more ledger entries fails to commit, THEN THE Wallet_Service SHALL roll back all entries in that transaction, leave the originating Wallet balances unchanged, and surface the failure to the calling service.
6. THE Wallet_Service SHALL store exactly one Wallet record per unique combination of User and Currency.

### Requirement 15: Seller Withdrawal Request

**User Story:** As a seller with funds in my BothSafe wallet, I want to request a withdrawal to a KHQR or bank account, so that I can move the money out of BothSafe.

#### Acceptance Criteria

1. WHEN an authenticated seller submits a Withdrawal_Request, THE Wallet_Service SHALL require Currency from the set {USD, KHR}, Amount (between 0.01 and 999,999,999.99 with at most 2 decimal places), and Destination_Type.
2. THE Wallet_Service SHALL accept Destination_Type values only from the case-sensitive set {khqr, bank}.
3. WHERE Destination_Type is `khqr`, THE Wallet_Service SHALL require either a KHQR_String (10–512 characters) or a KHQR_Image of MIME type image/png or image/jpeg with a maximum size of 5 MB.
4. WHERE Destination_Type is `bank`, THE Wallet_Service SHALL require Bank_Name (1–100 characters), Account_Name (1–100 characters), and Account_Number (5–34 alphanumeric characters).
5. THE Wallet_Service SHALL accept KHQR destinations from any Cambodian bank that supports the KHQR standard, not only Bakong.
6. IF the requested Amount exceeds the seller Wallet's available balance for the requested Currency — where available balance equals the total Wallet balance minus the sum of Amounts on all Withdrawal_Requests in `pending_admin_review` status — THEN THE Wallet_Service SHALL reject the request with a `wallet.insufficient_balance` error and SHALL NOT create a Withdrawal_Request or write any ledger entry.
7. IF a Withdrawal_Request fails any field validation defined in criteria 1 through 4, THEN THE Wallet_Service SHALL reject the request with a `withdrawal.invalid_field` error and SHALL NOT create a Withdrawal_Request or write any ledger entry.
8. WHEN a Withdrawal_Request is accepted, THE Wallet_Service SHALL within a single database transaction place a hold for the requested Amount on the seller Wallet by writing a `SELLER_PAYOUT_PENDING` ledger entry and set the Withdrawal_Request status to `pending_admin_review`, rolling back both changes if either fails.
9. WHEN a Withdrawal_Request becomes `pending_admin_review`, THE Notification_Service SHALL emit a withdrawal-request notification to the admin queue within 5 seconds, including the seller User id, Amount, Currency, Destination_Type, and the destination details.

### Requirement 16: Admin Withdrawal Review and Payout

**User Story:** As an admin, I want to review and approve seller withdrawal requests, so that I can pay out only verified, valid destinations.

#### Acceptance Criteria

1. THE Admin_Service SHALL expose endpoints for an authenticated admin to list withdrawal requests (paginated to at most 50 per page, filterable by Withdrawal_Request status), view a single withdrawal request, approve a withdrawal request, and reject a withdrawal request.
2. WHEN the admin approves a Withdrawal_Request whose current status is `pending_admin_review` and supplies a Payout_Reference (1–128 characters) and an optional Admin_Note (up to 1000 characters), THE Wallet_Service SHALL within 5 seconds and within a single database transaction write a `SELLER_PAYOUT_SENT` ledger entry for the seller Wallet, transition the Withdrawal_Request status to `paid`, and record the admin User id, the supplied Payout_Reference, and the supplied Admin_Note.
3. WHEN the admin rejects a Withdrawal_Request whose current status is `pending_admin_review` and supplies a rejection reason (1–500 characters), THE Wallet_Service SHALL within 5 seconds and within a single database transaction write a compensating `ADJUSTMENT` ledger entry releasing the held amount, transition the Withdrawal_Request status to `rejected`, and record the rejection reason.
4. IF the admin submits an approve or reject action against a Withdrawal_Request whose current status is not `pending_admin_review`, THEN THE Admin_Service SHALL reject the action with a `withdrawal.invalid_status` error and SHALL NOT modify Wallet ledger entries or the Withdrawal_Request status.
5. IF the database transaction in criterion 2 or 3 fails, THEN THE Wallet_Service SHALL roll back all changes, return a `withdrawal.processing_failed` error, and leave the Withdrawal_Request status and Wallet ledger unchanged.
6. THE Admin_Service SHALL require an authenticated admin session for every withdrawal review endpoint.
7. THE Admin_Service SHALL write an Audit_Log entry for every withdrawal approval and rejection containing the admin User id, the Withdrawal_Request id, the action, the supplied Payout_Reference or rejection reason, and the UTC timestamp in ISO 8601 format.
8. IF a User without an admin role attempts to access a withdrawal review endpoint, THEN THE Admin_Service SHALL reject the request with an `auth.admin_required` error and SHALL NOT write an Audit_Log entry for the rejected attempt.

### Requirement 17: Dispute Initiation and Resolution

**User Story:** As either participant, I want to open a dispute when something goes wrong, so that an admin can decide whether to release or refund.

#### Acceptance Criteria

1. WHILE Deal_Status is in {`PAYMENT_PENDING_VERIFICATION`, `PAID_ESCROWED`, `SELLER_PREPARING`, `SHIPPED`} and no active Dispute exists on the Deal Room, THE Dispute service SHALL include `open_dispute` in `allowed_actions` for both participants.
2. WHEN a participant submits a dispute, THE Dispute service SHALL require a Reason from the set {`ITEM_NOT_RECEIVED`, `WRONG_ITEM`, `DAMAGED_ITEM`, `FAKE_ITEM`, `PAYMENT_PROBLEM`, `OTHER`} and a Message of 10 to 2000 characters after trimming whitespace.
3. THE Dispute service SHALL accept an optional Evidence_File on a dispute submission, subject to the Storage MIME and 10 MB size limits defined in Requirement 10.
4. IF a dispute submission is missing Reason, omits Message, or supplies a Message outside the 10–2000 character range, THEN THE Dispute service SHALL reject the request with a `dispute.invalid_field` error and SHALL NOT change Deal_Status.
5. WHEN a dispute submission satisfies criteria 2 and 3 and no active Dispute exists on the Deal Room, THE Dispute service SHALL set Deal_Status to `DISPUTED`, persist the Dispute record, emit a `DISPUTE_OPENED` notification event to the admin queue, and notify both participants.
6. IF a participant submits a dispute while an active Dispute already exists on the Deal Room, THEN THE Dispute service SHALL reject the request with a `dispute.already_open` error and SHALL NOT change Deal_Status or persist a duplicate Dispute record.
7. WHEN the admin resolves a dispute with `release` and supplies Payout_Reference (1–100 characters) and an optional Admin_Note (0–1000 characters), THE Admin_Service SHALL credit the seller Wallet for the deal Currency by Deal_Amount, write the seller payout ledger entries for that deal in a single transaction, and set Deal_Status to `RELEASED`.
8. WHEN the admin resolves a dispute with `refund` and supplies Refund_Reference (1–100 characters) and an optional Admin_Note (0–1000 characters), THE Admin_Service SHALL credit the buyer Wallet for the deal Currency by Deal_Amount, write the buyer refund ledger entries for that deal in a single transaction, and set Deal_Status to `REFUNDED`.
9. IF a dispute submission is attempted while Deal_Status is not in {`PAYMENT_PENDING_VERIFICATION`, `PAID_ESCROWED`, `SELLER_PREPARING`, `SHIPPED`}, THEN THE Dispute service SHALL reject the request with a `dispute.not_allowed_in_status` error and SHALL NOT change Deal_Status.

### Requirement 18: Telegram Bot Deal Creation

**User Story:** As a Telegram user, I want to create a deal through the BothSafe bot, so that I can start a protected transaction without leaving Telegram.

#### Acceptance Criteria

1. WHEN a Telegram user sends `/start` to the Telegram_Bot, THE Telegram_Bot SHALL display a main menu with `Create deal`, `My deals`, `Language`, and `Help` options within 3 seconds.
2. WHEN a Telegram user sends `/newdeal` or selects `Create deal`, THE Telegram_Bot SHALL prompt for role choice between `Seller` and `Buyer` and SHALL wait for the user's selection before continuing the conversation.
3. WHEN the user has selected a role, THE Telegram_Bot SHALL prompt for Product_Title as a required step accepting a non-empty text input between 1 and 200 characters.
4. WHEN the user has provided a valid Product_Title, THE Telegram_Bot SHALL prompt for Deal_Amount as a required step accepting a positive numeric value between 0.01 and 999,999,999.99 with up to 2 decimal places.
5. WHERE the chosen role is `seller`, THE Telegram_Bot SHALL prompt for an optional Product_Type (up to 100 characters) and an optional Product_Description (up to 1000 characters) that the user can skip by sending `/skip` or selecting a `Skip` inline button.
6. WHERE the chosen role is `buyer`, THE Telegram_Bot SHALL prompt for an optional Product_Description (up to 1000 characters) that the user can skip by sending `/skip` or selecting a `Skip` inline button.
7. WHEN the Telegram conversation completes with all required fields collected, THE Telegram_Bot SHALL call Deal_Service in-process to create the Deal Room within 10 seconds, and SHALL send the Creator_Link and the counterparty Invite_Link to the Telegram user in two separate messages.
8. THE Telegram_Bot SHALL NOT send the Creator_Access_Token to any Telegram chat other than the creator's chat and SHALL NOT include the bot token in any log output, error message, or user-facing message.
9. WHEN the Telegram_Bot sends the Invite_Link, THE Telegram_Bot SHALL include an `Open Deal Room` inline button that opens the Deal Room URL in the user's browser.
10. THE Telegram_Bot SHALL direct the user to the web Deal Room for joining, reviewing, editing, approving, payment, shipping, confirmation, dispute, and withdrawal flows by providing the Deal Room URL rather than collecting these inputs in chat.
11. IF the in-process Deal_Service call fails during Telegram deal creation, THEN THE Telegram_Bot SHALL inform the user with a `bot.error.deal_create_failed` message indicating the failure, SHALL NOT send any Creator_Link or Invite_Link for that failed attempt, SHALL preserve all entered conversation data, and SHALL allow the user to retry up to 3 times without restarting the conversation.
12. IF the user provides input that violates a field constraint during deal creation (Product_Title length, Deal_Amount format or range, optional field length, or invalid role selection), THEN THE Telegram_Bot SHALL reject the input with a validation error message identifying the violated constraint and SHALL re-prompt for the same field without advancing the conversation.
13. WHEN a Telegram user sends `/cancel` during an active deal creation conversation, THE Telegram_Bot SHALL discard all entered conversation data for that attempt, SHALL NOT call Deal_Service, and SHALL return the user to the main menu.

### Requirement 19: Notifications

**User Story:** As a participant or admin, I want to be notified when a deal changes state, so that I can take the next required action.

#### Acceptance Criteria

1. WHEN a counterparty joins a Deal Room, THE Notification_Service SHALL dispatch a `COUNTERPARTY_JOINED` event to the Deal Room creator within 5 seconds.
2. WHEN both participants have an active approval and all pre-payment required fields are present per Requirement 6, THE Notification_Service SHALL dispatch a `BOTH_APPROVED` event to both participants within 5 seconds.
3. WHEN Deal_Status transitions to `PAID_ESCROWED` via either auto-verification or admin verification, THE Notification_Service SHALL dispatch a `PAYMENT_VERIFIED` event to both participants within 5 seconds.
4. WHEN Deal_Status transitions to `SHIPPED`, THE Notification_Service SHALL dispatch a `SHIPPING_UPLOADED` event to the buyer within 5 seconds.
5. WHEN Deal_Status transitions to `RELEASE_PENDING`, THE Notification_Service SHALL dispatch a `BUYER_CONFIRMED` event to the seller within 5 seconds.
6. WHEN Deal_Status transitions to `RELEASED`, THE Notification_Service SHALL dispatch a `PAYOUT_RELEASED` event to both participants within 5 seconds.
7. WHEN Deal_Status transitions to `REFUNDED`, THE Notification_Service SHALL dispatch a `REFUND_COMPLETED` event to both participants within 5 seconds.
8. WHEN Deal_Status transitions to `DISPUTED`, THE Notification_Service SHALL dispatch a `DISPUTE_OPENED` event to the admin queue and to both participants within 5 seconds.
9. WHEN a Withdrawal_Request becomes `pending_admin_review`, THE Notification_Service SHALL dispatch a withdrawal-request notification to the admin queue within 5 seconds, including the seller User id, Amount, Currency, Destination_Type, and the destination details.
10. IF a notification dispatch fails, THEN THE Notification_Service SHALL log the failure including the event type, the intended recipient identifier, the originating Deal Room id or Withdrawal_Request id, and the failure reason.
11. IF a notification dispatch fails, THEN THE Notification_Service SHALL NOT roll back the originating Deal_Status transition or Wallet ledger change.

### Requirement 20: Audit Logging

**User Story:** As an admin or auditor, I want every important action to be recorded in an append-only Audit Log, so that I can investigate disputes and reconcile finances.

#### Acceptance Criteria

1. WHEN a Deal_Status transition is committed, THE Deal_Service SHALL write, within the same database transaction as the status change, an Audit_Log entry containing the Deal Room id, the previous status, the new status, the actor User id, the actor role, and the UTC timestamp of the transition recorded with millisecond precision.
2. WHEN a wallet payment, auto-release, withdrawal hold, withdrawal payout, or withdrawal release is committed, THE Wallet_Service SHALL write, within the same database transaction as the wallet operation, an Audit_Log entry containing the action type, the actor User id, the actor role, the related Deal Room id or Withdrawal_Request id, the amount, the Currency, and the UTC timestamp of the action recorded with millisecond precision.
3. WHEN an admin payment verification, payment rejection, dispute resolution, withdrawal approval, or withdrawal rejection is committed, THE Admin_Service SHALL write, within the same database transaction as the admin action, an Audit_Log entry containing the action type, the admin User id, the target entity type, the target entity id, the resolution outcome where applicable, and the UTC timestamp of the action recorded with millisecond precision.
4. IF the Audit_Log write fails for any action covered by criteria 1 through 3, THEN THE System SHALL roll back the originating action and SHALL return an error response indicating that the action could not be persisted, leaving all related records in their pre-action state.
5. IF any application-layer caller attempts to update or delete an existing Audit_Log entry, THEN THE System SHALL reject the operation with an `audit.immutable` error, leave the targeted entry unchanged, and SHALL NOT modify any other Audit_Log entry.
