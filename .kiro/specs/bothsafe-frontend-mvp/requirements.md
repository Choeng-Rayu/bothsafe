# Requirements Document: BothSafe Frontend MVP

## Introduction

The BothSafe Frontend is a mobile-first Next.js web application that provides the user interface for the Deal Room escrow platform. It serves buyers, sellers, and admins in Cambodia's social commerce ecosystem, enabling secure transactions through shareable Deal Room links that can be distributed via chat applications (Telegram, Messenger, WeChat, Facebook).

The frontend consumes the BothSafe Backend API and provides a trust-first, mobile-optimized experience with multi-language support (Khmer, English, Chinese) and anonymous participant access without forced login.

## Glossary

- **Deal_Room**: A protected transaction workspace accessible via a unique shareable URL where buyer and seller complete an escrow transaction
- **Frontend_Application**: The Next.js web application that renders the user interface
- **Participant**: A buyer or seller who has joined a Deal Room
- **Creator**: The participant (buyer or seller) who initially creates a Deal Room
- **Counterparty**: The participant who joins an existing Deal Room via invite link
- **Access_Token**: A secure token that grants a participant access to a specific Deal Room
- **Invite_Token**: A secure token embedded in a URL that allows a counterparty to join a Deal Room
- **Deal_Status**: The current state of a Deal Room in the escrow workflow
- **Backend_API**: The NestJS REST API that the Frontend_Application consumes
- **Admin_User**: A privileged user who can manually verify payments and manage escrow operations
- **Language_Switcher**: A UI component that allows users to change the display language
- **Status_Badge**: A UI component that displays the current Deal_Status
- **Missing_Fields_Checklist**: A UI component that shows required fields that must be completed before proceeding
- **Timeline**: A UI component that displays the chronological history of Deal Room events
- **Payment_Proof**: An image uploaded by the buyer showing evidence of payment to BothSafe
- **Shipping_Proof**: An image or document uploaded by the seller showing evidence of product shipment
- **Dispute**: A formal objection raised by the buyer regarding the transaction
- **Mobile_First**: A design approach where the interface is optimized for mobile devices as the primary use case
- **Anonymous_Access**: The ability to use the application without creating an account or logging in
- **Allowed_Actions**: A list of actions the current user is permitted to perform, provided by the Backend_API
- **Section**: A logical grouping of Deal Room data (product, participant, delivery, payout)

## Requirements

### Requirement 1: Public Landing Page

**User Story:** As a potential user, I want to understand what BothSafe is and how to create a Deal Room, so that I can decide whether to use the platform.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render a public landing page at the root URL path
2. THE Frontend_Application SHALL display an explanation of the BothSafe escrow service on the landing page
3. THE Frontend_Application SHALL display a call-to-action button for creating a Deal Room on the landing page
4. THE Frontend_Application SHALL display a Language_Switcher component on the landing page
5. WHEN a user clicks the create Deal Room button, THE Frontend_Application SHALL navigate to the Deal Room creation page
6. THE Frontend_Application SHALL render the landing page with mobile-optimized layout and typography
7. THE Frontend_Application SHALL load the landing page within 3 seconds on a 3G mobile connection

### Requirement 2: Multi-Language Support

**User Story:** As a Cambodian user, I want to use the application in my preferred language (Khmer, English, or Chinese), so that I can understand the interface clearly.

#### Acceptance Criteria

1. THE Frontend_Application SHALL support three languages: Khmer (km), English (en), and Chinese (zh)
2. THE Frontend_Application SHALL render a Language_Switcher component on all public pages
3. WHEN a user selects a language, THE Frontend_Application SHALL update all displayed text to the selected language
4. THE Frontend_Application SHALL persist the user's language preference across page navigations
5. WHEN a user visits the application for the first time, THE Frontend_Application SHALL detect the browser's language preference and set the default language accordingly
6. THE Frontend_Application SHALL use translation keys for all user-visible text instead of hardcoded strings
7. THE Frontend_Application SHALL display a fallback message in English when a translation key is missing

### Requirement 3: Deal Room Creation Flow

