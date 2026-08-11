# Original User Request

## 2026-08-10T20:35:28Z

# Teamwork Project Prompt — Draft

> Status: Step 1 — Eliciting project idea
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Diagnose and fix the root causes of the connection instability (408, 428 disconnects), continuous `libsignal` session errors (`No session record`, `No matching sessions found`), and container restarts in the Baileys WhatsApp bot.

Working directory: C:/Users/domin/Desktop/my-whatsapp-bot-main

## Requirements

### R1. Suppress Unhandled Rejections Causing Restarts
Update `badMacInterceptor.js` to correctly catch and suppress the `SessionError: No session record` and `SessionError: No matching sessions found for message` errors so they do not crash the Node.js process and trigger container restarts.

### R2. Handle Baileys Disconnects Gracefully
Ensure that 428 (Precondition Required) and 408 (Connection Lost / Timed Out) socket disconnects are handled cleanly without throwing uncaught exceptions or leaking memory during reconnection loops.

## Acceptance Criteria

### Diagnostics & Stability
- [ ] The `badMacInterceptor.js` file properly identifies and suppresses `No session record` and `No matching sessions found for message` errors.
- [ ] The codebase safely catches connection/query timeouts (e.g. `unexpected error in 'init queries'`) to prevent crashing the server.
- [ ] An agent-as-judge verifies that these specific unhandled rejections and socket errors are properly mitigated in the codebase.
