# Requirements Document: BothSafe Telegram Bot MVP

## Introduction

The BothSafe Telegram Bot is a conversational interface integrated within the NestJS backend that allows users to create and manage Deal Rooms directly from Telegram. The bot is NOT a separate service - it runs as a module inside the NestJS backend and shares the same business logic, database, and services as the web application.

The bot provides a streamlined mobile-first experience for Cambodia's social commerce users who conduct business primarily through chat applications. It enables quick Deal Room creation, status notifications, and seamless transitions to the web application for sensitive operations like payment proof upload and payout configuration.

The bot follows a "bot creates links, website completes actions" philosophy to minimize sensitive data collection in chat while maximizing convenience for deal initiation and monitoring.

## Glossary

- **Telegram_Bot**: The conversational interface module running inside the NestJS backend that interacts with users via Telegram Bot API
- **Bot_Module**: The NestJS module containing bot command handlers, conversation state management, and notification adapters
- **Deal_Service**: The shared backend service that enforces all Deal Room business logic (used by both web and bot)
- **Telegram_Chat_ID**: A unique identifier for a Telegram user or chat session
- **Bot_Command**: A slash command that triggers bot functionality (/start, /newdeal, /mydeals, /help)
- **Conversation_State**: Temporary data stored during multi-step bot interactions (e.g., deal creation flow)
- **Inline_Keyboard**: Telegram UI component with clickable buttons displayed below bot messages
- **Creator_Link**: A private URL containing the creator's access token (must never be shared with counterparty)
- **Invite_Link**: A shareable URL containing an invite token for the counterparty to join
- **Notification_Event**: A backend event that triggers a bot message to participants (e.g., PAYMENT_VERIFIED, SHIPPING_UPLOADED)
- **Bot_Notifier**: An interface implementation that sends Telegram messages when notification events occur
- **Rate_Limiter**: A mechanism to prevent abuse by limiting bot actions per user per time period
- **Message_Key**: A translation key used to render bot messages in the user's preferred language
- **Webhook**: An HTTPS endpoint that receives updates from Telegram servers
- **Bot_Token**: A secret credential that authenticates the bot with Telegram API
- **Deal_Room**: A protected transaction workspace (same as in backend/frontend specs)
- **Backend_API**: The NestJS REST API that the bot calls via direct service invocation
- **Source**: The origin of a Deal Room creation (web or telegram)

## Requirements

### Requirement 1: Bot Module Initialization

**User Story:** As a system operator, I want the Telegram bot to initialize within the NestJS backend, so that it can handle user interactions without requiring a separate service.

#### Acceptance Criteria

1. THE Bot_Module SHALL initialize as a NestJS module within the backend application
2. THE Bot_Module SHALL read the Bot_Token from an environment variable
3. THE Bot_Module SHALL configure a webhook URL for receiving Telegram updates in production
4. THE Bot_Module SHALL use long polling for receiving Telegram updates in development
5. THE Bot_Module SHALL validate the Bot_Token format at startup
6. IF the Bot_Token is missing or invalid, THEN THE Bot_Module SHALL fail to initialize with a clear error message
7. THE Bot_Module SHALL never log the Bot_Token value
8. THE Bot_Module SHALL register command handlers for /start, /newdeal, /mydeals, and /help

### Requirement 2: Webhook Security

**User Story:** As a system operator, I want to validate webhook requests, so that only legitimate Telegram updates are processed.

#### Acceptance Criteria

1. THE Bot_Module SHALL configure a webhook secret token
2. WHEN a webhook request is received, THE Bot_Module SHALL validate the X-Telegram-Bot-Api-Secret-Token header
3. IF the secret token is invalid, THEN THE Bot_Module SHALL reject the request with HTTP 403
4. THE Bot_Module SHALL validate that webhook requests originate from Telegram IP ranges
5. THE Bot_Module SHALL use HTTPS for the webhook endpoint in production
6. THE Bot_Module SHALL log webhook validation failures for security monitoring

