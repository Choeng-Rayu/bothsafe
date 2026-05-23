# BothSafe

## Trust Layer for Chat-Based Commerce in Cambodia

BothSafe is an escrow-based payment protection platform designed for Cambodia’s social commerce ecosystem.

The platform helps buyers and sellers safely transact through Telegram, Facebook Messenger, WeChat, and other chat-based platforms by acting as a trusted middle layer between payment and product delivery.

Instead of buyers sending money directly to sellers, BothSafe temporarily holds the payment in escrow until the transaction is completed successfully.

---

# Vision

Build the trust infrastructure for digital and social commerce in Cambodia.

BothSafe aims to reduce scams, fake orders, payment fraud, and trust issues between online buyers and sellers.

---

# Problem

In Cambodia, a large amount of commerce happens through:

* Telegram
* Facebook pages
* Facebook Messenger
* WeChat
* TikTok live selling
* Informal online shops

Current issues:

* Buyers fear fake sellers
* Sellers fear fake buyers
* No payment protection
* No dispute system
* No trusted escrow layer
* Payments are usually sent directly via KHQR
* No transaction tracking

This creates a high-risk environment for online commerce.

---

# Solution

BothSafe introduces a Deal Room escrow system.

Either the buyer or seller can create a protected transaction link called a Deal Room.

The Deal Room contains:

* Product information
* Price
* Payment protection rules
* Buyer and seller confirmation flow
* Escrow payment flow
* Shipping proof
* Delivery confirmation
* Dispute handling

The Deal Room link can be shared directly inside:

* Telegram chats
* Messenger chats
* WeChat chats
* Facebook comments
* Other social platforms

Buyer pays into BothSafe escrow.
Seller ships the product.
Buyer confirms delivery.
BothSafe releases the payment.

---

# MVP Goals

The MVP focuses on validating:

1. Will Cambodian users use escrow payment links?
2. Will sellers trust BothSafe?
3. Will buyers trust BothSafe?
4. Can manual escrow operations work efficiently?
5. What types of disputes happen most often?

The MVP intentionally avoids over-engineering.

---

# Core MVP Features

## Deal Room Link

A protected transaction page that can be created by either buyer or seller.

### Features

* Create deal
* Share deal link
* Add product information
* Add delivery information
* Upload payment proof
* Upload shipping proof
* Confirm delivery
* Open dispute
* Admin escrow management

---

## Escrow Payment Flow

Buyer payment is temporarily held by BothSafe.

### Flow

1. Deal created
2. Deal shared
3. Buyer reviews deal
4. Buyer pays KHQR
5. Payment verified
6. Seller ships product
7. Buyer confirms delivery
8. Payment released to seller

---

## Telegram Bot Integration

BothSafe supports Telegram bot integration for:

* Deal creation
* Deal notifications
* Status updates
* Quick deal sharing
* Payment reminders
* Dispute notifications

---

## Website Dashboard

The web application provides:

* Deal creation
* Deal management
* Payment proof upload
* Shipping tracking
* Buyer confirmation
* Admin dispute handling

---

# Target Users

## Sellers

* Facebook sellers
* Telegram shops
* Clothing sellers
* Cosmetics sellers
* Electronics sellers
* Small online businesses
* Independent online merchants

---

## Buyers

* Online shoppers
* Telegram users
* Facebook marketplace users
* Social commerce buyers

---

# Supported Payment System

## MVP Payment Method

### KHQR (Bakong Ecosystem)

The MVP uses Cambodia’s KHQR ecosystem.

Buyer pays to BothSafe escrow account.
Seller receives payout after transaction completion.

### MVP Payment Validation

Initial MVP validation is manual or semi-manual:

* Buyer uploads payment screenshot
* Admin verifies payment
* Admin releases payout manually

Future versions will support:

* Dynamic KHQR
* Payment webhook integration
* Automatic payment verification
* Automatic payout system

---

# Deal Room Flow

## 1. Deal Creation

Either buyer or seller can create a deal.

### Required Information

* Product title
* Price
* Product category
* Product description
* Delivery method
* Seller payout KHQR

### Optional Information

* Product image
* Buyer note
* Delivery company
* Tracking number

---

## 2. Deal Approval

The other party reviews the deal.

They can:

* Accept deal
* Reject deal
* Update deal information

Once both sides agree:

Deal becomes active.

---

## 3. Payment

Buyer pays using KHQR.

### MVP Process

* Buyer scans BothSafe KHQR
* Buyer uploads receipt screenshot
* Admin verifies payment manually

Status changes to:

