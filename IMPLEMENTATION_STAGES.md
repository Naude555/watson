# Implementation Stages

This document tracks staged upgrades for Watson WA API.

## Compatibility Contract (Production Safety)
- [x] **Do not break existing production endpoints**.
- [x] Keep all current request/response shapes for existing routes.
- [x] New features are additive only (new routes, new optional fields, new UI actions).
- [x] If internals change (JSON -> DB), preserve the same external API behavior.

## Stage 1 — Reliability Visibility (Implemented)
- [x] Delivery lifecycle summary in Ops panel (`queued`, `retrying`, `sent`, `delivered`, `read`, `failed`)
- [x] Recent failed outbound list for quick triage
- [x] Queue snapshot shown with waiting/active/failed counts

## Stage 2 — Message Safety & Quality (In Progress)
- [x] Duplicate-send guard (idempotency key support)
- [x] Quiet hours / timezone-aware scheduling guard
- [x] Message template library with preview

## Stage 3 — Security Hardening (Planned)
- [x] Key rotation workflow for API/Admin/media signing secrets
- [x] Role-based access control (`admin`, `operator`, `viewer`)
- [x] CSRF protection for admin state-changing actions
- [x] Optional admin IP allowlist
- [x] Admin action audit log (send, delete, settings change, auth events)

## Stage 4 — Reliability & Recovery (Planned)
- [x] Dead-letter queue UI with retry/cancel controls
- [ ] Message reconciliation job (delivery status consistency)
- [ ] Automated backups (`/data`) + restore workflow
- [x] Expanded health checks (Redis, WhatsApp session, queue lag)

## Stage 5 — Observability (Planned)
- [ ] Structured metrics (latency, failure rate, retries, queue depth)
- [ ] Correlation IDs per message across logs
- [ ] Centralized log sink support
- [ ] Alerting hooks (Telegram/Slack/email)

## Stage 6 — Messaging Product Features (Planned)
- [x] Templates/snippets with variables and preview
- [ ] Campaign mode (batch send, throttle profile, pause/resume)
- [ ] Contact segmentation (tags + saved filters)
- [ ] Conversation notes/internal comments per chat

## Stage 7 — UX & Scale (Planned)
- [ ] Virtualized message list for large histories
- [ ] Unread/new-since markers and jump behavior
- [ ] In-chat search + jump to message
- [ ] Keyboard shortcuts for operator speed

## Stage 8 — Data Model & Storage (Planned)
- [ ] Move persistence from JSON files to DB (SQLite first, PostgreSQL optional)
- [ ] Add indexes for chat history/contact lookup performance
- [ ] Retention and archival policies
- [ ] Backward-compatible data-access layer (no endpoint breakage)