### Requirement 3: /start Command

**User Story:** As a Telegram user, I want to start interacting with the bot, so that I can learn about BothSafe and access bot features.

#### Acceptance Criteria

1. WHEN a user sends /start, THE Telegram_Bot SHALL respond with a welcome message explaining BothSafe
2. THE Telegram_Bot SHALL display an Inline_Keyboard with buttons: "Create Protected Deal", "My Deals", "Language", "Help"
3. THE Telegram_Bot SHALL store or update the user's Telegram_Chat_ID in the database
4. THE Telegram_Bot SHALL detect the user's Telegram language preference and set it as the default
5. THE Telegram_Bot SHALL send the welcome message in the user's preferred language
6. THE Telegram_Bot SHALL create an audit log entry for new user registration

### Requirement 4: Language Selection

**User Story:** As a user, I want to select my preferred language (Khmer, English, or Chinese), so that I can understand bot messages clearly.

#### Acceptance Criteria

1. WHEN a user clicks the "Language" button, THE Telegram_Bot SHALL display language options: ខ្មែរ (km), English (en), 中文 (zh)
2. WHEN a user selects a language, THE Telegram_Bot SHALL store the preference linked to their Telegram_Chat_ID
3. THE Telegram_Bot SHALL send all subsequent messages in the user's selected language
4. THE Telegram_Bot SHALL use Message_Key identifiers to retrieve translated text
5. THE Telegram_Bot SHALL default to English if a translation is missing
6. THE Telegram_Bot SHALL include the language preference when creating Deal Rooms

### Requirement 5: /newdeal Command - Role Selection

**User Story:** As a user, I want to create a Deal Room from Telegram, so that I can quickly initiate a protected transaction.

#### Acceptance Criteria

1. WHEN a user sends /newdeal, THE Telegram_Bot SHALL respond with a role selection message
2. THE Telegram_Bot SHALL display an Inline_Keyboard with buttons: "I am Seller", "I am Buyer", "Cancel"
3. WHEN the user selects a role, THE Telegram_Bot SHALL store the role in Conversation_State
4. THE Telegram_Bot SHALL set a Conversation_State expiration time of 10 minutes
5. WHEN the user clicks "Cancel", THE Telegram_Bot SHALL clear the Conversation_State and return to the main menu

### Requirement 6: Seller Deal Creation Flow

**User Story:** As a seller, I want to create a Deal Room via the bot, so that I can share an invite link with a potential buyer.

#### Acceptance Criteria

1. WHEN a seller selects "I am Seller", THE Telegram_Bot SHALL ask for the product title
2. WHEN the seller provides a product title, THE Telegram_Bot SHALL ask for the price
3. WHEN the seller provides a price, THE Telegram_Bot SHALL validate that it is a positive number
4. IF the price is invalid, THEN THE Telegram_Bot SHALL ask the seller to provide a valid amount
5. THE Telegram_Bot SHALL ask for an optional product type with buttons: "Physical Product", "Service", "Skip"
6. WHEN the seller completes the flow, THE Telegram_Bot SHALL call the Deal_Service to create a Deal Room with source=telegram and creator_role=seller
7. THE Telegram_Bot SHALL include the Telegram_Chat_ID in the deal creation request
8. THE Telegram_Bot SHALL include the user's preferred language in the deal creation request
9. THE Telegram_Bot SHALL clear the Conversation_State after successful deal creation

### Requirement 7: Buyer Deal Creation Flow

**User Story:** As a buyer, I want to create a Deal Room via the bot, so that I can share an invite link with a potential seller.

#### Acceptance Criteria

