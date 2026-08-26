# WhatsApp Ingestion & Analysis Service — Architecture & Reliability Audit

**Date:** 2026-08-26  
**Scope:** Live capture (`whatsapp-web.js` + Puppeteer), session lifecycle, job matching, Mongo/JSON persistence, Docker/Coolify supervision.  
**Method:** Static review of production paths in `server/whatsapp/`, `server/jobs-engine/`, `server/jobs/`, Dockerfiles, and tests. No live WhatsApp session was attached.

---

## 1. Executive Summary

The live pipeline is **not a protocol client**. It is a **headless WhatsApp Web scraper**: `whatsapp-web.js@^1.31.0` (optional dependency; latest published is **1.34.7**) driving **Playwright’s Chromium** inside the same Node process as the voice-agent HTTP server.

That design is the primary reason the service is unreliable.

WhatsApp Web’s DOM and internal modules change frequently. A Puppeteer wrapper several minor versions behind, pointed at Playwright Chromium (not Puppeteer’s bundled Chrome), with **no `webVersion` pin**, **no reconnect/backoff**, and **no Chrome process watchdog**, will desync, hang on `ready`, or die silently after a socket drop. Docker `restart: unless-stopped` only helps if Node itself exits. A zombie Chromium or a stuck `authenticated` state still looks healthy to `/api/health`.

On top of the transport, the **ingestion and analysis layers drop data by design**:

- Raw WhatsApp messages are **never stored**. The Mongo `Message` collection is for Telegram / web-ui / voice chat, not WA.
- The live handler skips **all media** when `config.json` has `textOnly: true` (the default). Israeli job groups routinely post image+caption ads; those are discarded even when `msg.body` holds the caption.
- `@lid` / `@broadcast` senders are dropped **before** `getChat()` unless `to` already contains `@g.us`. After WhatsApp’s LID migration this silently filters real group traffic.
- If Mongo is not connected yet (boot race) or later drops, matched jobs return `skipped: 'mongo_unavailable'` and are **gone forever** — no retry queue.
- Live ingest writes **Mongo `Job` documents** (`status: discovered`) and **does not** call the Telegram approval pipeline. The MCP/export path writes a **separate JSON file** (`data/jobs-db.json`) and *does* notify Telegram. The two stores never reconcile.

**Bottom line:** the current system is a browser session glued to an in-callback keyword filter. It is not a resilient real-time ingest pipeline. Until the transport is either replaced (Baileys) or heavily hardened, and persistence is decoupled from the Puppeteer event loop, message loss and “WhatsApp randomly dies” will continue.

---

## 2. Identified Bottlenecks & Bugs

### Critical

