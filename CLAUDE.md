# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsLark is a WhatsApp↔Feishu (飞书) bidirectional message bridge. Each WhatsApp group maps to a dedicated Feishu group; all private chats aggregate into a single Feishu topic group (one thread per contact). Feishu replies are sent back to WhatsApp **as your own WA account**. The service runs as a single Node.js process (Node >= 20) using SQLite for all persistence. There is **no web UI** — configuration is driven by watched files plus a shell CLI.

## Commands

```bash
npm run dev        # tsx watch src/index.ts (hot-reload development)
npm run build      # tsc -p tsconfig.json (compile to dist/)
npm start          # node dist/index.js (production)
npm run typecheck  # tsc -p tsconfig.json --noEmit (type checking only)
```

No test or lint command is configured. Test files (`test/`, `tsconfig.test.json`) are git-ignored and not part of the repo.

## Architecture

### Module Dependency Flow (bottom-up)

```
config.ts → logger.ts → db.ts → whatsapp/ → feishu/ → bridge/ → app.ts → monitor.ts → index.ts
```

- **`config.ts`** — Frozen runtime config from env vars only (DB path, `dataDir`, log level, throttle intervals, feature flags). Feishu *business* config (app_id/secret/open_ids) is NOT here — it lives in SQLite `APP_CONFIG`.
- **`logger.ts`** — Pino logger with module children accessed via `log.<child>`: `root`, `wa`, `feishu`, `bridge`, `db`.
- **`db.ts`** — Singleton SQLite layer (WAL mode, synchronous `better-sqlite3`). Call `initDb(path)` once at startup, then `getDb()` everywhere. 5 tables: `GROUP_MAPPING`, `PRIVATE_THREAD_MAPPING`, `MESSAGE_DEDUP`, `WA_AUTH_STATE`, `APP_CONFIG`.
- **`whatsapp/socket.ts`** — `WhatsAppManager` wraps `@whiskeysockets/baileys`. Custom SQLite authState (`whatsapp/auth-sqlite.ts`) instead of file-based `useMultiFileAuthState`. Event-driven (`messages.upsert`, `connection.update`, `creds.update`, `groups.update`). QR is printed to the terminal/container log. node-cache for group metadata to avoid rate limits.
- **`feishu/client.ts`** — `FeishuClient` wraps the Lark SDK REST calls (create groups, create topic group, send text/topic reply, upload media, rename).
- **`feishu/ws.ts`** — `FeishuWsManager` wraps the Lark WSClient long connection for event subscription (`im.message.receive_v1`).
- **`bridge/router.ts`** — `BridgeRouter` is the core sync orchestrator (WA→Feishu and Feishu→WA routing, lazy group/thread creation, media uploads). Uses `KeyedMutex` (`bridge/mutex.ts`) for per-key serialization to prevent duplicate group/thread creation.
- **`app.ts`** — `App` coordinator. Wires modules, hot-reloads Feishu config via `applyFeishuConfig()` (skips reconnect when credentials are unchanged to avoid WS churn), auto-connects WA when a stored session exists, runs periodic dedup cleanup, exposes `status()`/`mappings()`/`loginWa()`/`logoutWa()`.
- **`monitor.ts`** — Replaces the old web server. Watches `<dataDir>/config.json` (debounced hot-reload of Feishu config), processes one-shot command files in `<dataDir>/cmd/` (`wa-login`, `wa-logout` — consumed then deleted), and writes service state to `<dataDir>/status.json` (only when changed).
- **`index.ts`** — Entry point: `initDb` → `new App` → `app.start()` → `startMonitor(app)`, plus signal/exception handlers.
- **`bin/whatslark.sh`** — POSIX-sh CLI invoked inside the container via `docker exec whatslark whatslark <cmd>`. Commands: `status`, `feishu-config`, `feishu-set <id> <secret> [open_id]`, `wa-login`, `wa-logout`, `mappings`, `help`. It manipulates the watched files (writes `config.json`, touches `cmd/wa-login`, reads `status.json`, queries the DB with `sqlite3`) — it does not talk to the process directly.

