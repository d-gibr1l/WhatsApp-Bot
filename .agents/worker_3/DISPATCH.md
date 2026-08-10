## 2026-08-10T14:27:34Z
Create your working directory and your briefing/progress files in .agents/worker_3.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY FIRST STEPS:
1. Read the user request at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/ORIGINAL_REQUEST.md`
2. Read the project scope document at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/orchestrator/PROJECT.md`
3. Read the explorer analysis at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/explorer_3/handoff.md`

Your Task (Milestone 3: Ephemeral Data GC, Cache Stability & ESLint Infrastructure):
Refactor `src/cache.js`, `src/commands/antidelete.js`, `src/db.js`, `eslint.config.js`, and `package.json` to fix all memory, cache, test runner, and linting issues:

1. **Unbounded Map GC Fix in `src/commands/antidelete.js`**:
   - Replace unbounded `const groupMetaCache = new Map();` with `new LRUCache({ max: 500, ttl: 5 * 60 * 1000 })` using `lru-cache`. Ensure expired keys are automatically evicted and map capacity is bounded.
   - Clean up dead code `const messageSignatures = new Map();` in `src/handler.js`.

2. **Cache Reference Stability & Realtime Fallback in `src/cache.js`**:
   - In `loadCache()`, mutate `cache.admins`, `cache.banned`, `cache.allowedGroups`, `cache.settings`, and `cache.autoReplyTrie` IN-PLACE (e.g. `cache.admins.clear()` followed by adding elements) rather than reassigning `cache = { ... }`.
   - In `startCacheAutoRefresh()`, when `status === 'CHANNEL_ERROR'`, initiate fallback polling interval if not already set: `if (!fallbackInterval) fallbackInterval = setInterval(loadCache, 5 * 60 * 1000);`.

3. **Test Runner Process Hang Fix in `src/db.js`**:
   - Store log flush interval handle and call `.unref()` so active timer does NOT keep the Node.js event loop open after unit tests finish:
     ```javascript
     const flushTimer = setInterval(async () => { ... }, 5000);
     flushTimer.unref?.();
     ```

4. **ESLint Infrastructure & Code Quality (`eslint.config.js`, `package.json`)**:
   - Update `eslint.config.js` to import `@eslint/js` and extend `js.configs.recommended`. Target `src/**/*.js` AND `index.js`.
   - Fix any linting errors flagged across the codebase so `npm run lint` passes cleanly with exit code 0.

5. **Verification**:
   - Run `npm test` and verify that unit tests pass AND the test process exits cleanly to prompt without hanging.
   - Run `npm run lint` and verify it passes with exit code 0.
   - Document exact verification command outputs in `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_3/handoff.md`.

Write your full handoff report to `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_3/handoff.md` and notify orchestrator when done.