| ID | Finding | Evidence |
|----|---------|----------|
| **C1** | **No reconnect, no backoff, no `LoggedOut` vs transient drop.** `disconnected` / `auth_failure` only set state. They do not destroy Chrome, recreate the client, or schedule a retry. Aggressive reconnect is absent — the worse problem is **no reconnect at all**. After a WA protocol bounce the process sits in `disconnected` until a human `POST /api/whatsapp/start`. | `server/whatsapp/session.js` `wireClient()`; `server/jobs/whatsapp-live.js` has no `disconnected` handler at all. |
| **C2** | **Dead Client reuse.** `start()` returns early only when `state === 'authenticated'`. After disconnect, `client` is still set, so `start()` calls `initialize()` on the same instance. whatsapp-web.js generally requires a **new `Client`** after disconnect/destroy. Re-init on a zombie is a common hang. | `session.js` `start()`: `if (!client) { … buildClient() }`. |
| **C3** | **Library/Chromium mismatch vs WhatsApp protocol.** Pinned range is `whatsapp-web.js@^1.31.0`. Current npm is **1.34.7** (2026-04). Docker sets `PUPPETEER_SKIP_DOWNLOAD=true` and `PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/wa-chrome` (Playwright Chromium). Community reports in 2026: `authenticated` fires, `ready` never does, especially on **session restore** with system/Playwright Chrome vs Puppeteer-bundled Chrome. **No `webVersion` / `webVersionCache` pin.** | `package.json` `optionalDependencies`; `Dockerfile.app`; `buildWhatsappPuppeteerOpts()`. |
| **C4** | **Media captions dropped.** `textOnly: true` → `if (msg.hasMedia) return { skipped: 'media' }` **before** reading `body`. Image posts with job text in the caption never reach the matcher. | `config.json`; `ingest.js` `handleWhatsappMessage`; `whatsapp-live.js` handler. |
| **C5** | **LID pre-filter drops group messages.** Handler returns immediately if `from` contains `@lid` or `@broadcast` unless `to` includes `@g.us`. LID is now a normal participant id. Many group events will never enter ingest. | `ingest.js` `attachMessageIngest` handler. |
| **C6** | **No raw message log; Mongo miss is terminal.** Handler does `getChat()` + keyword match + `Job.create` **inside** the event callback (`void handleWhatsappMessage(...)`). If `mongoReady()` is false, result is `skipped: 'mongo_unavailable'`. `mongoose.connect` is started **after** `app.listen`, in parallel with `startIngestWhenReady` / `maybeAutostartWhatsapp`. Early messages (and any later Mongo blip) are lost. | `ingest.js`; `server/index.js` listen callback vs `mongoose.connect`. |
| **C7** | **Split brain: two ingest paths, two databases, one never notifies.** Production HTTP session uses `message_create` → Mongo `Job`. MCP `start_whatsapp_job_watcher` uses **`message`** (incoming only), a **second** `Client`/`LocalAuth`, and `scanAndEnqueueJobs` → **JSON** `JobDb` + Telegram. Live Mongo jobs have **no** Telegram enqueue. GUI “recent jobs” and Telegram approvals can disagree forever. | `jobs-engine/ingest.js` vs `jobs/whatsapp-live.js` vs `jobs/pipeline.js`. |
| **C8** | **Unbounded in-callback work (backpressure).** Every event: optional `getChat()` / `getChatById()` (Puppeteer round-trip), regex matching, Mongo `findOne`+`create`. No queue, no concurrency limit, no ack. A busy group or `message_create` history burst on connect piles promises on the event loop and can stall Chrome IPC. | `attachMessageIngest`; `handleWhatsappMessage`. |
| **C9** | **Two Chromes can share one auth dir.** Shared session (`WHATSAPP_AUTH_PATH` or `.wwebjs_auth`) and MCP watcher (`dataPath: '.wwebjs_auth'` relative to cwd) both use LocalAuth. Concurrent `npm run whatsapp:connect` + autostart, or MCP `dryRun: false` while the HTTP session is up, corrupts IndexedDB / `SingletonLock`. | `session.js` vs `whatsapp-live.js` `defaultCreateClient`; `scripts/connect-whatsapp.js`. |

### Warning