**User Story:** As a buyer or seller, I want to create a Deal Room, so that I can initiate a protected transaction with a counterparty.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render a Deal Room creation page at the /deals/new URL path
2. THE Frontend_Application SHALL display a role selection interface asking whether the user is a buyer or seller
3. WHEN the user selects the seller role, THE Frontend_Application SHALL display fields for seller name, product title, product type, product description, price, currency, and seller payout account
4. WHEN the user selects the buyer role, THE Frontend_Application SHALL display fields for buyer name, requested product title, product type, expected price, currency, and note to seller
5. WHEN the user submits the creation form, THE Frontend_Application SHALL call POST /v1/deals on the Backend_API
6. WHEN the Backend_API returns a successful response, THE Frontend_Application SHALL display the creator private link and invite link
7. THE Frontend_Application SHALL display a copy button for the invite link
8. THE Frontend_Application SHALL display an open Deal Room button that navigates to the Deal Room page
9. THE Frontend_Application SHALL validate required fields before allowing form submission
10. WHEN validation fails, THE Frontend_Application SHALL display clear error messages for invalid fields

### Requirement 4: Deal Room Page Rendering

**User Story:** As a participant, I want to view the current state of the Deal Room, so that I can understand the transaction status and take appropriate actions.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render a Deal Room page at the /d/[publicId] URL path
2. WHEN the Deal Room page loads, THE Frontend_Application SHALL call GET /v1/deals/{publicId} on the Backend_API with the participant's Access_Token
3. THE Frontend_Application SHALL display a Deal_Status card showing the current status
4. THE Frontend_Application SHALL display a product card showing product information
5. THE Frontend_Application SHALL display participant cards showing buyer and seller information
6. THE Frontend_Application SHALL display a price summary card showing amount, fees, and net seller amount
7. THE Frontend_Application SHALL display a Timeline component showing the chronological history of events
8. THE Frontend_Application SHALL display a Missing_Fields_Checklist when required fields are incomplete
9. THE Frontend_Application SHALL display action buttons based on the Allowed_Actions provided by the Backend_API
10. THE Frontend_Application SHALL render the Deal Room page with mobile-optimized layout including a sticky bottom action bar
11. WHEN the Backend_API returns an error, THE Frontend_Application SHALL display a user-friendly error message

### Requirement 5: Counterparty Join Flow

**User Story:** As a counterparty, I want to join a Deal Room via an invite link, so that I can participate in the transaction.

#### Acceptance Criteria

1. WHEN a user navigates to /d/[publicId]?invite={inviteToken}, THE Frontend_Application SHALL detect the Invite_Token in the URL
2. THE Frontend_Application SHALL call GET /v1/deals/{publicId} with the Invite_Token to retrieve a safe preview
3. THE Frontend_Application SHALL display a join confirmation interface showing the server-derived counterparty role and basic deal information
4. THE Frontend_Application SHALL display fields for name, phone (optional), and preferred language
5. WHEN the user submits the join form, THE Frontend_Application SHALL call POST /v1/deals/{publicId}/join on the Backend_API with invite_token and the server-derived counterparty role
6. WHEN the Backend_API returns a successful response with a participant Access_Token, THE Frontend_Application SHALL store the Access_Token securely
7. THE Frontend_Application SHALL navigate to the Deal Room page after successful join
8. WHEN the Invite_Token is invalid, THE Frontend_Application SHALL display a clear error page explaining the issue
9. THE Frontend_Application SHALL not display sensitive information (seller payout details) in the preview mode

### Requirement 6: Deal Room Section Editing

**User Story:** As a participant, I want to edit Deal Room information sections, so that I can provide complete and accurate transaction details.

#### Acceptance Criteria