1. WHEN a buyer selects "I am Buyer", THE Telegram_Bot SHALL ask for the requested product title
2. WHEN the buyer provides a product title, THE Telegram_Bot SHALL ask for the expected price
3. WHEN the buyer provides a price, THE Telegram_Bot SHALL validate that it is a positive number
4. IF the price is invalid, THEN THE Telegram_Bot SHALL ask the buyer to provide a valid amount
5. THE Telegram_Bot SHALL ask for an optional note to the seller
6. WHEN the buyer completes the flow, THE Telegram_Bot SHALL call the Deal_Service to create a Deal Room with source=telegram and creator_role=buyer
7. THE Telegram_Bot SHALL include the Telegram_Chat_ID in the deal creation request
8. THE Telegram_Bot SHALL include the user's preferred language in the deal creation request
9. THE Telegram_Bot SHALL clear the Conversation_State after successful deal creation

### Requirement 8: Deal Creation Response

**User Story:** As a creator, I want to receive my Deal Room links after creation, so that I can access the deal and share it with the counterparty.

#### Acceptance Criteria

1. WHEN a Deal Room is created successfully, THE Telegram_Bot SHALL send a success message with the deal details
2. THE Telegram_Bot SHALL display the product title, price, and creator role in the success message
3. THE Telegram_Bot SHALL send the Creator_Link with a warning: "⚠️ This is YOUR private link. Do not share it."
4. THE Telegram_Bot SHALL send the Invite_Link with instructions: "📤 Share this link with the [buyer/seller]"
5. THE Telegram_Bot SHALL display an Inline_Keyboard with buttons: "Open Deal Room", "Share Invite Link"
6. WHEN the user clicks "Open Deal Room", THE Telegram_Bot SHALL send the Creator_Link as a clickable URL
7. WHEN the user clicks "Share Invite Link", THE Telegram_Bot SHALL send the Invite_Link in a format optimized for forwarding
8. THE Telegram_Bot SHALL never send the Creator_Link to the counterparty

### Requirement 9: Conversation State Management

**User Story:** As the system, I want to manage temporary conversation state, so that multi-step bot interactions work reliably.

#### Acceptance Criteria

1. THE Bot_Module SHALL store Conversation_State in the database with fields: telegram_chat_id, current_flow, creator_role, language, step, product_title, amount, product_type, note, created_at, expires_at
2. THE Bot_Module SHALL set Conversation_State expiration to 10 minutes from creation
3. WHEN a Conversation_State expires, THE Bot_Module SHALL delete it automatically
4. WHEN a user sends a message during an active conversation, THE Bot_Module SHALL retrieve the Conversation_State
5. WHEN a user sends /cancel during a conversation, THE Bot_Module SHALL clear the Conversation_State
6. WHEN a user starts a new /newdeal while another is in progress, THE Bot_Module SHALL clear the old Conversation_State
7. THE Bot_Module SHALL validate that each conversation step receives the expected input type

### Requirement 10: Amount Validation

**User Story:** As the system, I want to validate price inputs, so that only valid amounts are accepted for Deal Room creation.

#### Acceptance Criteria

1. WHEN a user provides a price, THE Telegram_Bot SHALL validate that it is a positive number
2. THE Telegram_Bot SHALL accept decimal amounts with up to 2 decimal places
3. THE Telegram_Bot SHALL accept amounts in the range 1 to 1,000,000,000
4. IF the amount is zero or negative, THEN THE Telegram_Bot SHALL respond with error message_key "bot.error.invalid_amount"
5. IF the amount is not a number, THEN THE Telegram_Bot SHALL respond with error message_key "bot.error.not_a_number"
6. IF the amount exceeds the maximum, THEN THE Telegram_Bot SHALL respond with error message_key "bot.error.amount_too_large"
7. THE Telegram_Bot SHALL allow the user to retry entering the amount up to 3 times before canceling the flow

### Requirement 11: /mydeals Command

**User Story:** As a user, I want to see my recent Deal Rooms, so that I can quickly access them from Telegram.

#### Acceptance Criteria