| ID | Finding | Evidence |
|----|---------|----------|
| **W1** | **Auth is Chromium profile on disk.** `LocalAuth({ dataPath })`. Crash mid-write corrupts session. Only mitigation: delete `SingletonLock` on start, plus `POST /api/whatsapp/reset` (full wipe → new QR). No checksum, no copy-on-write snapshot. | `session.js` `start()` / `reset()`. |
| **W2** | **Autostart is off.** `WHATSAPP_AUTOSTART` must be `'1'`. Compose/Dockerfiles do not set it. Container restart ⇒ WA stays `uninitialized` until someone hits `/api/whatsapp/start`. | `maybeAutostartWhatsapp`; `docker-compose.yaml`. |
| **W3** | **SIGTERM/SIGINT do not `client.destroy()`.** Shutdown closes Mongoose then `process.exit(0)`. Chromium can be left as a zombie; next start relies on `SingletonLock` unlink. | `server/index.js`. |
| **W4** | **No process health on the WA session.** `/api/health` never includes WA state. Compose has `restart: unless-stopped` and **no `healthcheck`**. Coolify will not recycle a live Node with a dead Puppeteer page. | `GET /api/health`; `docker-compose.yaml`. |
| **W5** | **Tests do not guard production events.** `attachMessageIngest` listens to **`message_create`**. `scripts/test-whatsapp-ingest.js` **emits `message`**. Root `npm test` does **not** run that file (`test:whatsapp-ingest` is separate). **Empirically confirmed 2026-08-26:** `node scripts/test-whatsapp-ingest.js` → 7 pass, **2 fail** (`attachMessageIngest…` and `startIngestWhenReady…`) because upserts stay empty when the mock emits `message`. | `ingest.js` vs `scripts/test-whatsapp-ingest.js`; `package.json`. |
| **W6** | **`message_create` without history gating.** Comment says it is used to capture `fromMe` (e.g. forwards). `message_create` also fires for session catch-up. There is **no** `msg.id`/`fromMe`/notify-vs-sync filter, so reconnect can replay a flood through `getChat()` (C8). | `ingest.js`. |
| **W7** | **Dedup is content hash, not WhatsApp message id.** Fingerprint = SHA-256 of `groupName\|author\|formUrl\|normalizedText`. Reconnect duplicates are suppressed **only if** text/author/group match. Same job in two groups is **not** deduped (hash includes `groupName`) despite the comment “dedupe across groups”. No unique index on `fingerprint` (only on `jobId`, which equals fingerprint) — TOCTOU `findOne` then `create` can throw `E11000` and look like a lost job. | `jobs/job-db.js`; `jobs-engine/job-store.js`; `models/Job.js`. |
| **W8** | **Groups keyed by display name, not JID.** `isTrackedGroupName` is a case-insensitive name regex. GUI track *can* store real `_serialized` ids, but ingest stores `groupIdFromName` (`name:jobs israel`). Rename the group ⇒ tracking miss. LID/`@g.us` fallback uses `chatId` as `groupName` when `getChat()` fails, which will not match allow-list names. | `group-store.js`; `ingest.js`; `track-gui.js`. |
| **W9** | **QR via Telegram is not scannable.** `notifyQrViaTelegram` sends the first 200 characters of the QR **string**, not a PNG. Operators must open `GET /api/whatsapp/qr` or container logs (`qrcode-terminal`). | `whatsapp/http.js`. |
| **W10** | **Outgoing vs incoming is inconsistent across paths.** HTTP ingest: `message_create` (includes `fromMe`). MCP watcher: `message` (incoming only). Neither inspects `msg.fromMe` explicitly. DMs are skipped (`not_group`); the comment about forwarding a job to **“Me”** is therefore false. | `ingest.js`; `whatsapp-live.js`. |
| **W11** | **Non-text types silently skipped.** Empty `body` → `skipped: 'empty_body'`. Reactions, stickers, ephemeral wrappers, `extendedTextMessage` that don’t flatten into `msg.body`, albums, etc. never reach analysis. No `msg.type` switch, no caption/OCR path. | `handleWhatsappMessage`. |
| **W12** | **JSON JobDb is a blocking file rewrite.** `writeFileSync` of the entire `jobs` object on every upsert. Fine at tens of jobs; a lock/corruption risk under concurrent MCP + watcher. Not SQLite; **WAL is N/A**. | `jobs/job-db.js`. |

### Optimization

| ID | Finding | Evidence |
|----|---------|----------|
| **O1** | **`getChat()` per message** instead of JID → name cache (`Map<chatId, {name, isGroup}>` invalidated on `group_join` / rename). | `ingest.js`. |
| **O2** | **Keyword-only analysis; no replay.** `filterTargetJobs` is regex (HE/EN Full Stack/Backend). Matcher false-negatives cannot be re-scored because raw messages are discarded (C6). | `jobs/job-matcher.js`. |
| **O3** | **Chrome flags.** `--disable-dev-shm-usage` is correct for Docker (no `shm_size` in compose). `--disable-features=site-per-process` reduces isolation and can increase WhatsApp Web crash rate. No `--js-flags=--max-old-space-size`, no Chrome RSS watchdog. | `puppeteer-opts.js`. |
| **O4** | **Co-located blast radius.** Voice HTTP, Gemini, GDrive MCP, Playwright ATS, and WhatsApp Chrome share one container/PID tree. Chrome OOM takes down the GUI. | `Dockerfile.app`; `CMD npm start`. |
| **O5** | **Job indexes are for jobs, not messages.** `Job`: unique `jobId`, indexes on `status`, `fingerprint`, `groupId`. There is no `messageId` / `remoteJid` / WA `timestamp` collection to index. `Message` schema `channel` enum is `telegram \| web-ui \| voice` only. | `models/Job.js`; `models/Message.js`. |
| **O6** | **Health should expose WA + Chrome liveness** (`state`, `ready`, last event age, puppeteer connected) so Coolify can fail the check. | `/api/health`. |