1. WHEN a user clicks an edit button for a section, THE Frontend_Application SHALL display an inline or modal editing interface
2. THE Frontend_Application SHALL allow editing of the product section via PATCH /v1/deals/{publicId}/sections/product
3. THE Frontend_Application SHALL allow editing of the participant section via PATCH /v1/deals/{publicId}/sections/participant
4. THE Frontend_Application SHALL allow editing of the delivery section via PATCH /v1/deals/{publicId}/sections/delivery
5. THE Frontend_Application SHALL allow editing of the payout section via PATCH /v1/deals/{publicId}/sections/payout
6. THE Frontend_Application SHALL only display editable fields that the current user is permitted to modify
7. WHEN the user submits section changes, THE Frontend_Application SHALL call the appropriate PATCH endpoint on the Backend_API
8. WHEN the Backend_API returns validation errors, THE Frontend_Application SHALL display the error messages clearly
9. WHEN the Backend_API returns a successful response, THE Frontend_Application SHALL refresh the Deal Room state
10. THE Frontend_Application SHALL disable editing of locked fields after the payment stage

### Requirement 7: Deal Approval Workflow

**User Story:** As a participant, I want to approve the Deal Room terms, so that the transaction can proceed to the payment stage.

#### Acceptance Criteria

1. WHEN the Deal_Status is AWAITING_BOTH_APPROVAL, THE Frontend_Application SHALL display an approval section
2. THE Frontend_Application SHALL display a summary of final product title, price, buyer name, seller name, and escrow rules
3. THE Frontend_Application SHALL display a warning to the seller about payout account verification
4. THE Frontend_Application SHALL display an approve button
5. WHEN the user clicks the approve button, THE Frontend_Application SHALL call POST /v1/deals/{publicId}/approval on the Backend_API
6. THE Frontend_Application SHALL display the approval status for both buyer and seller in the Timeline
7. WHEN both participants have approved, THE Frontend_Application SHALL update the Deal_Status to READY_FOR_PAYMENT

### Requirement 8: Payment Proof Upload Interface

**User Story:** As a buyer, I want to upload proof of payment, so that the admin can verify my payment and move the transaction forward.

#### Acceptance Criteria

1. WHEN the Deal_Status is READY_FOR_PAYMENT and the current user is the buyer, THE Frontend_Application SHALL display a payment section
2. THE Frontend_Application SHALL display the amount to pay, currency, and BothSafe receiving account information
3. THE Frontend_Application SHALL display payment instructions
4. THE Frontend_Application SHALL display an image upload interface for the payment receipt
5. THE Frontend_Application SHALL display a field for the paid amount
6. THE Frontend_Application SHALL validate file type (image formats only) and file size (maximum 10MB) before upload
7. WHEN the user submits the payment proof, THE Frontend_Application SHALL call POST /v1/deals/{publicId}/payment-proofs on the Backend_API
8. THE Frontend_Application SHALL display an image preview of the uploaded receipt
9. WHEN the upload is successful, THE Frontend_Application SHALL update the Deal_Status to PAYMENT_PENDING_VERIFICATION
10. THE Frontend_Application SHALL display a message explaining that admin verification is in progress
11. THE Frontend_Application SHALL only display the payment proof upload interface to the buyer, not the seller

### Requirement 9: Shipping Proof Upload Interface

**User Story:** As a seller, I want to upload proof of shipment, so that the buyer knows the product has been sent.

#### Acceptance Criteria

1. WHEN the Deal_Status is PAID_ESCROWED or SELLER_PREPARING and the current user is the seller, THE Frontend_Application SHALL display a shipping section
2. THE Frontend_Application SHALL display fields for delivery company (optional), tracking number (optional), package photo (optional), delivery receipt (optional), and seller note (optional)
3. THE Frontend_Application SHALL validate file type and file size for uploaded images
4. WHEN the user submits the shipping proof, THE Frontend_Application SHALL call POST /v1/deals/{publicId}/shipping-proofs on the Backend_API
5. WHEN the upload is successful, THE Frontend_Application SHALL update the Deal_Status to SHIPPED
6. THE Frontend_Application SHALL display the shipping proof to the buyer
7. THE Frontend_Application SHALL only display the shipping proof upload interface to the seller, not the buyer

### Requirement 10: Buyer Delivery Confirmation and Dispute Interface

**User Story:** As a buyer, I want to confirm receipt of the product or open a dispute, so that the transaction can be completed or resolved.

#### Acceptance Criteria