1. WHEN a user sends /mydeals, THE Telegram_Bot SHALL query the Deal_Service for deals linked to the user's Telegram_Chat_ID
2. THE Telegram_Bot SHALL display the 10 most recent deals
3. FOR EACH deal, THE Telegram_Bot SHALL display: product title, amount, status, and creation date
4. FOR EACH deal, THE Telegram_Bot SHALL display an Inline_Keyboard button: "Open Deal Room"
5. WHEN the user clicks "Open Deal Room", THE Telegram_Bot SHALL open the safe Deal Room URL without newly exposing raw access tokens; previously issued private links remain the source of token-based access
6. IF the user has no deals, THEN THE Telegram_Bot SHALL display a message: "You have no deals yet. Use /newdeal to create one."
7. THE Telegram_Bot SHALL display deal statuses using user-friendly translated labels

### Requirement 12: /help Command

**User Story:** As a user, I want to understand how BothSafe escrow works, so that I can use the platform confidently.

#### Acceptance Criteria

1. WHEN a user sends /help, THE Telegram_Bot SHALL send an explanation of the escrow process
2. THE Telegram_Bot SHALL explain: buyer pays BothSafe, seller ships after payment verified, buyer confirms delivery, admin releases payment to seller
3. THE Telegram_Bot SHALL explain the dispute option
4. THE Telegram_Bot SHALL explain that sensitive actions (payment upload, payout setup) happen on the website
5. THE Telegram_Bot SHALL send the help text in the user's preferred language
6. THE Telegram_Bot SHALL display an Inline_Keyboard button: "Create Protected Deal"

### Requirement 13: Notification Adapter - COUNTERPARTY_JOINED

**User Story:** As a creator, I want to be notified when the counterparty joins my Deal Room, so that I know the transaction can proceed.

#### Acceptance Criteria

1. WHEN a COUNTERPARTY_JOINED event occurs, THE Bot_Notifier SHALL send a message to the creator's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include the counterparty's name in the message
3. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
4. THE Bot_Notifier SHALL send the message in the creator's preferred language
5. IF the creator does not have a Telegram_Chat_ID, THEN THE Bot_Notifier SHALL skip sending the message without error

### Requirement 14: Notification Adapter - BOTH_APPROVED

**User Story:** As a buyer, I want to be notified when both parties have approved the deal, so that I know I can proceed with payment.

#### Acceptance Criteria

1. WHEN a BOTH_APPROVED event occurs, THE Bot_Notifier SHALL send a message to the buyer's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include instructions to upload payment proof on the website
3. THE Bot_Notifier SHALL include the payment amount and BothSafe receiving account
4. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
5. THE Bot_Notifier SHALL send the message in the buyer's preferred language

### Requirement 15: Notification Adapter - PAYMENT_VERIFIED

**User Story:** As a seller, I want to be notified when payment is verified, so that I know I can ship the product.

#### Acceptance Criteria

1. WHEN a PAYMENT_VERIFIED event occurs, THE Bot_Notifier SHALL send a message to the seller's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include instructions to ship the product and upload shipping proof
3. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
4. THE Bot_Notifier SHALL send the message in the seller's preferred language

### Requirement 16: Notification Adapter - PAYMENT_REJECTED

**User Story:** As a buyer, I want to be notified when my payment proof is rejected, so that I can upload a corrected proof.

#### Acceptance Criteria

1. WHEN a PAYMENT_REJECTED event occurs, THE Bot_Notifier SHALL send a message to the buyer's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include the rejection reason if provided by the admin
3. THE Bot_Notifier SHALL include instructions to upload a new payment proof on the website
4. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
5. THE Bot_Notifier SHALL send the message in the buyer's preferred language

### Requirement 17: Notification Adapter - SHIPPING_UPLOADED

**User Story:** As a buyer, I want to be notified when the seller uploads shipping proof, so that I can track my delivery.

#### Acceptance Criteria

