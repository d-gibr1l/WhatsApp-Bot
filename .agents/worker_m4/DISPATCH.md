## 2026-08-10T21:09:56Z
You are Milestone 4 Worker for WhatsApp Bot Connection Instability & Session Error Fixes.

Working directory for your metadata: C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\worker_m4
Project workspace root: C:\Users\domin\Desktop\my-whatsapp-bot-main

MANDATORY READ:
- ORIGINAL_REQUEST: C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\ORIGINAL_REQUEST.md
- PROJECT: C:\Users\domin\Desktop\my-whatsapp-bot-main\PROJECT.md
- TEST_INFRA: C:\Users\domin\Desktop\my-whatsapp-bot-main\TEST_INFRA.md
- TEST_READY: C:\Users\domin\Desktop\my-whatsapp-bot-main\TEST_READY.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

TASK:
1. Execute full unit and integration test suite: `npm test` (or `node --test test/*.test.js`).
2. Execute full project linter: `npm run lint`.
3. Verify that all 5 test files in `test/` (`badMacInterceptor.challenger.test.js`, `connection.test.js`, `error_boundaries.test.js`, `m3_challenger_process_exceptions.test.js`, `m3_harness.test.js`) execute and pass completely.
4. Verify that `npm run lint` completes cleanly with 0 errors.
5. Create `handoff.md` in `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\worker_m4` documenting the test outputs, commands executed, and verification status.
6. Send a message to orchestrator parent with summary of test results.