---

## 3. Comparison Against Best Practices

A resilient WhatsApp ingest for downstream analysis looks like:

```
[protocol socket] → [bounded queue] → [idempotent raw persist] → [async workers: parse / match / LLM]
         ↑                    ↓
   backoff reconnect     ack / retry / DLQ
```

| Practice | Target | This repo |
|----------|--------|-----------|
| Transport | Lightweight multi-device protocol (e.g. **Baileys**) or official Cloud API. No full browser. | **Puppeteer + WhatsApp Web.** Highest RAM, highest desync rate. |
| Session | Encrypted creds JSON; reconnect on `connection.close` if `DisconnectReason` ≠ `loggedOut`; exponential backoff + jitter; new socket after logout. | LocalAuth Chromium profile; **no reconnect**; logout and drop treated the same (state flag only). |
| Events | `messages.upsert` with `type === 'notify'` for live; history sync on a **separate** consumer. Dedup `remoteJid + id`. | `message_create` (HTTP) **or** `message` (MCP). No notify-vs-history split. No WA message id store. |
| Normalization | Walk `conversation`, `extendedTextMessage`, `imageMessage.caption`, `ephemeralMessage` unwrap, `fromMe`, reactions. | `String(msg.body)`. Media short-circuit. No type table. |
| Backpressure | Handler **enqueues** `{id, jid, ts, raw}` in &lt;1ms; DB/LLM off the socket thread. | Await `getChat` + Mongo in the listener. |
| Storage | Append-only messages table: unique `(chatId, messageId)`, indexes `(chatId, timestamp)`, WAL or Mongo write concern. | **No message table.** Jobs only. JSON file **or** Mongo Job, not both consistently. SQLite/WAL **not used**. |
| Supervision | Dedicated unit/container; health = “socket open in last N s”; liveness kills Chrome+Node together. | Shared Coolify app; health ignores WA. |
| Analysis | Replayable: change matcher, re-scan stored raw. | Match-or-drop. Cannot replay. |

**Alignment score:** the listen-only safety seals (`sealClientAgainstSends`) and LocalAuth volume (`wwebjs_auth`) are sound. The **event-driven persistence model is not implemented**. The live path is “browser callback → maybe Mongo job”. That is the opposite of a decoupled ingest queue.

---

## 4. Step-by-Step Remediation Plan

Treat this as an ordered refactor. Do not skip transport hardening and hope the matcher will “see more jobs.”

### Phase 0 — Stop the bleeding (same library, 1–2 days)

1. **Single owner of the Client.** Delete or gate MCP `startWhatsappJobWatcher` live mode (`dryRun: false`) while HTTP `getSharedWhatsappSession()` exists. One Chrome, one `LocalAuth` path (`WHATSAPP_AUTH_PATH` absolute).
2. **Reconnect with backoff.** On `disconnected`:
   - If reason is `LOGOUT` / `NAVIGATION` (logged out): set `qr_required`, do **not** loop; alert Telegram with a **QR image** (`qrcode` PNG), not 200 chars of payload.
   - Else: `destroy()`, `client = null`, wait `min(30s, 2^n + jitter)`, `start()` with a **new** Client (fixes C2).
