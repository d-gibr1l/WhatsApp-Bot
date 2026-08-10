# Master Orchestration Plan: WhatsApp Bot Session Management & Decryption Error Handling Refactoring

## Objectives
Refactor session state management (`src/auth/redisSession.js`, `src/auth/badMacInterceptor.js`, `src/cache.js`, `src/handler.js`, etc.) to achieve:
1. Thread safety and concurrency safety in state persistence.
2. Robust error bubbling for Redis pipelines to prevent silent swallows and prevent state amnesia (overwriting valid credentials with empty states on transient Redis drops).
3. Ephemeral data garbage collection and memory leak prevention.
4. Per-chat JID scoped Bad MAC error handling and rate-limiting without global log suppression.
5. Codebase lint compliance (`npm run lint`).
6. Passing Forensic Audit (`teamwork_preview_auditor`).
7. Comprehensive architectural documentation of all patched vulnerabilities.

## Phase 0: Survey & Scope Discovery
- Spawn 3 parallel `teamwork_preview_explorer` subagents to analyze `src/auth/`, `src/cache.js`, `src/handler.js`, and related files.
- Produce combined `PROJECT.md` with complete Feature Inventory and Milestone Decomposition.

## Phase 1: Implementation & Verification Loop
- **Milestone 1**: Session Management & Amnesia Prevention (`src/auth/redisSession.js`, `src/cache.js`)
- **Milestone 2**: Bad MAC Decryption Error Handling & Rate Limiting (`src/auth/badMacInterceptor.js`, `src/handler.js`)
- **Milestone 3**: Ephemeral Data GC, Linting & E2E Verification (`npm run lint`, full test suite)

## Phase 2: Audit & Reporting
- Forensic Auditor verification (`teamwork_preview_auditor`).
- Prepare victory report and architectural vulnerability documentation.
