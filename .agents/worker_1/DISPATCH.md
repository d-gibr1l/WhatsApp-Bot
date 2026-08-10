## 2026-08-10T14:11:38Z
You are teamwork_preview_worker 1. Your working directory is C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_1.
Create your working directory and your briefing/progress files in .agents/worker_1.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

MANDATORY FIRST STEPS:
1. Read the user request at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/ORIGINAL_REQUEST.md`
2. Read the project scope document at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/orchestrator/PROJECT.md`
3. Read the explorer analysis at: `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/explorer_1/handoff.md`

Your Task (Milestone 1: Session Management & Amnesia Prevention):
Refactor `src/auth/redisSession.js` and `src/cache.js` to fix all session state management defects:

1. **Amnesia Prevention & Pipeline Error Bubbling (`src/auth/redisSession.js`)**:
   - Ensure transient Redis connection drops or read errors do NOT cause fallback empty credentials/state objects from being saved over existing valid states. If a Redis read fails due to network/connection error, bubble up the error instead of returning empty state fallback.
   - Inspect Redis pipeline `exec()` results: verify that any errors within pipeline execution results bubble up or throw appropriate exceptions rather than silently continuing.
   - Guarantee `purgeAllKeysForJid(jid)` immediately returns 0 if `!jid` or `!base` (preventing glob `${sessionId}:session-.*` wipe).

2. **`_purgedKeys` Tombstone Cleanup (`src/auth/redisSession.js`)**:
   - In `keys.set`, ensure `_purgedKeys.delete(key)` is explicitly called for every key being set in `l1Updates`. This allows instant recovery when Baileys writes a new session key after a Bad MAC purge, removing the 10-second stall window.

3. **Synchronous L1 Cache Updates (`src/auth/redisSession.js`)**:
   - Move L1 cache mutations (`l1Set` and `_l1Cache.delete`) in `keys.set` so they execute synchronously BEFORE awaiting `trackWrite(pipeline.exec())`. This prevents race condition windows where concurrent reads see stale/deleted L1 values while pipeline network writes are pending.

4. **LRU Order Refresh in JS Map (`src/auth/redisSession.js`)**:
   - In `l1Set`, ensure `_l1Cache.delete(key)` is called before `_l1Cache.set(key, value)` so that updating an existing key refreshes its insertion order in the JS `Map`. Hot keys accessed/updated frequently will not be prematurely evicted when size hits `L1_MAX`.

5. **Verification**:
   - Run `node -c src/auth/redisSession.js` and `node -c src/cache.js`.
   - Run `npm test` and document exact command output in `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_1/handoff.md`.

Write your full handoff report to `C:/Users/domin/Desktop/my-whatsapp-bot-main/.agents/worker_1/handoff.md` and notify orchestrator when done.
