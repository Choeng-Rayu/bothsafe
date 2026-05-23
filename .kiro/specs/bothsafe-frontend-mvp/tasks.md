# Implementation Plan: BothSafe Frontend MVP

## Overview

This implementation plan breaks down the BothSafe Frontend MVP into discrete coding tasks. The frontend is a mobile-first Next.js application built with TypeScript, React 19+, and Tailwind CSS, providing the user interface for the Deal Room escrow platform.

**Key Technologies:**
- Next.js 15+ (App Router)
- React 19+
- TypeScript 5+
- Tailwind CSS 4+
- next-intl for i18n (Khmer, English, Chinese)

**Implementation Approach:**
- Mobile-first responsive design
- Anonymous access without forced login
- Server-side rendering for initial page loads
- Client-side state management with React Context
- Secure token storage and management

## Tasks

- [ ] 1. Project setup and foundation
  - Bootstrap Next.js 15+ project with TypeScript and App Router
  - Install and configure core dependencies (React 19+, Tailwind CSS 4+, next-intl)
  - Set up project directory structure following the design document
  - Configure TypeScript with strict mode
  - Set up ESLint and Prettier
  - Create environment variable configuration (.env.local.example)
  - _Requirements: 22, 23_

- [ ] 2. Core infrastructure and utilities
  - [ ] 2.1 Create API client wrapper (lib/api.ts)
    - Implement ApiClient class with get, post, patch, delete methods
    - Add request/response interceptors for X-Access-Token participant token injection
    - Use Authorization: Bearer only for admin JWT requests
    - Implement error transformation to typed error classes
    - Add timeout handling and retry logic
    - _Requirements: 14, 22_
  
  - [ ] 2.2 Create token storage module (lib/token-store.ts)
    - Implement secure token storage (localStorage with encryption or httpOnly cookie)
    - Add methods for storing, retrieving, and clearing access tokens
    - Implement token validation
    - _Requirements: 12_
  
  - [ ] 2.3 Create error handling utilities (lib/errors.ts)
    - Define typed error classes (ApiError, NetworkError, ValidationError, etc.)
    - Implement error message translation helper
    - _Requirements: 14_
  
  - [ ] 2.4 Create TypeScript type definitions (types/)
    - Define Deal domain types (Deal, DealStatus, DealEvent, etc.)
    - Define API request/response types
    - Define User and Admin types
    - _Requirements: 21_
  
  - [ ] 2.5 Create utility functions (lib/utils.ts)
    - Implement date formatting utilities
    - Implement currency formatting utilities
    - Implement input sanitization
    - Add className merging utility for Tailwind
    - _Requirements: 21_

- [ ] 3. Internationalization setup
  - [ ] 3.1 Configure next-intl
    - Set up next-intl with support for km, en, zh locales
    - Configure language detection (localStorage → URL param → browser → default)
    - Create middleware for locale handling
    - _Requirements: 2_
  
  - [ ] 3.2 Create translation files (messages/)
    - Create en.json with all English translations
    - Create km.json with all Khmer translations
    - Create zh.json with all Chinese translations
    - Organize keys by domain (common, deal, payment, shipping, dispute, admin, errors)
    - _Requirements: 2_
  
  - [ ] 3.3 Create LanguageProvider component
    - Implement React Context for language state
    - Add locale switching functionality
    - Persist language preference to localStorage
    - _Requirements: 2_
  
  - [ ] 3.4 Create LanguageSwitcher component
    - Render language selection dropdown
    - Display current language
    - Handle language change events
    - Mobile-optimized with 44px tap targets
    - _Requirements: 2, 13_

- [ ] 4. Layout and navigation components
  - [ ] 4.1 Create root layout (app/layout.tsx)
    - Set up HTML structure with lang attribute
    - Add global providers (LanguageProvider, etc.)
    - Include global styles and fonts
    - Configure metadata for SEO
    - _Requirements: 1, 2_
  
  - [ ] 4.2 Create PublicHeader component
    - Display BothSafe logo
    - Include LanguageSwitcher
    - Mobile-responsive navigation
    - _Requirements: 1, 13_
  
  - [ ] 4.3 Create MobileBottomBar component
    - Sticky bottom action bar for mobile
    - Display primary action button
    - Hide on desktop (inline actions instead)
    - Minimum 44px height for tap targets
    - _Requirements: 13_
  
  - [ ] 4.4 Create AdminLayout component
    - Admin-specific header with logout button
    - Navigation menu for admin routes
    - Session validation wrapper
    - _Requirements: 11_