1. WHEN a SHIPPING_UPLOADED event occurs, THE Bot_Notifier SHALL send a message to the buyer's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include the tracking number if provided
3. THE Bot_Notifier SHALL include the delivery company if provided
4. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
5. THE Bot_Notifier SHALL send the message in the buyer's preferred language

### Requirement 18: Notification Adapter - BUYER_CONFIRMED

**User Story:** As a seller, I want to be notified when the buyer confirms delivery, so that I know payment release is pending.

#### Acceptance Criteria

1. WHEN a BUYER_CONFIRMED event occurs, THE Bot_Notifier SHALL send a message to the seller's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include a message that admin will release payment soon
3. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
4. THE Bot_Notifier SHALL send the message in the seller's preferred language

### Requirement 19: Notification Adapter - DISPUTE_OPENED

**User Story:** As a participant, I want to be notified when a dispute is opened, so that I am aware of the issue.

#### Acceptance Criteria

1. WHEN a DISPUTE_OPENED event occurs, THE Bot_Notifier SHALL send a message to both buyer and seller Telegram_Chat_IDs
2. THE Bot_Notifier SHALL include the dispute reason
3. THE Bot_Notifier SHALL include a message that admin will review and resolve
4. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
5. THE Bot_Notifier SHALL send the message in each participant's preferred language

### Requirement 20: Notification Adapter - PAYOUT_RELEASED

**User Story:** As a seller, I want to be notified when my payout is released, so that I know the transaction is complete.

#### Acceptance Criteria

1. WHEN a PAYOUT_RELEASED event occurs, THE Bot_Notifier SHALL send a message to the seller's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include the payout amount
3. THE Bot_Notifier SHALL include a message to check their payout account
4. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
5. THE Bot_Notifier SHALL send the message in the seller's preferred language

### Requirement 21: Notification Adapter - REFUND_COMPLETED

**User Story:** As a buyer, I want to be notified when my refund is completed, so that I know the transaction is resolved.

#### Acceptance Criteria

1. WHEN a REFUND_COMPLETED event occurs, THE Bot_Notifier SHALL send a message to the buyer's Telegram_Chat_ID
2. THE Bot_Notifier SHALL include the refund amount
3. THE Bot_Notifier SHALL include a message to check their payment account
4. THE Bot_Notifier SHALL include an Inline_Keyboard button: "Open Deal Room"
5. THE Bot_Notifier SHALL send the message in the buyer's preferred language

### Requirement 22: Notification Failure Handling

**User Story:** As the system, I want notification failures to not affect Deal Room state transitions, so that core business logic remains reliable.

#### Acceptance Criteria

1. WHEN a Telegram notification fails to send, THE Bot_Notifier SHALL log the error
2. THE Bot_Notifier SHALL not throw an exception that would rollback the Deal Room status change
3. THE Bot_Notifier SHALL retry failed notifications up to 3 times with exponential backoff
4. IF all retries fail, THEN THE Bot_Notifier SHALL log the failure and continue
5. THE Bot_Notifier SHALL store failed notification attempts in the database for admin review
6. THE Bot_Notifier SHALL handle Telegram API rate limits gracefully

### Requirement 23: Rate Limiting - Deal Creation

**User Story:** As the system, I want to limit deal creation per user, so that the bot cannot be abused for spam.

#### Acceptance Criteria

1. THE Bot_Module SHALL limit deal creation to 3 deals per Telegram_Chat_ID per hour
2. WHEN a user exceeds the rate limit, THE Telegram_Bot SHALL respond with error message_key "bot.error.rate_limit_exceeded"
3. THE Telegram_Bot SHALL include the time until the rate limit resets in the error message
4. THE Bot_Module SHALL use a sliding window rate limiting algorithm
5. THE Bot_Module SHALL store rate limit counters in the database or cache

### Requirement 24: Rate Limiting - Command Spam

**User Story:** As the system, I want to prevent command spam, so that the bot remains responsive for legitimate users.

#### Acceptance Criteria