3. **Graceful shutdown:** SIGTERM → `session.stop()` then Mongo close.
4. **`WHATSAPP_AUTOSTART=1`** in Coolify/compose once auth volume is populated.
5. **Health:** `/api/health` includes `whatsapp.state`, `whatsapp.ready`, `whatsapp.lastEventAt`. Coolify healthcheck fails if `authenticated` but no event / puppeteer ping for 120s.
6. **Ingest filter fixes:**
   - Remove the `@lid` early return; classify group via `chatId.endsWith('@g.us')` **or** cached `getChat`.
   - If `hasMedia`, still ingest `msg.body` / caption; only skip when both are empty.
   - Prefer `message` **plus** `fromMe` on `message_create` for explicit forwards; ignore protocol/status types.
7. **Idempotency:** persist `waMessageId = msg.id._serialized` unique. Skip if exists. Do this **before** `getChat()`.
8. **Boot order:** `await mongoose.connect()` **before** `app.listen` / ingest attach. If Mongo is down, **enqueue to disk** (`data/wa-ingest-buffer.jsonl`), do not drop.
9. **Unify stores:** live `upsertDiscoveredJob` must call the same `scanAndEnqueueJobs` (or a shared `enqueueDiscoveredJob`) so Telegram and JSON/Mongo cannot diverge.
10. **Tests:** emit `message_create`; add cases for media+caption, `@lid` group, mongo-down buffer, reconnect. Wire `test:whatsapp-ingest` into `npm test`.

### Phase 1 — Decouple the pipeline (3–5 days)

11. Introduce an in-process **queue** (e.g. `p-limit` + JSONL, or Mongo capped collection):  
    `on('message_create')` → push raw serialized message → return.  
    Worker: normalize → dedup → match → upsert → notify.
12. **Raw `WhatsappMessage` collection** (or SQLite WAL if you want a local-only store): fields `messageId`, `chatId` (JID), `chatName`, `fromMe`, `timestamp`, `type`, `body`, `hasMedia`, `raw`, unique index `(chatId, messageId)`, indexes `(chatId, timestamp)`, `(timestamp)`.
13. Cache `chatId → { isGroup, name }` with TTL; call `getChat()` only on cache miss.
14. Make `Job.fingerprint` **unique**; `findOneAndUpdate` upsert. Remove `groupName` from the hash if cross-group dedup is required; keep a `seenInGroups[]` array instead.
15. Pin **whatsapp-web.js to current patched release**, pin `webVersion` + **local** `webVersionCache`, and use **Puppeteer’s bundled Chrome** (or document a tested Playwright Chromium major). Re-test session restore 5× (the 2026 `ready`-never-fires failure mode).

### Phase 2 — Architecture that can actually stay up (1–2 weeks)

16. **Extract WA to its own process/container** (memory limit, `shm_size: 2gb` if you keep Chrome, independent restart). Voice-agent talks to it over HTTP/NATS.
17. **Replace Puppeteer with Baileys** (or Cloud API if a business number is acceptable):
    - `makeWASocket` + `useMultiFileAuthState`
    - `connection.update`: reconnect iff `shouldReconnect`; never reconnect on `loggedOut`
    - `messages.upsert` `notify` vs `append`/`eval`
    - Same queue + raw collection from Phase 1 (the matcher/Telegram workers stay)
18. Optional: OCR worker for image-only posts; still persist the blob + caption first.
19. Supervision: systemd/Docker health = Baileys `connection === 'open'`; PM2 only if you also cap Chrome (if any remains) and restart on RSS.

### Refactor checklist (code)

- [ ] One `Client` factory; absolute `authPath`; no MCP second browser
- [ ] `disconnected` → destroy + exponential backoff **or** halt on logout
- [ ] `start()` always `buildClient()` after disconnect (`client = null`)
- [ ] SIGTERM destroys Puppeteer
- [ ] Autostart + healthcheck include WA liveness
- [ ] Ingest: caption, LID, message id dedup, disk buffer if Mongo down
- [ ] Queue between event and `getChat`/DB/Telegram
- [ ] Raw messages collection + indexes; matcher becomes a worker
- [ ] Single job store + Telegram notify from live path
- [ ] Upgrade/pin `whatsapp-web.js` + `webVersion` **or** migrate to Baileys
- [ ] Tests on the real event name; add reconnect and media cases to `npm test`