- [ ] 5. UI component library
  - [ ] 5.1 Create Button component (components/ui/Button.tsx)
    - Support variants (primary, secondary, danger, ghost)
    - Support sizes (small, medium, large)
    - Minimum 44px tap target on mobile
    - Loading state with spinner
    - Disabled state styling
    - _Requirements: 13_
  
  - [ ] 5.2 Create Input component (components/ui/Input.tsx)
    - Text input with label and error message
    - Minimum 44px height on mobile
    - Support for different input types
    - Validation state styling
    - _Requirements: 13_
  
  - [ ] 5.3 Create Select component (components/ui/Select.tsx)
    - Dropdown select with label
    - Mobile-optimized touch targets
    - Support for placeholder and error states
    - _Requirements: 13_
  
  - [ ] 5.4 Create Modal component (components/ui/Modal.tsx)
    - Overlay with centered content
    - Close button and backdrop click handling
    - Mobile-responsive sizing
    - Accessibility (focus trap, ESC key)
    - _Requirements: 13_
  
  - [ ] 5.5 Create Card component (components/ui/Card.tsx)
    - Container with padding and border
    - Support for header, body, footer sections
    - Mobile-optimized spacing
    - _Requirements: 13_
  
  - [ ] 5.6 Create ImageUpload component (components/ui/ImageUpload.tsx)
    - File input with drag-and-drop support
    - Image preview before upload
    - File type validation (JPEG, PNG, WebP)
    - File size validation (max 10MB)
    - Support camera and gallery on mobile
    - Upload progress indicator
    - Clear error messages for validation failures
    - _Requirements: 8, 9, 19_

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Landing page implementation
  - [ ] 7.1 Create landing page (app/page.tsx)
    - Display BothSafe explanation and value proposition
    - Add "Create Deal Room" call-to-action button
    - Include LanguageSwitcher
    - Mobile-first responsive layout
    - Optimize for <3s load time on 3G
    - _Requirements: 1, 13_
  
  - [ ]* 7.2 Write unit tests for landing page
    - Test CTA button navigation
    - Test language switcher functionality
    - Test responsive layout rendering
    - _Requirements: 1_

- [ ] 8. Deal creation flow
  - [ ] 8.1 Create deal creation page (app/deals/new/page.tsx)
    - Render role selection interface (buyer or seller)
    - Display role-specific form fields
    - Implement form validation with Zod schema
    - Call POST /v1/deals API endpoint
    - Display creator private link and invite link on success
    - Show copy buttons for links
    - Display "Open Deal Room" button
    - Handle API errors with clear messages
    - _Requirements: 3, 14_
  
  - [ ] 8.2 Create CopyLinkButton component
    - Copy text to clipboard on click
    - Display success confirmation message
    - Fallback to text field for manual copy if clipboard API fails
    - Mobile-optimized with 44px tap target
    - _Requirements: 3, 20_
  
  - [ ]* 8.3 Write unit tests for deal creation
    - Test role selection logic
    - Test form validation
    - Test API error handling
    - Test link generation and copy functionality
    - _Requirements: 3_

