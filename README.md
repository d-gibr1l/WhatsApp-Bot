\# WhatsApp Multi-Session Redis Manager



Production-grade Baileys integration with Redis persistence, optimized for Upstash and Koyeb.



\## 🚀 Deployment



\### Upstash Redis Setup

1\. Create a Redis Database on \[Upstash](https://upstash.com/).

2\. Copy the \*\*Redis URL\*\* (starts with `redis://`).

3\. Ensure "Eviction" is disabled in Upstash settings to prevent auth loss.



\### Koyeb Deployment

1\. Create a new "Web Service".

2\. Link your GitHub repo.

3\. Add the following Environment Variables:

&#x20;  - `REDIS\_URL`: Your Upstash URL.

&#x20;  - `API\_KEY`: A strong secret for your endpoints.

&#x20;  - `WEBHOOK\_URL`: (Optional) URL to receive message events.

4\. Set the Health Check path to `/health`.



\## 🛠 API Usage



\### Create/Connect Session

`POST /api/sessions`

\*\*Header:\*\* `x-api-key: your\_secret`

\*\*Body:\*\* `{"id": "user\_1"}`

\*Returns QR code or connection status.\*



\### List Active Sessions

`GET /api/sessions`



\### Remove Session

`DELETE /api/sessions/user\_1`



\## 🛡 Anti Bad-MAC Logic

\- \*\*Serialized Writes:\*\* Uses a Mutex to ensure `creds.update` and `keys.set` never overlap.

\- \*\*Lazy Loading:\*\* Signal keys are pulled from Redis only when needed and cached in memory for the duration of the handshake.

\- \*\*Atomic Locking:\*\* Prevents two Koyeb instances from using the same Session ID simultaneously.