### What not to do

- Do not add LLM calls inside the WhatsApp listener.
- Do not run `whatsapp:connect --keep-alive` beside the HTTP server against the same `.wwebjs_auth`.
- Do not treat `/api/health.ok: true` as proof WhatsApp is ingesting.
- Do not “fix reliability” only by raising Docker RAM without reconnect + queue + raw persist.

---

## Appendix A — Answers to scoped questions

### 1. Library & protocol

| Question | Answer |
|----------|--------|
| Mechanism | **`whatsapp-web.js` + Puppeteer** (WhatsApp Web). Not Baileys, not Cloud API, not Playwright for WA (Playwright is ATS forms + the Docker Chrome binary). Export `.txt` is a batch fallback (`whatsapp-job-scanner.js`). |
| Browser footprint | Yes. Headless Chromium, `--no-sandbox`, `--disable-dev-shm-usage`. Same container as the API. No Chrome RSS monitor. Zombies likely on SIGTERM without `destroy()`. `site-per-process` disabled. |
| Protocol health | **Not on latest patch.** `^1.31.0` vs **1.34.7**. No version pin of WhatsApp Web HTML. Playwright Chromium is a known `ready`-hang vector vs bundled Chrome. |

### 2. Session & lifecycle

| Question | Answer |
|----------|--------|
| Auth storage | `LocalAuth` directory `.wwebjs_auth` (env `WHATSAPP_AUTH_PATH`). Docker volume `wwebjs_auth`. Chromium IndexedDB; corruptible on crash. |
| Reconnect | **Does not distinguish** transient vs `LoggedOut`. **No backoff.** Disconnect is a state flag. |
| Supervision | Docker/Coolify `restart: unless-stopped` on the **whole** voice-agent. No WA-aware healthcheck. Unhandled Chrome errors may or may not kill Node. |

### 3. Ingest pipeline

| Question | Answer |
|----------|--------|
| Event | HTTP path: **`message_create`**. MCP watcher: **`message`**. Tests emit **`message`**. |
| fromMe / types | HTTP includes outgoing group messages; MCP does not. Media skipped. No extended/ephemeral/reaction parser. |
| Dedup | Job **text fingerprint**, not `msg.key.id`. |
| Backpressure | **None.** Async DB (and MCP Telegram) in the callback. |

### 4. Storage

| Question | Answer |
|----------|--------|
| Database | **MongoDB** `Job` + `TrackedGroup` for live ingest; **JSON file** `data/jobs-db.json` for MCP/export pipeline. `Message` is unrelated (voice/telegram/web). |
| Indexes | Jobs: `jobId`, `status`, `fingerprint`, `groupId`. **No** `remoteJid` / `messageId` / WA timestamp indexes because messages are not stored. |
| SQLite WAL | **Not applicable.** JSON uses `writeFileSync`. Mongo has no WAL pragma; use unique indexes + upsert instead. |

### Appendix B — Key files

| Path | Role |
|------|------|
| `server/whatsapp/session.js` | Shared Client, LocalAuth, QR, **no reconnect** |
| `server/whatsapp/puppeteer-opts.js` | Chrome flags / executable |
| `server/whatsapp/http.js` | `/api/whatsapp/*`, optional autostart |
| `server/jobs-engine/ingest.js` | Live `message_create` → matcher → Mongo |
| `server/jobs/whatsapp-live.js` | Alternate watcher (`message` event) |
| `server/jobs/job-matcher.js` | Keyword / role filter |
| `server/jobs-engine/job-store.js` | Mongo job upsert |
| `server/jobs/job-db.js` | JSON job DB |
| `server/jobs/pipeline.js` | Telegram enqueue + Playwright submit |
| `server/models/Job.js` | Job schema |
| `server/models/Message.js` | Non-WA chat logs |
| `Dockerfile.app` / `docker-compose.yaml` | Chrome binary, volume, restart policy |