- [ ] 9. Deal Room core components
  - [ ] 9.1 Create StatusBadge component
    - Display current deal status with translated label
    - Color coding by status category (draft=gray, active=blue, completed=green, disputed=red, cancelled=gray)
    - Use exact status values from API without modification
    - Mobile-optimized sizing
    - _Requirements: 4, 16_
  
  - [ ] 9.2 Create Timeline component
    - Display chronological event history in reverse order (newest first)
    - Show event type, timestamp, and actor for each event
    - Support all event types (created, joined, updated, approved, payment, shipping, confirmed, disputed, admin actions)
    - Mobile-optimized layout with clear visual hierarchy
    - _Requirements: 4, 17_
  
  - [ ] 9.3 Create MissingFieldsChecklist component
    - Display list of missing required fields from API
    - Group fields by section (product, participant, delivery, payout)
    - Use translated field labels
    - Hide when all fields complete
    - Mobile-optimized layout
    - _Requirements: 4, 18_
  
  - [ ] 9.4 Create ProductCard component
    - Display product title, type, description, price, currency
    - Show edit button when allowed
    - Mobile-responsive layout
    - _Requirements: 4_
  
  - [ ] 9.5 Create ParticipantCard component
    - Display buyer and seller information
    - Show participant name, phone, role
    - Indicate approval status
    - Show edit button when allowed
    - _Requirements: 4_
  
  - [ ] 9.6 Create PriceSummaryCard component
    - Display amount, platform fee, net seller amount
    - Format currency with 2 decimal precision
    - Mobile-optimized layout
    - _Requirements: 4, 21_
  
  - [ ]* 9.7 Write unit tests for Deal Room components
    - Test StatusBadge color mapping for all statuses
    - Test Timeline event ordering and display
    - Test MissingFieldsChecklist show/hide logic
    - Test currency formatting in PriceSummaryCard
    - _Requirements: 4, 16, 17, 18_

- [ ] 10. Deal Room page and data fetching
  - [ ] 10.1 Create Deal Room page (app/d/[publicId]/page.tsx)
    - Extract publicId, access token, and invite token from URL
    - Fetch deal data via GET /v1/deals/{publicId}
    - Render StatusBadge, ProductCard, ParticipantCard, PriceSummaryCard
    - Render Timeline and MissingFieldsChecklist
    - Display action sections based on status and allowed_actions
    - Handle loading and error states
    - Mobile-first layout with sticky bottom action bar
    - _Requirements: 4, 13, 15_
  
  - [ ] 10.2 Implement API methods in ApiClient
    - Add getDeal(publicId, token) method
    - Add joinDeal(publicId, data, inviteToken) method
    - Add updateSection(publicId, section, data, token) method
    - Add submitApproval(publicId, token) method
    - Add uploadPaymentProof(publicId, data, token) method
    - Add uploadShippingProof(publicId, data, token) method
    - Add confirmReceived(publicId, token) method
    - Add openDispute(publicId, data, token) method
    - _Requirements: 4, 5, 6, 7, 8, 9, 10_
  
  - [ ]* 10.3 Write integration tests for Deal Room page
    - Test deal data fetching and rendering
    - Test error handling for invalid publicId
    - Test token extraction from URL
    - Test responsive layout on different viewports
    - _Requirements: 4, 15_

- [ ] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Counterparty join flow
  - [ ] 12.1 Implement join flow in Deal Room page
    - Detect invite token in URL query parameter
    - Call GET /v1/deals/{publicId} with invite token for safe preview
    - Display join confirmation interface with server-derived counterparty role and basic deal info
    - Render form fields (name, phone optional, preferred language)
    - Call POST /v1/deals/{publicId}/join on form submit with invite_token and counterparty role
    - Store returned access token securely
    - Navigate to Deal Room page after successful join
    - Display clear error for invalid invite token
    - Hide sensitive information (seller payout) in preview mode
    - _Requirements: 5, 12_
  
  - [ ]* 12.2 Write unit tests for join flow
    - Test invite token detection
    - Test join form validation
    - Test token storage after successful join
    - Test error handling for invalid invite
    - _Requirements: 5_

- [ ] 13. Section editing functionality
  - [ ] 13.1 Create SectionEditor component
    - Support inline or modal editing interface
    - Render editable fields based on section type (product, participant, delivery, payout)
    - Only show fields the current user can modify
    - Implement form validation
    - Call appropriate PATCH /v1/deals/{publicId}/sections/{section} endpoint
    - Display validation errors from API
    - Refresh Deal Room state on success
    - Disable editing of locked fields after payment stage
    - _Requirements: 6_
  
  - [ ]* 13.2 Write unit tests for section editing
    - Test field visibility based on user role
    - Test validation error display
    - Test locked field behavior
    - _Requirements: 6_

