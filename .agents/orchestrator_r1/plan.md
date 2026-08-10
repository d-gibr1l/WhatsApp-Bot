# Orchestration Plan — Auth Module Refactoring & Optimization

## Objectives
1. Perform comprehensive code review and refactoring of `src/auth/` (specifically `redisSession.js` and `badMacInterceptor.js`).
2. Identify & implement stability, performance, error handling, memory leak prevention, or architectural improvements.
3. Ensure Signal protocol key management, Redis lifecycle, and Bad MAC interception logic remain fully operational.
4. Pass code validity (`node -c`) and runtime stability verification.

## Phase Strategy (Project Pattern)
1. **Survey Phase**:
   - Spawn 3 parallel `teamwork_preview_explorer` subagents to analyze `src/auth/redisSession.js`, `src/auth/badMacInterceptor.js`, and their usages across the project.
   - Explorer 1: Focus on `src/auth/redisSession.js` (Signal key storage, serialization, batch ops, caching, TTL, Redis connection lifecycle).
   - Explorer 2: Focus on `src/auth/badMacInterceptor.js` (Baileys/Signal MAC error handling, session key clearing, retry/re-pair mechanisms, error catching).
   - Explorer 3: Focus on overall auth module usage, interactions with `index.js` / Baileys connection setup, potential concurrency issues, memory leaks, and edge cases.
2. **Synthesis & Plan (PROJECT.md)**:
   - Combine survey findings into `PROJECT.md` at root, defining specific refactoring items and milestones.
3. **Execution Phase**:
   - Dispatch `teamwork_preview_worker` to implement refactoring improvements in `src/auth/redisSession.js` and `src/auth/badMacInterceptor.js`.
   - Worker must run `node -c` on modified files and verify syntax/build.
4. **Verification & Audit Gate**:
   - Dispatch 2 `teamwork_preview_reviewer` subagents to review changes for correctness, robustness, and preservation of Signal protocol / Redis semantics.
   - Dispatch 1 `teamwork_preview_challenger` to verify runtime stability or edge case behavior.
   - Dispatch 1 `teamwork_preview_auditor` to ensure genuine implementation with zero integrity violations.
5. **Reporting**:
   - Synthesize results and present human report.
