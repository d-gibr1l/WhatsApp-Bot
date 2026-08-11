## 2026-08-10T20:47:13Z
You are Milestone 2 Explorer for the WhatsApp Bot connection instability and disconnect handling fixes.

Your working directory for reports is: C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_m2
The project workspace root is: C:\Users\domin\Desktop\my-whatsapp-bot-main

MANDATORY INSTRUCTIONS:
1. Read the verbatim requirements in C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\ORIGINAL_REQUEST.md and the project blueprint in C:\Users\domin\Desktop\my-whatsapp-bot-main\PROJECT.md.
2. Review Survey Explorer 2's handoff report at C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_survey_2\handoff.md.
3. Formulate a detailed, step-by-step fix specification for `index.js` and background polling/timer modules (`src/handler.js`, `src/radarEngine.js`, `src/reminderPoller.js`):
   - Status Code Extraction: Safely extract status code from Boom (`error?.output?.statusCode`), error properties (`error?.statusCode`), and cause properties (`error?.code`).
   - 408 / 428 Disconnect Handling: Ensure status 408 on established connections (`lastConnectedAt > 0`) does not increment `attempt` count or trip startup failure; ensure status 428 disconnects reset attempt counters or back off cleanly without throwing uncaught exceptions.
   - Immediate Socket & Resource Teardown: Execute `sock.ws?.close()`, `sock.ws?.terminate()`, and `sock.ev.removeAllListeners()` immediately when `connection: 'close'` is received, BEFORE the backoff sleep. Stop active background intervals/timers (`startReminderPoller`, `startRadarEngine`, `markBotReady`).
   - Reconnect Ready State Reset: Immediately set `connectedAt = Infinity` on disconnect so `isBotReady()` is `false` during reconnect, preventing historical offline messages flushed on connection from triggering commands.
   - Specify test cases to verify these behaviors in `test/connection.test.js` or `index.test.js`.
4. Write your fix specification to `C:\Users\domin\Desktop\my-whatsapp-bot-main\.agents\teamwork_preview_explorer_m2\handoff.md`.
5. Update your `progress.md` before finishing.
6. Send a completion message via `send_message` to parent (id: ce35534c-6698-4e05-8797-813c315a5632).