- [ ] 14. Deal approval workflow
  - [ ] 14.1 Create ApprovalSection component
    - Display when status is AWAITING_BOTH_APPROVAL
    - Show summary of final terms (product, price, participants, escrow rules)
    - Display warning to seller about payout account verification
    - Render approve button
    - Call POST /v1/deals/{publicId}/approval on button click
    - Display approval status for both participants in Timeline
    - Update status to READY_FOR_PAYMENT when both approved
    - _Requirements: 7_
  
  - [ ]* 14.2 Write unit tests for approval workflow
    - Test approval button visibility based on status
    - Test approval submission
    - Test status update after both approvals
    - _Requirements: 7_

- [ ] 15. Payment proof upload interface
  - [ ] 15.1 Create PaymentProofUpload component
    - Display when status is READY_FOR_PAYMENT and user is buyer
    - Show amount to pay, currency, BothSafe receiving account info
    - Display payment instructions
    - Render ImageUpload component for receipt
    - Add input field for paid amount
    - Validate file type and size before upload
    - Call POST /v1/deals/{publicId}/payment-proofs on submit
    - Display image preview of uploaded receipt
    - Update status to PAYMENT_PENDING_VERIFICATION on success
    - Show message explaining admin verification is in progress
    - Hide from seller role
    - _Requirements: 8, 12_
  
  - [ ]* 15.2 Write unit tests for payment proof upload
    - Test visibility based on status and role
    - Test file validation
    - Test API call and status update
    - Test role-based access (buyer only)
    - _Requirements: 8_

- [ ] 16. Shipping proof upload interface
  - [ ] 16.1 Create ShippingProofUpload component
    - Display when status is PAID_ESCROWED or SELLER_PREPARING and user is seller
    - Render fields for delivery company (optional), tracking number (optional), package photo (optional), delivery receipt (optional), seller note (optional)
    - Validate file type and size for images
    - Call POST /v1/deals/{publicId}/shipping-proofs on submit
    - Update status to SHIPPED on success
    - Display shipping proof to buyer
    - Hide from buyer role during upload
    - _Requirements: 9_
  
  - [ ]* 16.2 Write unit tests for shipping proof upload
    - Test visibility based on status and role
    - Test file validation
    - Test API call and status update
    - _Requirements: 9_

- [ ] 17. Delivery confirmation and dispute interface
  - [ ] 17.1 Create DeliveryConfirmation component
    - Display when status is SHIPPED and user is buyer
    - Render "Confirm Received" button
    - Render "Open Dispute" button
    - Call POST /v1/deals/{publicId}/confirm-received on confirm click
    - Render returned status, expected RELEASE_PENDING after BUYER_CONFIRMED is recorded in Timeline
    - _Requirements: 10_
  
  - [ ] 17.2 Create DisputeForm component
    - Display dispute reason options (ITEM_NOT_RECEIVED, WRONG_ITEM, DAMAGED_ITEM, FAKE_ITEM, PAYMENT_PROBLEM, OTHER)
    - Render fields for dispute message and evidence images (optional)
    - Validate inputs
    - Call POST /v1/deals/{publicId}/disputes on submit
    - Update status to DISPUTED on success
    - Hide normal release buttons when dispute is active
    - Display dispute event in Timeline
    - _Requirements: 10_
  
  - [ ]* 17.3 Write unit tests for delivery confirmation and dispute
    - Test button visibility based on status and role
    - Test confirmation flow
    - Test dispute form validation
    - Test dispute submission
    - _Requirements: 10_