1. THE Bot_Module SHALL limit all bot commands to 10 requests per Telegram_Chat_ID per minute
2. WHEN a user exceeds the command rate limit, THE Telegram_Bot SHALL respond with error message_key "bot.error.too_many_requests"
3. THE Bot_Module SHALL ignore duplicate identical messages sent within 2 seconds
4. THE Bot_Module SHALL use a token bucket rate limiting algorithm for commands

### Requirement 25: Error Handling - Invalid Commands

**User Story:** As a user, I want clear feedback when I send an invalid command, so that I know what to do instead.

#### Acceptance Criteria

1. WHEN a user sends an unrecognized command, THE Telegram_Bot SHALL respond with a help message
2. THE Telegram_Bot SHALL list available commands: /start, /newdeal, /mydeals, /help
3. THE Telegram_Bot SHALL send the error message in the user's preferred language
4. THE Telegram_Bot SHALL not crash or log errors for unrecognized commands

### Requirement 26: Error Handling - Service Failures

**User Story:** As a user, I want to be informed when the bot cannot complete my request, so that I can try again later.

#### Acceptance Criteria

1. WHEN the Deal_Service returns an error during deal creation, THE Telegram_Bot SHALL send an error message to the user
2. THE Telegram_Bot SHALL include the error message_key from the Deal_Service if available
3. THE Telegram_Bot SHALL suggest retrying or contacting support
4. THE Telegram_Bot SHALL log the error with full context for debugging
5. THE Telegram_Bot SHALL clear the Conversation_State after a service failure

### Requirement 27: Error Handling - Conversation Timeout

**User Story:** As a user, I want to be notified when my conversation times out, so that I understand why the bot stopped responding.

#### Acceptance Criteria

1. WHEN a user sends a message after their Conversation_State has expired, THE Telegram_Bot SHALL respond with a timeout message
2. THE Telegram_Bot SHALL suggest starting a new /newdeal command
3. THE Telegram_Bot SHALL send the timeout message in the user's preferred language

### Requirement 28: Security - Access Token Protection

**User Story:** As the system, I want to protect access tokens, so that unauthorized users cannot access Deal Rooms.

#### Acceptance Criteria

1. THE Telegram_Bot SHALL never log token-bearing Creator_Link or Invite_Link URLs
2. THE Telegram_Bot SHALL send Creator_Links only to the creator's Telegram_Chat_ID
3. THE Telegram_Bot SHALL send Invite_Links only to the creator (never automatically to the counterparty)
4. THE Telegram_Bot SHALL warn users to keep their Creator_Link private
5. THE Telegram_Bot SHALL not store raw access tokens in Conversation_State
6. THE Telegram_Bot SHALL not reconstruct or resend raw Access_Tokens after the Deal_Service has returned them once

### Requirement 29: Security - Input Sanitization

**User Story:** As the system, I want to sanitize user inputs, so that malicious content cannot be injected.

#### Acceptance Criteria

1. THE Bot_Module SHALL sanitize all text inputs to remove HTML tags
2. THE Bot_Module SHALL sanitize all text inputs to remove script tags
3. THE Bot_Module SHALL limit product title length to 200 characters
4. THE Bot_Module SHALL limit note length to 500 characters
5. THE Bot_Module SHALL reject inputs containing only whitespace
6. THE Bot_Module SHALL trim leading and trailing whitespace from all text inputs

### Requirement 30: Integration with Deal Service

**User Story:** As the system, I want the bot to use the same Deal Service as the web application, so that business logic is consistent.

#### Acceptance Criteria

1. THE Bot_Module SHALL call the Deal_Service directly via dependency injection (not HTTP)
2. THE Bot_Module SHALL pass the same request DTOs as the web API endpoints
3. THE Bot_Module SHALL handle the same response DTOs as the web API endpoints
4. THE Bot_Module SHALL not implement any deal creation logic outside the Deal_Service
5. THE Bot_Module SHALL not implement any status transition logic outside the Deal_Service
6. THE Bot_Module SHALL respect all validation rules enforced by the Deal_Service
7. FOR ALL deal creation requests, THE Bot_Module SHALL produce the same Deal Room state as the web application given identical inputs