1. WHEN the Deal_Status is SHIPPED and the current user is the buyer, THE Frontend_Application SHALL display a confirmation section
2. THE Frontend_Application SHALL display a "Confirm Received" button
3. THE Frontend_Application SHALL display an "Open Dispute" button
4. WHEN the user clicks "Confirm Received", THE Frontend_Application SHALL call POST /v1/deals/{publicId}/confirm-received on the Backend_API
5. WHEN the confirmation is successful, THE Frontend_Application SHALL render the returned Deal_Status, which is expected to be RELEASE_PENDING after the backend records BUYER_CONFIRMED in the Timeline
6. WHEN the user clicks "Open Dispute", THE Frontend_Application SHALL display a dispute form
7. THE Frontend_Application SHALL display dispute reason options: ITEM_NOT_RECEIVED, WRONG_ITEM, DAMAGED_ITEM, FAKE_ITEM, PAYMENT_PROBLEM, OTHER
8. THE Frontend_Application SHALL display fields for dispute message and evidence images (optional)
9. WHEN the user submits the dispute, THE Frontend_Application SHALL call POST /v1/deals/{publicId}/disputes on the Backend_API
10. WHEN the dispute is submitted successfully, THE Frontend_Application SHALL update the Deal_Status to DISPUTED
11. THE Frontend_Application SHALL hide the normal release buttons when a dispute is active
12. THE Frontend_Application SHALL display the dispute event in the Timeline

### Requirement 11: Admin Dashboard

**User Story:** As an admin, I want to view and manage Deal Rooms, so that I can manually verify payments and release or refund funds.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render an admin login page at the /admin URL path
2. THE Frontend_Application SHALL render an admin deal list page at the /admin/deals URL path
3. THE Frontend_Application SHALL render an admin deal detail page at the /admin/deals/[dealId] URL path
4. THE Frontend_Application SHALL require server-side session authentication for all admin routes
5. WHEN an unauthenticated user attempts to access an admin route, THE Frontend_Application SHALL redirect to the admin login page
6. THE Frontend_Application SHALL call GET /v1/admin/deals to retrieve the list of deals
7. THE Frontend_Application SHALL display filters for Deal_Status on the admin deal list page
8. THE Frontend_Application SHALL display a table of deals with key information (publicId, status, amount, participants)
9. WHEN an admin clicks on a deal, THE Frontend_Application SHALL navigate to the admin deal detail page
10. THE Frontend_Application SHALL display Payment_Proof images with a viewer component
11. THE Frontend_Application SHALL display Shipping_Proof images with a viewer component
12. THE Frontend_Application SHALL display dispute evidence with a viewer component
13. THE Frontend_Application SHALL display a verify button for pending payment proofs
14. THE Frontend_Application SHALL display a reject button for pending payment proofs
15. WHEN an admin clicks verify, THE Frontend_Application SHALL call POST /v1/admin/payment-proofs/{paymentId}/verify on the Backend_API
16. WHEN an admin clicks reject, THE Frontend_Application SHALL call POST /v1/admin/payment-proofs/{paymentId}/reject on the Backend_API
17. THE Frontend_Application SHALL display a release button for deals ready for payout
18. THE Frontend_Application SHALL display a refund button for disputed deals
19. WHEN an admin clicks release, THE Frontend_Application SHALL call POST /v1/admin/deals/{dealId}/release on the Backend_API
20. WHEN an admin clicks refund, THE Frontend_Application SHALL call POST /v1/admin/deals/{dealId}/refund on the Backend_API
21. THE Frontend_Application SHALL display an admin note input field
22. THE Frontend_Application SHALL display the result of admin actions in the deal Timeline

### Requirement 12: Access Token Security

**User Story:** As a participant, I want my access to the Deal Room to be secure, so that unauthorized users cannot view or modify my transaction.

#### Acceptance Criteria

1. WHEN the Frontend_Application receives an Access_Token from the Backend_API, THE Frontend_Application SHALL store the token securely in an httpOnly cookie or localStorage
2. THE Frontend_Application SHALL include participant Access_Tokens in the X-Access-Token header for authenticated participant API requests
3. THE Frontend_Application SHALL not log raw Access_Token values to the browser console
4. THE Frontend_Application SHALL display a warning message to users to keep their Deal Room link safe
5. WHEN an Access_Token is invalid or expired, THE Frontend_Application SHALL display a clear error message and prevent access to the Deal Room
6. THE Frontend_Application SHALL not expose seller payout details to the buyer role

