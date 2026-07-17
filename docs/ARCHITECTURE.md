# Juno for Windows — architecture

A native Windows desktop client of the Juno account and backend, built with Tauri 2, React 19, and strict TypeScript, with a deliberately small privileged Rust surface. It shares the account, conversations, projects, memory, connectors, and scheduled tasks with the web app (`../juno`) and the Apple app (`../juno-app`).

Machine-readable contracts extracted from the backend source live in [contract-maps.json](contract-maps.json); the canonical native contract is `juno/contracts/openapi/juno-native-v1.yaml`.

## The one constraint that shapes everything

The backend middleware (`juno/src/middleware.ts`) **rejects every mutating `/api/*` request whose `Origin` header doesn't match the site**, and serves no CORS headers. Requests *without* an Origin header pass — that is the intended native-client path. A WebView always sends an Origin, so:

> **All backend HTTP and the voice WebSocket leave from the Rust process.** The webview never calls `fetch()` against the backend.

This also produces a stronger security posture for free: the token lifecycle lives in Rust, and the webview never holds a credential.

## Process layout

```
┌───────────────────────────── WebView2 (React, TS strict) ─────────────────────────────┐
│ features/ chat · sidebar · projects · settings · memory · connectors · tasks ·        │
│           code (cockpit + inspector) · voice (panel)                                  │
│ state/    authStore · dataStore · threadStore · uiStore · codeStore · voiceStore      │
│ lib/      backend/ (api(), apiStream(), auth glue) · data/ (db, syncEngine,           │
│           mutationQueue, uploads) · chat/chatEngine · code/ (agent port) · voice/     │
└────────────────────────────────────┬ invoke / Channel ┬───────────────────────────────┘
                                     │                  │ events (deep-link, auth-revoked)
┌────────────────────────────────────┴──────────────────┴───────────────────────────────┐
│ Rust (src-tauri)                                                                      │
│ net/    auth (PKCE exchange, single-flight refresh rotation, vault storage)           │
│         commands (api_request) · stream (api_stream + cancel) · upload (multipart)    │
│         voice (relay WebSocket, PCM16 frames over IPC as base64)                      │
│ code/   workspace (grants + permission modes, config-dir persistence)                 │
│         fs (bounded read/write/list) · search (ripgrep engine) · checkpoints          │
│         terminal (ConPTY via portable-pty, streamed, killable) · git (CLI porcelain)  │
│ secrets/ OS vault (Windows Credential Manager) behind a closed key allowlist          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## Authentication (native v1 device contract)

- `beginSignIn()` generates `state`/`nonce`/PKCE verifier (43+ char base64url, S256) and opens the system browser at `<backend>/app-auth?...` with `redirect_uri=com.liammagnier.juno://auth/callback` and a stable per-install `installation_id`.
- The handoff page deep-links back `?code&state&nonce`. The client validates `state`+`nonce` itself (the server deliberately doesn't at exchange), then Rust exchanges the 2-minute single-use code at `POST /api/v1/auth/token` (PKCE + installation binding).
- Result: a **10-minute HS256 access token** (memory only, Rust) + a **30-day rotating refresh token** (Windows Credential Manager only). Refresh is single-flight behind a tokio mutex and the rotated token is persisted *before* first use — refresh-token reuse revokes the whole device session server-side (`token_reuse_detected`), so a crash or a concurrent double-refresh must be impossible by construction.
- Every `/api/*` route accepts the bearer (`getCurrentUser` checks `Authorization` first), so the entire legacy REST surface works without cookies. On permanent refresh failure Rust emits `juno://auth-revoked`; the UI signs out and purges local data.
- Deep links: `com.liammagnier.juno` (primary) and legacy `juno` schemes; single-instance forwards second-launch URLs to the running window.

## Synchronization (v1 change feed)

`lib/data/syncEngine.ts` implements the cursor protocol:

1. `GET /api/v1/bootstrap` → profile, subscription, usage, settings, `currentChangeCursor`, model-manifest version.
2. Full list fetch (conversations, folders, projects, memory, prompts) + `GET /api/v1/models` (ETag-cached manifest).
3. Poll `GET /api/v1/changes?after=<cursor>&limit=500` (20s interval + window focus + after local writes; the `changes/stream` SSE endpoint is a poll-shaped probe today, not a push channel). Change envelopes carry no bodies — entity types map to paired REST refetches, deduped per pull (one thread fetch covers many message changes).
4. Cursors are strings end-to-end (they exceed 2^53 by design). `compactionFloorCursor` handling is implemented (full resync when the cursor falls below the floor) even though the server hardcodes "0" today.

Writes go through `lib/data/mutationQueue.ts` → `POST /api/v1/mutations`: optimistic store update first, then a queued mutation with a `clientMutationId` and the **exact serialized body persisted** (the server's idempotency hash covers the raw bytes, so retries must be byte-identical). 409 `revision_conflict` → rebase onto `details.currentRevision` with a new id; retryable 500 → same body; local ids from `*.create` are adopted via `entityMappings`. The queue lives in IndexedDB and survives restarts; folders and a few fields not covered by v1 mutations use legacy REST with the same optimistic pattern.

Local persistence is IndexedDB (`lib/data/db.ts`): lists, cursor, bootstrap snapshot, pending mutations, code-session transcripts. Sign-out wipes every store.

## Chat

`lib/chat/chatEngine.ts` implements the full `POST /api/chat` SSE client contract (see contract map [7]): optimistic user+assistant rows, `meta` id adoption, `delta`/`reasoning` (with part boundaries)/`activity`/`sources` folding, `done`/`error` terminals with quota application, server pings every 15s tolerated. Cancellation is `POST /api/chat/cancel` with a client-minted `generationId` plus a 5-second local-abort fallback; generation is detached server-side, so a dropped stream enters **recovery**: poll the thread up to ~1 hour for the answer the server kept writing (regenerate-aware via the id→createdAt removed-row map). Regenerate posts `regenerate:true` (the server overwrites the assistant row in place and versions the old one); edit-and-resend is `PATCH /api/messages/{id}` + regenerate. Auto-titles are client-driven phase posts to `/conversations/{id}/title`. Private mode keeps history local (`privateHistory`), persists nothing, and disables connectors/canvas.

## Code mode

Two halves:

**Local (this device).** The permission engine and agent loop are a TypeScript port of `juno-app/core` (`lib/code/`), with tools implemented over the Rust services. The Rust layer is the hard boundary: every command resolves paths inside a canonicalized workspace grant (traversal- and symlink-checked, drive roots and the home directory refused), read-only grants refuse writes and command execution outright, and the webview only ever holds opaque workspace ids. On top of that the TS engine enforces the interaction contract: `readOnly` (read tools only), `ask` (default; edits and commands confirm), `workspaceWrite` (edits apply; network/install commands still confirm), `full` (explicit opt-in; **sensitive actions — recursive deletes, history rewrites, registry/system changes, credential access — always confirm in every mode**). Model turns stream through the transparent provider proxy `POST /api/agent/<provider>/…` (Anthropic wire for `anthropic`, OpenAI `chat/completions` for every other provider) with usage accounted per turn via `/api/agent/usage` (reserve → record/refund, fail-open except HTTP 402). Checkpoints snapshot files before mutation for per-turn undo. **Stop** aborts the model stream, kills the session's ConPTY processes, and denies pending approvals in one call.

Sessions are visible cross-device as synced conversations (`kind:"code"` + workspace name/path via legacy REST); transcripts stay device-local (IndexedDB), matching the platform rule that raw paths and permissions never sync. Workspace *metadata* union-merges into `PUT /api/code/workspaces` (GET-then-PUT, because the endpoint is mirror-sync and a naive PUT would clobber other devices' entries).

**Remote (device queue).** The dumb-relay task protocol (`/api/code/devices|queue|tasks…`) lets clients watch and drive tasks on other hosts. The backend originally accepted only `platform:"macos"` for host registration; this repo's work widens that enum to include `"windows"` (change staged in `../juno`).

The Code sidebar shows only real capabilities: new session, the honest GitHub-connection-aware pull-requests page (the backend has no PR-list API yet — the web app ships the same placeholder), scheduled tasks, connectors, projects with nested sessions, unassigned sessions, granted workspaces. There is deliberately no "deployments" page: no backend surface exists for it.

## Voice

The realtime relay (juno `relay/`, protocol in contract map [6] / BACKEND_API.md §11): `GET /api/voice/relay-token` mints a 60-second token; Rust opens `wss://relay/?token=…` (no Origin header — the relay rejects foreign Origins); binary frames are PCM16 mono (16 kHz mic up, 24 kHz speech down), text frames the JSON control protocol (`session.start/ready`, partial+final `transcript`, `turn`, `interrupted`, `usage`, `session.closed`). The webview captures the mic with an AudioWorklet, downsamples to 16 kHz, and ships frames over IPC; playback queues 24 kHz buffers with barge-in flush. Finalized turns persist idempotently through `POST /api/voice/transcript` into the same conversation model other clients read. The UI is a compact panel above the composer (never a takeover) with a real-amplitude orb and the full state machine (listening/thinking/speaking/muted/reconnecting/ended/error).

## Design system

Adapted from the shared Juno language (graphite dark / warm paper light, one terracotta accent, quiet motion) to Windows idioms: Segoe UI Variable working type (serif reserved for greetings), a 4px grid, restrained radii, Fluent-style hover/pressed fills, custom titlebar with Fluent caption buttons (red close hover), CSS-acrylic popovers, `forced-colors` (high contrast) and `prefers-reduced-motion` support, thin overlay scrollbars, visible keyboard focus everywhere, F6 region cycling, and Ctrl-based shortcuts (Ctrl+1/2 modes, Ctrl+N new chat, Ctrl+K search, Ctrl+B sidebar, Ctrl+, settings). Tokens live in `src/design/tokens.css`; concrete values come from the web `globals.css` and the Mac app's `Theme.swift` (graphite levels, accent set).

## Security posture

- No provider keys anywhere in the client; all model traffic is server-proxied and budget-gated.
- Refresh token: Credential Manager only, never in the webview process. Access token: Rust memory.
- Webview capability file grants no fs/shell/http plugin access — the privileged surface is the explicit `juno:*` command set (`src-tauri/src/lib.rs`), each validating its inputs (URL scheme/host allowlists, path containment, closed vault-key allowlist, session-scoped PTY registry).
- Strict CSP; artifacts render in sandboxed iframes; markdown is DOMPurify-sanitized; external links open via the opener plugin's URL allowlist.
- Logs never carry tokens (reqwest errors are stripped of URLs; command errors are short, human-readable strings).

## Known gaps / deliberate deferrals

- `minimumClientVersions` has no `windows` key yet — treated as unenforced; read defensively.
- The v1 change feed is fresh (migration dated 2026-07-16); the Mac app still full-list-polls. If production lacks the triggers, `fullSync()` still keeps the client correct — the feed is an optimization.
- Voice availability is discovered by probing (`relay-token` 503 / tts 501); `featureFlags` in bootstrap is empty today.
- Updater endpoint + signing are documented in [RELEASING.md](RELEASING.md) and disabled until release credentials exist.
