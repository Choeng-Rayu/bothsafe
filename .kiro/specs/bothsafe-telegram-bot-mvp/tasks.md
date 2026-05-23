# Implementation Plan: BothSafe Telegram Bot MVP

## Overview

The Telegram Bot runs as a NestJS module inside the backend. It shares the same database, services, and business logic as the web application. This plan implements the bot-specific features on top of the e istingxbackend infrastructure.

## Tasks

- [ ] 1. Bot Module Infrastructure (pre-existing)
  - BotModule with Telegraf integration
  - Environment-based webhook vs long-polling configuration
  - _Requirements: 1, 35_

- [ ] 2. Implement Webhook Security
  - [ ] 2.1 Add webhook secret token validation middleware (BotWebhookGuard)
  - [ ] 2.2 Validate  -Telegram-Bot-Api-Secret-Token header
  - [ ] 2.3 Add Telegram IP range validation (structure ready, CIDR check disabled for dev)
  - _Requirements: 2_

- [ ] 3. Implement Bot Rate Limiting
  - [ ] 3.1 Add deal creation rate limiter (3 deals per hour per chat ID)
  - [ ] 3.2 Add command spam rate limiter (10 commands per minute per chat ID)
  - [ ] 3.3 Add duplicate message deduplication (2 second window)
  - _Requirements: 23, 24_

- [ ] 4. Enhance Conversation State Management
  - [ ] 4.1 Adjust conversation TTL to 10 minutes
  - [ ] 4.2 Add automatic cleanup of e pired conversation states (BotCleanupService cron job)
  - [ ] 4.3 Add input validation per conversation step
  - _Requirements: 9, 10, 27_

- [ ] 5. Enhance Input Validation and Sanitization
  - [ ] 5.1 Add HTML/script tag sanitization for te t inputs (via sanitizeTe t)
  - [ ] 5.2 Enforce product title ma  200 characters
  - [ ] 5.3 Enforce note ma  500 characters
  - [ ] 5.4 Add amount validation with retry limits (3 retries)
  - [ ] 5.5 Reject whitespace-only inputs
  - _Requirements: 10, 29_

- [ ] 6. Implement Bot Audit Logging
  - [ ] 6.1 Add audit log for /start (user registration)
  - [ ] 6.2 Add audit log for deal creation via bot
  - [ ] 6.3 Add audit log for language changes
  - _Requirements: 32_

- [ ] 7. Enhance Notification Adapter
  - [ ] 7.1 Verify all notification events are handled (Req 13-21)
  - [ ] 7.2 Add retry logic with e ponential backoff (3 retries, up to 8s delay)
  - [ ] 7.3 Store failed notification attempts for admin review (failureReason in Notification table)
  - _Requirements: 13, 14, 15, 16, 17, 18, 19, 20, 21, 22_

- [ ] 8. Integrate Bot Health Check
  - [ ] 8.1 Add Telegram API connectivity check (getMe) to health endpoint
  - _Requirements: 34_

- [ ] 9. Enhance /mydeals Command
  - [ ] 9.1 Include deals where user is a participant (not just creator)
  - _Requirements: 11_

- [ ] 10. Final Verification
  - [ ] 10.1 Bot source files compile without errors
  - [ ] 10.2 All acceptance criteria covered