PAID_ESCROWED

---

## 4. Shipping

Seller ships product.

Seller uploads:

* Tracking number
* Shipping photo
* Delivery proof

Status changes to:

SHIPPED

---

## 5. Delivery Confirmation

Buyer receives product.

Buyer can:

* Confirm delivery
* Open dispute

If buyer confirms:

Status changes to:

BUYER_CONFIRMED

---

## 6. Payment Release

Admin releases payment to seller payout KHQR.

Status changes to:

RELEASED

---

# Dispute System

The MVP dispute system is intentionally simple.

Buyer can dispute:

* Item not received
* Wrong item
* Damaged item
* Fake product

Admin manually reviews:

* Payment proof
* Tracking information
* Product images
* Chat screenshots

Admin decides:

* Refund buyer
* Release payment to seller

---

# Technology Stack

# Frontend

## Next.js

Frontend web application.

### Responsibilities

* Deal Room UI
* Buyer flow
* Seller flow
* Admin dashboard
* Localization
* Responsive mobile UX

---

# Backend

## NestJS

Main backend service.

### Responsibilities

* Business logic
* Authentication
* Escrow flow
* Deal management
* Payment management
* Admin operations
* Telegram bot integration
* API management

---

# Database

## MySQL

Primary relational database.

---

# ORM

## Prisma

Database ORM and migrations.

---

# File Storage

## MinIO

Stores:

* Payment screenshots
* Product images
* Shipping proof
* Dispute evidence

---

# Telegram Integration

## Telegram Bot API

Integrated directly through NestJS.

### Bot Features

* Create deals
* View deals
* Share deal links
* Receive notifications
* Update deal status

---

# Multi-language Support

The MVP supports:

* Khmer
* English
* Chinese

Localization is important because Cambodian social commerce is multilingual.

---

# UX Philosophy

BothSafe is designed mobile-first.

Most Cambodian users use smartphones for:

* Telegram
* Facebook
* KHQR payments
* Online shopping

UX priorities:

* Simple UI
* Fast loading
* Clear trust indicators
* Minimal steps
* Khmer-friendly experience
* Easy QR payment flow

---

# Security Principles

## MVP Security Goals

* Secure authentication
* Protected file uploads
* Escrow status validation
* Admin action logging
* Rate limiting
* Secure webhook handling
* API validation
* Transaction history tracking

---

# Scalability Philosophy

The MVP is intentionally manual-first.

The system is designed to scale later through:

* Payment automation
* Dynamic KHQR
* Automatic payouts
* Telegram Mini App
* Merchant APIs
* Embedded widgets
* Reputation system
* Fraud detection
* Subscription escrow

---

# Future Roadmap

# Phase 1 — MVP

* Deal Room
* Manual escrow
* KHQR payments
* Telegram bot
* Admin dashboard
* Basic disputes

---

# Phase 2 — Automation

* Dynamic KHQR
* Payment verification API
* Automatic payout
* Delivery integration
* Seller ratings
* Buyer ratings

---

# Phase 3 — Platform Expansion

* Telegram Mini App
* Merchant API
* Embeddable widget
* Subscription escrow
* Digital goods escrow
* Freelancer escrow

---

# Phase 4 — International Payments

* Binance Pay integration
* Cross-border escrow
* Multi-currency support
* International merchant onboarding

---

# Architecture Overview

```text
Frontend (Next.js)
        |
        |
API Gateway
        |
        |
Backend (NestJS)
   |       |       |
   |       |       |
MySQL     MinIO    Telegram Bot
```

---

# Repository Structure

```text
/apps
  /web
  /api
  /bot

/packages
  /shared-types
  /shared-utils
  /i18n

/docs
  backend_task.md
  frontend_task.md
  bot_task.md
```

---

# Why BothSafe Matters

BothSafe is not just a payment tool.

It is a trust infrastructure layer for Cambodia’s informal online economy.

The platform aims to help:

* Reduce online scams
* Improve buyer confidence
* Improve seller confidence
* Enable safer digital commerce
* Create a trusted online transaction ecosystem

---

# Initial Focus Strategy

The first target market should be:

* Telegram sellers
* Facebook clothing sellers
* Small electronics sellers
* Mid-value online transactions

Avoid initially:

* High-risk luxury goods
* Cryptocurrency escrow
* Large-value transactions
* International payments

---

# Product Philosophy

Build trust first.

Automate later.

The first success metric is not technology.

The first success metric is:

"Do users trust BothSafe enough to use it repeatedly?"

---

# Status

Current Stage:

MVP Planning & System Architecture Design