### Configuration Flow (no web UI)

`config.json` is the source of truth a human edits (directly or via `whatslark feishu-set`). `monitor.ts` watches it, parses `{ app_id, app_secret, my_open_id, bot_open_id }`, and calls `App.applyFeishuConfig()`, which persists into SQLite `APP_CONFIG` and (re)assembles the Feishu side. On startup `App.start()` reads existing `APP_CONFIG` from SQLite. `<dataDir>` defaults to the DB directory; override with `DATA_DIR`.

### Data Flow

- **WA → Feishu**: `messages.upsert` → normalize → `BridgeRouter.onWaMessage()` → dedup check → ensure group/thread (lazy create with mutex) → upload media → send.
- **Feishu → WA**: `im.message.receive_v1` → `FeishuWsManager` → `BridgeRouter.onFeishuMessage()` → dedup check → resolve mapping → send via Baileys as the user's own account.

### Anti-Loop (Critical — do not break these)

1. WA side: skip messages where `m.key.fromMe === true`.
2. Feishu side: skip events where `sender.sender_type !== 'user'`.

### Dedup / Idempotency

`MESSAGE_DEDUP` keyed by `msg_key` (prefixed `wa:<id>` or `fs:<id>`). Mark-before-process (`INSERT OR IGNORE`). Periodic cleanup every 6h by `DEDUP_RETENTION_DAYS`.

## Key Design Decisions

- **Single process only** — the Feishu WSClient long connection does not support multi-instance broadcasting.
- **SQLite for everything** — config, mappings, auth state, dedup in one file. Simplifies Docker (mount `/data`).
- **Custom SQLite authState** — replaces Baileys' `useMultiFileAuthState`, storing credentials in SQLite instead of many files.
- **File + CLI control instead of HTTP** — config/commands/status are plain files under `<dataDir>`, driven by `bin/whatslark.sh` over `docker exec`. No open port, no frontend build.
- **Lazy group/thread creation** — created on first message; `syncAllGroups()` runs on WA connect to proactively create all mapped groups with rate limiting.
- **Throttling** — env-configurable: `SEND_INTERVAL_MS` (600), `HISTORY_INTERVAL_MS` (400), `GROUP_SYNC_INTERVAL_MS` (1500).

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DB_PATH` | `./data/bridge.db` | SQLite database path |
| `DATA_DIR` | dir of `DB_PATH` | Control files dir (`config.json`, `status.json`, `cmd/`) |
| `LOG_LEVEL` | info | Pino log level |
| `SEND_INTERVAL_MS` | 600 | Message send throttle |
| `HISTORY_INTERVAL_MS` | 400 | History sync throttle |
| `GROUP_SYNC_INTERVAL_MS` | 1500 | Group creation throttle |
| `DEDUP_RETENTION_DAYS` | 7 | Dedup record TTL |
| `SYNC_ALL_GROUPS` | true | Auto-create all WA groups on login |
| `SYNC_FULL_HISTORY` | true | Sync historical messages |
| `MAX_MEDIA_BYTES` | 52428800 | Max media size (50MB); larger downgrades to a text notice |

## Deployment

Docker (multi-stage build from `node:18-slim` per `Dockerfile`; note the app itself targets Node >= 20). Mount `./data:/data` for persistent SQLite and control files. Configure and operate via `docker exec whatslark whatslark <cmd>`; scan the WA login QR from container logs (`docker compose logs -f whatslark`). CI/CD via `.gitlab-ci.yml` (Docker build+push on main, manual deploy).

## Spec Documents

`spec/solution.md` is the master architecture doc (sequence diagrams, ER diagram, implementation notes). `spec/baileys-usage.md` and `spec/feishu-usage.md` are API research references. `spec/tasks/phase-0-scaffolding.md` … `phase-6-deploy.md` are phased task breakdowns.
