## 2026-08-10T20:59:21Z
<USER_REQUEST>
You are Milestone 3 Worker for the WhatsApp Bot connection setup error boundaries and process exception handlers.

Your working directory for coordination/handoff is: C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_worker_m3
The project workspace root is: C:\Users\domin\Desktop\my-whatsapp-bot-main

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY INSTRUCTIONS:
1. Read the verbatim requirements in C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\ORIGINAL_REQUEST.md and the project blueprint in C:\Users\domin\Desktop\my-whatsapp-bot-main\PROJECT.md.
2. Read the M3 Explorer fix specification at C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_m3\handoff.md.
3. Update `index.js`:
   - Wrap async startup loader calls in `connection.update` (`loadCache`, `loadWordFilter`, `loadAllowedLinks`, `loadAliases`, `loadSeenMessages`) inside `try...catch` blocks.
   - Wrap `fetchLatestBaileysVersion()` in `createSocket()` inside `try...catch` with fallback version `[2, 3000, 1015901307]`.
   - Update `process.on('uncaughtException')` to execute `teardownCurrentSocket(currentSock)` and `shutdown("UNCAUGHT_EXCEPTION", 1)`. Add `isShuttingDown` recursion guard to `shutdown()`.
4. Update `src/auth/badMacInterceptor.js`:
   - Refactor `escalateRejection(reason)` to remove the fragile `listenerCount > 1` guard and reliably escalate unhandled non-suppressible rejections.
5. Create `test/error_boundaries.test.js`:
   - Add tests verifying async setup error boundaries, init query error suppression, and rejection escalation.
6. Run `npm test` and `npm run lint` to verify all tests pass cleanly with 0 errors.
7. Document commands run, test outputs, and exact changes in `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_worker_m3\handoff.md`.
8. Update your `progress.md` before finishing.
9. Send a completion message via `send_message` to parent (id: ce35534c-6698-4e05-8797-813c315a5632).
</USER_REQUEST>