- [ ] 18. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 19. Admin authentication
  - [ ] 19.1 Set up NextAuth.js for admin authentication
    - Install and configure NextAuth.js
    - Create API route handler (app/api/auth/[...nextauth]/route.ts)
    - Configure credentials provider for admin login
    - Set up session strategy
    - _Requirements: 11_
  
  - [ ] 19.2 Create admin login page (app/admin/page.tsx)
    - Render login form with email and password fields
    - Call NextAuth signIn on form submit
    - Redirect to /admin/deals on success
    - Display error messages for failed login
    - _Requirements: 11_
  
  - [ ] 19.3 Create admin session middleware
    - Implement server-side session validation
    - Redirect unauthenticated users to /admin
    - Apply to all /admin/* routes except /admin
    - _Requirements: 11_
  
  - [ ]* 19.4 Write unit tests for admin authentication
    - Test login form validation
    - Test redirect logic
    - Test session middleware
    - _Requirements: 11_

- [ ] 20. Admin deal list page
  - [ ] 20.1 Create admin deal list page (app/admin/deals/page.tsx)
    - Call GET /v1/admin/deals to fetch deals
    - Render AdminDealTable component
    - Display filters for deal status
    - Show key information (publicId, status, amount, participants)
    - Navigate to deal detail on row click
    - Implement pagination if needed
    - _Requirements: 11_
  
  - [ ] 20.2 Create AdminDealTable component
    - Render table with sortable columns
    - Display StatusBadge for each deal
    - Format currency amounts
    - Handle row click navigation
    - Mobile-responsive table (horizontal scroll or card layout)
    - _Requirements: 11, 13_
  
  - [ ] 20.3 Implement admin API methods in ApiClient
    - Add getAdminDeals(filters) method
    - Add getAdminDeal(dealId) method
    - Add verifyPayment(paymentId) method
    - Add rejectPayment(paymentId, reason) method
    - Add releaseFunds(dealId, note) method
    - Add refundFunds(dealId, note) method
    - _Requirements: 11_
  
  - [ ]* 20.4 Write unit tests for admin deal list
    - Test deal list rendering
    - Test filtering functionality
    - Test navigation to detail page
    - _Requirements: 11_

- [ ] 21. Admin deal detail page
  - [ ] 21.1 Create admin deal detail page (app/admin/deals/[dealId]/page.tsx)
    - Call GET /v1/admin/deals/{dealId} to fetch deal details
    - Render DealDetailView component
    - Display all deal information
    - Show PaymentVerification component for pending payments
    - Show AdminActionPanel for release/refund actions
    - Display Timeline with all events
    - _Requirements: 11_
  
  - [ ] 21.2 Create PaymentVerification component
    - Display payment proof images with ImageViewer
    - Show paid amount and expected amount
    - Render verify button
    - Render reject button with reason input
    - Call POST /v1/admin/payment-proofs/{id}/verify on verify
    - Call POST /v1/admin/payment-proofs/{id}/reject on reject
    - Display result in Timeline
    - _Requirements: 11_
  
  - [ ] 21.3 Create ImageViewer component
    - Display images in modal with zoom capability
    - Support navigation between multiple images
    - Mobile-optimized touch gestures
    - _Requirements: 11_
  
  - [ ] 21.4 Create AdminActionPanel component
    - Display release button for deals ready for payout
    - Display refund button for disputed deals
    - Render admin note input field
    - Call POST /v1/admin/deals/{id}/release on release
    - Call POST /v1/admin/deals/{id}/refund on refund
    - Display confirmation dialog before actions
    - Show result in Timeline
    - _Requirements: 11_
  
  - [ ]* 21.5 Write unit tests for admin deal detail
    - Test payment verification flow
    - Test release/refund actions
    - Test image viewer functionality
    - _Requirements: 11_

- [ ] 22. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 23. Performance optimization
  - [ ] 23.1 Optimize bundle size
    - Implement dynamic imports for admin routes
    - Tree-shake unused code
    - Analyze bundle with Next.js analyzer
    - Ensure production bundle < 500KB (excluding images/fonts)
    - _Requirements: 23_
  
  - [ ] 23.2 Optimize images
    - Use Next.js Image component for all images
    - Configure image optimization in next.config.js
    - Use WebP format where supported
    - Implement responsive image sizes
    - Lazy load images below the fold
    - _Requirements: 13, 23_
  
  - [ ] 23.3 Optimize loading performance
    - Implement server-side rendering for initial page loads
    - Inline critical CSS
    - Preload fonts
    - Optimize First Contentful Paint < 1.5s
    - Optimize Time to Interactive < 3s on 3G
    - _Requirements: 1, 13, 23_
  
  - [ ]* 23.4 Run performance audits
    - Run Lighthouse audit
    - Verify bundle size target
    - Verify loading time targets
    - _Requirements: 23_

- [ ] 24. Accessibility implementation
  - [ ] 24.1 Implement WCAG 2.1 Level AA compliance
    - Use semantic HTML elements throughout
    - Add ARIA labels where needed
    - Ensure keyboard navigation support for all interactive elements
    - Add visible focus indicators
    - Verify color contrast ratios (4.5:1 for text)
    - Add alt text for all images
    - _Requirements: 13_
  
  - [ ] 24.2 Implement screen reader support
    - Use semantic headings (h1, h2, h3) properly
    - Label all form inputs with associated labels
    - Announce dynamic content changes with ARIA live regions
    - Add skip links for navigation
    - _Requirements: 13_
  
  - [ ]* 24.3 Run accessibility audits
    - Run axe DevTools audit
    - Test with screen reader (NVDA or VoiceOver)
    - Verify keyboard navigation
    - _Requirements: 13_

- [ ] 25. End-to-end testing
  - [ ]* 25.1 Set up Playwright for E2E testing
    - Install and configure Playwright
    - Set up test environment with mock API
    - Configure test browsers (Chrome, Firefox, Safari)
    - _Requirements: 23_
  
  - [ ]* 25.2 Write E2E test: Seller create flow
    - Test seller creates deal
    - Verify creator and invite links are generated
    - Test copy link functionality
    - Test navigation to Deal Room
    - _Requirements: 3_
  
  - [ ]* 25.3 Write E2E test: Buyer join flow
    - Test buyer joins via invite link
    - Verify join form submission
    - Verify access to shared Deal Room
    - _Requirements: 5_
  
  - [ ]* 25.4 Write E2E test: Complete transaction flow
    - Test both participants approve
    - Test buyer uploads payment proof
    - Test admin verifies payment
    - Test seller uploads shipping proof
    - Test buyer confirms delivery
    - Verify status transitions at each step
    - _Requirements: 7, 8, 9, 10, 11_
  
  - [ ]* 25.5 Write E2E test: Dispute flow
    - Test buyer opens dispute after shipping
    - Verify dispute form submission
    - Test admin refund action
    - _Requirements: 10, 11_
  
  - [ ]* 25.6 Write E2E test: Admin workflow
    - Test admin login
    - Test deal list filtering
    - Test payment verification
    - Test fund release
    - _Requirements: 11_

- [ ] 26. Final integration and polish
  - [ ] 26.1 Cross-browser testing
    - Test on Chrome, Firefox, Safari
    - Test on mobile browsers (iOS Safari, Chrome Android)
    - Fix browser-specific issues
    - _Requirements: 13_
  
  - [ ] 26.2 Mobile device testing
    - Test on actual mobile devices (iOS and Android)
    - Verify touch interactions
    - Test camera/gallery image upload
    - Verify responsive layouts
    - _Requirements: 13, 19_
  
  - [ ] 26.3 Error handling review
    - Verify all API errors display user-friendly messages
    - Test network error scenarios
    - Verify retry mechanisms
    - Test form validation errors
    - _Requirements: 14_
  
  - [ ] 26.4 Security review
    - Verify tokens are stored securely
    - Verify no tokens logged to console
    - Verify seller payout details hidden from buyer
    - Test admin route protection
    - _Requirements: 12_
  
  - [ ] 26.5 Translation completeness check
    - Verify all user-visible text uses translation keys
    - Check for missing translations in km and zh
    - Test language switching on all pages
    - _Requirements: 2_

- [ ] 27. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional testing tasks and can be skipped for faster MVP delivery
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation throughout implementation
- All components must be mobile-first with minimum 44px tap targets
- All user-visible text must use translation keys (no hardcoded strings)
- All API calls must include proper error handling
- Token security is critical - never log raw tokens
- Follow the exact Deal Status enum from the backend - never invent new statuses