### Requirement 31: Localization Keys

**User Story:** As a developer, I want all bot messages to use translation keys, so that the bot can support multiple languages.

#### Acceptance Criteria

1. THE Bot_Module SHALL use Message_Key identifiers for all user-facing text
2. THE Bot_Module SHALL load translations from language files (km.json, en.json, zh.json)
3. THE Bot_Module SHALL support translation keys: bot.start.title, bot.menu.create_deal, bot.role.ask, bot.role.seller, bot.role.buyer, bot.deal.created, bot.link.private_warning, bot.link.share_this, bot.status.ready_for_payment, bot.error.invalid_amount, bot.help.escrow_explain
4. THE Bot_Module SHALL default to English when a translation key is missing
5. THE Bot_Module SHALL log warnings when translation keys are missing

### Requirement 32: Audit Logging

**User Story:** As an admin, I want to see audit logs for bot actions, so that I can investigate issues and monitor usage.

#### Acceptance Criteria

1. THE Bot_Module SHALL create audit log entries for: user registration (/start), deal creation, language change
2. THE Bot_Module SHALL include the Telegram_Chat_ID in all audit log entries
3. THE Bot_Module SHALL include the command or action type in all audit log entries
4. THE Bot_Module SHALL include timestamps in all audit log entries
5. THE Bot_Module SHALL not log sensitive information (access tokens, bot token) in audit logs

### Requirement 33: Parser and Serializer for Bot Messages

**User Story:** As a developer, I want to parse and format bot messages correctly, so that users receive well-structured information.

#### Acceptance Criteria

1. THE Bot_Module SHALL parse Telegram update JSON payloads into typed objects
2. THE Bot_Module SHALL serialize bot response messages into Telegram API format
3. THE Bot_Module SHALL format currency amounts with 2 decimal places and thousand separators
4. THE Bot_Module SHALL format timestamps in the user's timezone if available
5. THE Bot_Module SHALL escape special Markdown characters in user-provided text
6. FOR ALL bot messages, parsing the Telegram update then generating a response then parsing the sent message SHALL produce consistent data (round-trip property)

### Requirement 34: Health Check Integration

**User Story:** As an operator, I want to monitor bot health, so that I can detect when the bot is not functioning.

#### Acceptance Criteria

1. THE Bot_Module SHALL expose a health check method that verifies Telegram API connectivity
2. THE Bot_Module SHALL include bot status in the /health endpoint response
3. THE Bot_Module SHALL report "healthy" when the bot can successfully call Telegram getMe API
4. THE Bot_Module SHALL report "unhealthy" when Telegram API calls fail
5. THE Bot_Module SHALL include the last successful message timestamp in health check data

### Requirement 35: Configuration Management

**User Story:** As an operator, I want to configure bot parameters via environment variables, so that I can deploy to different environments.

#### Acceptance Criteria

1. THE Bot_Module SHALL read TELEGRAM_BOT_TOKEN from environment variables
2. THE Bot_Module SHALL read TELEGRAM_WEBHOOK_URL from environment variables
3. THE Bot_Module SHALL read TELEGRAM_WEBHOOK_SECRET from environment variables
4. THE Bot_Module SHALL read BOT_RATE_LIMIT_DEALS_PER_HOUR from environment variables (default: 3)
5. THE Bot_Module SHALL read BOT_RATE_LIMIT_COMMANDS_PER_MINUTE from environment variables (default: 10)
6. THE Bot_Module SHALL read BOT_CONVERSATION_TIMEOUT_MINUTES from environment variables (default: 10)
7. THE Bot_Module SHALL validate that required environment variables are present at startup
8. IF required environment variables are missing, THEN THE Bot_Module SHALL fail to initialize with a clear error message
