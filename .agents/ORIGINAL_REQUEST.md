# Original User Request

## 2026-08-05T19:39:34Z

Perform an extensive code review of the `src/auth` folder in the WhatsApp bot repository, focusing on any bugs that may cause session errors (e.g., Bad MAC, credential loss, reconnection failures). The review should identify bugs, edge cases, concurrency hazards, and provide actionable recommendations.

Working directory: C:/Users/domin/Desktop/my-whatsapp-bot-main
Integrity mode: development

## Requirements

### R1. Comprehensive static analysis
Identify all potential bugs, race conditions, incorrect error handling, and logical flaws in the auth code that could lead to session instability.

### R2. Session-error focus
Prioritize findings that relate to authentication state, key management, session persistence, and error handling (e.g., Bad MAC, disconnect reasons, Redis write failures).

### R3. Actionable report
Produce a detailed Markdown report listing each issue, its severity, location (file + line range), explanation, and a suggested fix.

## Acceptance Criteria

- [ ] The report covers every file in `src/auth`.
- [ ] Each identified issue includes a clear description, severity rating, and concrete remediation steps.
- [ ] No false positives: identified bugs must be plausible given the code context.
- [ ] The report references line numbers or code snippets for each issue.

## 2026-08-10T14:05:59Z

# Teamwork Project Prompt — Draft

> Status: Ready for launch — awaiting user approval
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

Conduct a comprehensive code review and refactoring of the session management and decryption error handling modules in a Baileys-based WhatsApp bot to eliminate state corruption, race conditions, memory leaks, and unhandled Bad MAC decryption errors.

Working directory: C:/Users/domin/Desktop/my-whatsapp-bot-main
Integrity mode: benchmark

## Requirements

### R1. Audit and Refactor Session Management
Actively refactor the authentication and session state files (e.g., `src/auth/redisSession.js`, `src/auth/badMacInterceptor.js`, `src/cache.js`, `src/handler.js`) to ensure thread safety, robust error bubbling, and proper garbage collection of ephemeral data. 

### R2. Eliminate Bad MAC and Amnesia Vulnerabilities
Apply fixes that guarantee transient network drops to Redis do not overwrite valid credentials with empty states (Amnesia), and ensure that all Bad MAC decryption errors are properly handled or rate-limited per chat without globally suppressing vital logs.

## Acceptance Criteria

### Verification via Agent-as-Judge
- [ ] An independent auditor subagent successfully reviews the final codebase against a strict architectural rubric.
- [ ] The auditor verifies that Redis pipeline errors bubble up correctly instead of swallowing exceptions.
- [ ] The auditor verifies that rate-limiting logic is scoped per-chat JID rather than globally.
- [ ] The auditor verifies that the code passes linting (`npm run lint`).
- [ ] The implementing agent provides a detailed walkthrough of the architectural vulnerabilities patched.
