# Watson WA API

> **Production-ready, self-hosted WhatsApp Web API with Admin UI, durable queues, and automation hooks**

---

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![Docker](https://img.shields.io/badge/docker-required-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
![Status](https://img.shields.io/badge/status-production--ready-success)

Watson WA API is a self-hosted WhatsApp integration platform built on **WhatsApp Web** using **Baileys**.  
It provides a secure API, Admin UI, Pairing UI, durable outbound queues, and optional n8n automation forwarding.

Designed for **single-server production deployments**, with safety-first throttling and persistent message delivery.

---

# Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Screens & UIs](#screens--uis)
- [Repository Structure](#repository-structure)
- [Security Model](#security-model)
- [Requirements](#requirements)
- [Quick Start](#quick-start-production)
- [Environment Variables](#environment-variables)
- [API Overview](#api-overview)
- [Aliases](#aliases-recommended)
- [Durable Queue](#durable-queue)
- [n8n Automations](#n8n-automations-optional)
- [Re-Pairing WhatsApp](#re-pairing-whatsapp)
- [Backups](#backups-important)
- [Security Notes](#security-notes)
- [Production Checklist](#production-checklist)
- [License](#license)

---

# Features

- WhatsApp Web connection via **Baileys**
- QR-based **Pairing UI**
- Web **Admin UI**
- Integration-friendly **REST API**
- Durable outbound queue using **Redis + BullMQ**
- Strong built-in throttling to reduce ban risk
- Signed media URLs for secure previews
- Contact & group alias management
- Chat history browsing
- Optional **n8n webhook forwarding**
- Docker + nginx deployment ready

---

# Architecture

```
Internet
   │
   ▼
nginx (TLS + Basic Auth)
   │
   ▼
wa-api (Node.js / Express / Baileys)
   │
   ├── Redis        → durable outbound queue
   ├── auth/        → WhatsApp session
   ├── data/        → contacts, messages, automations
   └── uploads/     → media files
```

---

# Screens & UIs

## Pairing UI
- QR code login
- One-time device linking
- Session persisted to disk

## Admin UI
- Send messages
- Manage contacts & groups
- Configure automations
- View chat history

> Tip: Protect both with nginx Basic Auth in production.

---

# Repository Structure

```
wa-api/
├─ server.js
├─ package.json
├─ Dockerfile
├─ docker-compose.yml
├─ .env.example
├─ ui/
│  ├─ admin/
│  └─ pairing/
├─ nginx/
│  ├─ conf.d/
│  └─ auth/
└─ README.md
```

---

# Security Model

| Area | Protection |
|------|------------|
Pairing UI | nginx Basic Auth |
Admin UI/API | x-admin-key |
Integration API | x-api-key |
Media Files | Signed URLs |
Redis | Internal only |

---

# Requirements

- Docker
- Docker Compose
- Server with outbound internet access
- WhatsApp account (phone required)

---

# Quick Start (Production)

## Clone

```bash
git clone https://github.com/Naude555/watson.git
cd wa-api
```

## Configure

```bash
cp .env.example .env
```

Edit:

```env
WA_API_KEY=change_me
WA_ADMIN_KEY=change_me
MEDIA_SIGNING_SECRET=long_random_value
NODE_ENV=production
```

## Enable Basic Auth

```bash
mkdir -p nginx/auth

docker run --rm -it   -v "$PWD/nginx/auth:/auth"   httpd:2.4-alpine sh -lc   "apk add --no-cache apache2-utils && htpasswd -c /auth/.htpasswd admin"
```

## Start

```bash
docker compose up -d --build
```

## Pair WhatsApp

Open:

```
http://<server>/pairing/ui
```

Scan QR in WhatsApp → Linked Devices.

---

# Environment Variables

## Core

| Variable | Description |
|----------|-------------|
PORT | Internal port (default 3000) |
NODE_ENV | production |

## Security

| Variable | Description |
|----------|-------------|
WA_API_KEY | Integration API key |
WA_ADMIN_KEY | Admin API/UI key |
MEDIA_SIGNING_SECRET | Media URL signing |

## Redis

| Variable | Description |
|----------|-------------|
REDIS_URL | Redis connection string |
WA_QUEUE_NAME | Queue name |

## Throttling (Safe Defaults)

```env
WA_BASE_DELAY_MS=1200
WA_JITTER_MS=800
WA_PER_JID_GAP_MS=3000
WA_MAX_RETRIES=5
WA_RETRY_BACKOFF_MS=2000
```

---

# API Overview

## Health

```http
GET /health
x-api-key: <key>
```

## Send Text

```http
POST /send
```

```json
{
  "to": "2782xxxxxxx",
  "message": "Hello"
}
```

## Send Image (Upload)

Multipart:

- to
- image
- caption (optional)

## Send Image (URL)

```json
{
  "to": "2782xxxxxxx",
  "imageUrl": "https://...",
  "caption": "Hello"
}
```

## Send Document

- Multipart or URL mode

---

# Aliases (Recommended)

Raw WhatsApp IDs are unreadable:

```
1203xxx@g.us
2782xxx@s.whatsapp.net
```

Aliases let you use human names instead.

Managed in Admin UI → Contacts / Groups.

---

# Durable Queue

Outbound messages are stored in **Redis via BullMQ**.

Benefits:

- Survives restarts
- Persistent retries
- No message loss
- Per-recipient throttling

Concurrency = **1** for account safety.

---

# n8n Automations (Optional)

Enable:

```env
N8N_WEBHOOK_URL=https://...
N8N_SHARED_SECRET=secret
```

Forwarded when rules allow.

Header:

```
x-watson-secret: <secret>
```

---

# Re-Pairing WhatsApp

```bash
docker compose down
rm -rf ./auth/*
docker compose up -d
```

Re-scan QR.

---

# Backups (Important)

Back up:

- auth/
- data/
- uploads/

---

# Security Notes

- Never expose Redis publicly
- Never commit `.env` or `auth/`
- Rotate keys if leaked
- Use HTTPS
- Enable Basic Auth

---

# Production Checklist

- [ ] Secrets configured
- [ ] Redis volume enabled
- [ ] TLS enabled
- [ ] Basic Auth enabled
- [ ] Throttling configured
- [ ] Health endpoint OK
- [ ] WhatsApp paired
- [ ] Backups configured

---

# License

MIT

---

# Philosophy

This system is intentionally conservative:

- Human-like send rates
- Single-threaded queue
- Durability over speed

That’s how WhatsApp accounts survive in production.
