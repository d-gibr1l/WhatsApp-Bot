## 2026-08-10T20:49:40Z

You are Milestone 2 Worker for the WhatsApp Bot connection instability and disconnect handling fixes.

Your working directory for coordination/handoff is: C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_worker_m2
The project workspace root is: C:\Users\domin\Desktop\my-whatsapp-bot-main

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY INSTRUCTIONS:
1. Read the verbatim requirements in C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\ORIGINAL_REQUEST.md and the project blueprint in C:\Users\domin\Desktop\my-whatsapp-bot-main\PROJECT.md.
2. Read the M2 Explorer fix specification at C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_m2\handoff.md.
3. Update `index.js`:
   - Implement `extractStatusCode(error)` helper for Boom objects, direct status properties (`statusCode`, `code`), and nested cause objects.
   - Refactor disconnect status 408 & 428 handling: 408 decrements `attempt` (`attempt = Math.max(attempt - 1, 1)`) so socket timeouts preserve attempt count on both initial setup and established connections; 428 resets `attempt = 1` immediately.
   - Add `teardownCurrentSocket(sock)` to immediately execute `sock.ws?.close()`, `sock.ws?.terminate()`, and `sock.ev.removeAllListeners()`, stop active pollers (`stopPoller()`, `stopRadarEngine()`), clear `botReadyTimer`, and reset ready state immediately when `connection === 'close'` occurs.
4. Update `src/handler.js`:
   - Export `resetBotReady()` setting `connectedAt = Infinity`.
   - Update `startReminderPoller` to check `isBotReady()` before attempting database queries.
5. Update `src/commands/radar.js`:
   - Export `stopRadarEngine()` to clear intervals and active timers. Import and invoke in `index.js`.
6. Create `test/connection.test.js`:
   - Add test cases covering `extractStatusCode`, 408/428 attempt handling, ready state resets, immediate teardown execution, and radar engine cleanup.
7. Run `npm test` or `node --test test/connection.test.js` to verify all tests pass cleanly.
8. Document commands run, build/test output, and your exact changes in `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_worker_m2\handoff.md`.
9. Update your `progress.md` before finishing.
10. Send a completion message via `send_message` to parent (id: ce35534c-6698-4e05-8797-813c315a5632).
