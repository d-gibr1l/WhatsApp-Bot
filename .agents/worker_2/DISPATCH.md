## 2026-08-10T14:19:01Z
You are teamwork_preview_worker 2. Your working directory is C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_2.
Create your working directory and your briefing/progress files in .agents/worker_2.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY FIRST STEPS:
1. Read the user request at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/ORIGINAL_REQUEST.md`
2. Read the project scope document at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/orchestrator/PROJECT.md`
3. Read the explorer analysis at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/explorer_2/handoff.md`

Your Task (Milestone 2: Bad MAC Decryption Error Handling & Per-Chat Rate Limiting):
Refactor `src/auth/badMacInterceptor.js`, `src/handler.js`, and `index.js` to fix all decryption error handling and rate-limiting defects:

1. **Empty JID Circuit Breaker & Global Wipe Guard**:
   - In `src/auth/badMacInterceptor.js`, update `purgeForBadMac(keyInfo)` and `getBaseJid(id)`: if `baseJid` is empty or invalid (`!baseJid`), return early immediately. DO NOT track count or trigger `purgeAllForJid('')`.

2. **Per-Chat Scoped Bad MAC Rate Limiting**:
   - In `src/auth/badMacInterceptor.js` (`handleInterceptedLog` and `_unhandledHandler`): when `extractKeyId()` returns `null` (unextractable JID), fallback to a distinct non-colliding fallback key like `console:mac:${sessionId}:unknown_jid` or `unhandled:mac:${sessionId}:unknown_jid`. This ensures unextractable errors do NOT silence Bad MAC rate-limiting globally for all active chats.

3. **Eliminate Silent Log Drops for Suppressible Patterns**:
   - In `src/auth/badMacInterceptor.js`, `handleInterceptedLog`: ensure ALL 7 `SUPPRESS_PATTERNS` (including `'Failed to decrypt message'`, `'Session error:'`, `'Closing session: SessionEntry'`, `'Closing open session in favor of incoming prekey bundle'`) are handled. Non-BadMAC suppressible logs must be output with rate-limiting rather than silently returning without logging.

4. **Restore Pino Diagnostic Visibility & Connection Disconnect Details**:
   - In `index.js`: change `pino({ level: "silent" })` to use `process.env.LOG_LEVEL || "warn"`.
   - In `index.js` connection close handler (`connection === "close"`): log `lastDisconnect?.error?.message` and stack trace alongside `reason` and `statusCode` so critical disconnect details are visible.
   - Clean up duplicate `unhandledRejection` listener in `index.js` so rejections are handled uniformly by `badMacInterceptor.js`.

5. **Verification**:
   - Run `node -c src/auth/badMacInterceptor.js` and `node -c index.js` and `node -c src/handler.js`.
   - Create unit tests for Bad MAC rate limiting / empty JID protection if needed or run `npm test`.
   - Document exact verification command outputs in `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_2/handoff.md`.

Write your full handoff report to `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_2/handoff.md` and notify orchestrator when done.