### Requirement 13: Mobile-First Responsive Design

**User Story:** As a mobile user, I want the application to work well on my phone, so that I can complete transactions from chat apps.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render all pages with mobile-optimized layouts as the primary design
2. THE Frontend_Application SHALL use minimum tap target sizes of 44 pixels for all interactive elements
3. THE Frontend_Application SHALL display a sticky bottom action bar on Deal Room pages for primary actions
4. THE Frontend_Application SHALL use large, readable typography optimized for mobile screens
5. THE Frontend_Application SHALL render forms with mobile-friendly input fields
6. THE Frontend_Application SHALL support image upload from phone gallery and camera
7. THE Frontend_Application SHALL render correctly on viewport widths from 320 pixels to 1920 pixels
8. THE Frontend_Application SHALL load and render pages within 3 seconds on a 3G mobile connection

### Requirement 14: API Error Handling

**User Story:** As a user, I want to see clear error messages when something goes wrong, so that I understand what happened and what to do next.

#### Acceptance Criteria

1. WHEN the Backend_API returns a 4xx client error, THE Frontend_Application SHALL display the error message provided by the API
2. WHEN the Backend_API returns a 5xx server error, THE Frontend_Application SHALL display a generic error message and suggest retrying
3. WHEN the Backend_API is unreachable, THE Frontend_Application SHALL display a network error message
4. WHEN a form validation error occurs, THE Frontend_Application SHALL display field-specific error messages
5. THE Frontend_Application SHALL display error messages in the user's selected language
6. THE Frontend_Application SHALL provide a retry mechanism for failed API requests where appropriate

### Requirement 15: Deal Room Link Compatibility

**User Story:** As a user, I want Deal Room links created from the Telegram bot to work in the web application, so that I can seamlessly switch between platforms.

#### Acceptance Criteria

1. THE Frontend_Application SHALL support Deal Room URLs with an "access" query parameter containing an Access_Token
2. THE Frontend_Application SHALL support Deal Room URLs with an "invite" query parameter containing an Invite_Token
3. WHEN a user navigates to a Deal Room URL with an "access" parameter, THE Frontend_Application SHALL extract and store the Access_Token
4. WHEN a user navigates to a Deal Room URL with an "invite" parameter, THE Frontend_Application SHALL initiate the join flow
5. THE Frontend_Application SHALL render the same Deal Room page regardless of whether the deal was created via web or Telegram bot

### Requirement 16: Status Badge Component

**User Story:** As a user, I want to see the current status of the Deal Room at a glance, so that I understand where we are in the transaction process.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render a Status_Badge component that displays the current Deal_Status
2. THE Status_Badge SHALL use the exact status values provided by the Backend_API without modification
3. THE Status_Badge SHALL display user-friendly status labels using translation keys
4. THE Status_Badge SHALL use color coding to indicate status categories (draft, active, completed, disputed, cancelled)
5. THE Status_Badge SHALL render with mobile-optimized sizing and typography

### Requirement 17: Timeline Component

**User Story:** As a participant, I want to see the history of events in the Deal Room, so that I can track what has happened and when.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render a Timeline component that displays chronological events
2. THE Timeline SHALL display event type, timestamp, and actor for each event
3. THE Timeline SHALL display events in reverse chronological order (newest first)
4. THE Timeline SHALL display approval events showing which participant approved
5. THE Timeline SHALL display payment proof upload events
6. THE Timeline SHALL display shipping proof upload events
7. THE Timeline SHALL display confirmation events
8. THE Timeline SHALL display dispute events
9. THE Timeline SHALL display admin action events (verify, reject, release, refund)
10. THE Timeline SHALL render with mobile-optimized layout

### Requirement 18: Missing Fields Checklist Component

**User Story:** As a participant, I want to see which required fields are missing, so that I know what information I need to provide before proceeding.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render a Missing_Fields_Checklist component when required fields are incomplete
2. THE Missing_Fields_Checklist SHALL display the list of missing fields provided by the Backend_API
3. THE Missing_Fields_Checklist SHALL display user-friendly field labels using translation keys
4. THE Missing_Fields_Checklist SHALL group missing fields by section (product, participant, delivery, payout)
5. THE Missing_Fields_Checklist SHALL hide when all required fields are complete
6. THE Missing_Fields_Checklist SHALL render with mobile-optimized layout

### Requirement 19: Image Upload Component

**User Story:** As a user, I want to upload images easily from my phone, so that I can provide payment proof, shipping proof, or dispute evidence.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render an image upload component that accepts image files
2. THE Frontend_Application SHALL validate file type to accept only MVP-supported image formats (JPEG, PNG, WebP)
3. THE Frontend_Application SHALL validate file size to reject files larger than 10MB
4. WHEN validation fails, THE Frontend_Application SHALL display a clear error message
5. THE Frontend_Application SHALL display a preview of the selected image before upload
6. THE Frontend_Application SHALL support selecting images from phone gallery
7. THE Frontend_Application SHALL support capturing images from phone camera
8. THE Frontend_Application SHALL display upload progress during file upload
9. THE Frontend_Application SHALL display a success message when upload completes
10. THE Frontend_Application SHALL render with mobile-optimized layout and large tap targets

### Requirement 20: Copy Link Component

**User Story:** As a creator, I want to easily copy the invite link, so that I can share it with the counterparty via chat apps.

#### Acceptance Criteria

1. THE Frontend_Application SHALL render a copy link button component
2. WHEN the user clicks the copy button, THE Frontend_Application SHALL copy the link to the system clipboard
3. WHEN the copy is successful, THE Frontend_Application SHALL display a confirmation message
4. WHEN the copy fails, THE Frontend_Application SHALL display the link in a text field for manual copying
5. THE Frontend_Application SHALL render the copy button with mobile-optimized sizing and tap target

### Requirement 21: Parser and Serializer for Deal Room State

**User Story:** As a developer, I want to parse and serialize Deal Room state correctly, so that the frontend accurately represents backend data.

#### Acceptance Criteria

1. THE Frontend_Application SHALL parse JSON responses from the Backend_API into typed TypeScript objects
2. THE Frontend_Application SHALL serialize form data into JSON format for API requests
3. THE Frontend_Application SHALL parse ISO 8601 timestamp strings into Date objects
4. THE Frontend_Application SHALL serialize Date objects into ISO 8601 timestamp strings
5. THE Frontend_Application SHALL parse currency amounts as numbers with two decimal precision
6. THE Frontend_Application SHALL serialize currency amounts as numbers with two decimal precision
7. FOR ALL valid Deal Room state objects, parsing the API response then serializing for an update request then parsing the response SHALL produce an equivalent object (round-trip property)

### Requirement 22: Environment Configuration

**User Story:** As a developer, I want to configure the application for different environments, so that I can run it locally, in staging, and in production.

#### Acceptance Criteria

1. THE Frontend_Application SHALL read the Backend_API base URL from an environment variable
2. THE Frontend_Application SHALL read the application environment (development, staging, production) from an environment variable
3. THE Frontend_Application SHALL use HTTPS for all API requests in production environment
4. THE Frontend_Application SHALL allow HTTP for API requests in development environment
5. THE Frontend_Application SHALL read the default language from an environment variable
6. THE Frontend_Application SHALL validate that required environment variables are set at build time

### Requirement 23: Build and Deployment

**User Story:** As a developer, I want to build and deploy the application, so that users can access it.

#### Acceptance Criteria

1. THE Frontend_Application SHALL build successfully using the Next.js build command
2. THE Frontend_Application SHALL generate static assets for all public pages
3. THE Frontend_Application SHALL generate server-side rendered pages for Deal Room and admin pages
4. THE Frontend_Application SHALL pass TypeScript type checking during build
5. THE Frontend_Application SHALL pass linting checks during build
6. THE Frontend_Application SHALL optimize images during build
7. THE Frontend_Application SHALL generate a production bundle smaller than 500KB (excluding images and fonts)
