# Juno for Windows

Juno for Windows is the native desktop client for your Juno account — the same account, conversations, projects, memory, connectors, and scheduled tasks as the [web app](../juno) and the [macOS/iOS app](../juno-app), in a Tauri 2 shell designed specifically for Windows.

It is a real client of the Juno backend: the server holds every AI-provider key and streams model output back. The app never asks a normal user for an OpenAI/Anthropic/Google key, and never stores one.

## Stack

- **Tauri 2** (WebView2 on Windows) with a deliberately small privileged Rust surface
- **React 19 + TypeScript (strict)** built with Vite
- **Rust services** for Code mode: workspace grants, file access, search, diffs, ConPTY command streaming, and Git
- **Windows Credential Manager** for device secrets (refresh token, workspace grants)
- **GitHub Actions** (Windows runner) for typecheck, tests, lint, build, and the NSIS installer artifact

## Development

Requirements: Node 22+, Rust stable (1.82+). On Windows: WebView2 runtime (preinstalled on Win 11).

```bash
npm install
npm run tauri dev      # full app (Vite + Rust)
npm run dev            # frontend only
npm run typecheck && npm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets && cargo test
```

By default the app talks to the production Juno backend; Settings → Backend switches to a local `npm run dev` instance of [`../juno`](../juno) (http://localhost:3000).

Development also runs on macOS (Tauri is cross-platform), but Windows behavior — installer, deep links, Credential Manager, ConPTY, Mica — is only considered verified when exercised on Windows.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture: the native v1 auth/device contract (PKCE + `juno://auth/callback`), the cursor-based change sync engine, the chat SSE transport, Code mode's permission engine, and the Tauri capability model.

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md). Signing credentials are never committed; CI builds an unsigned installer until the documented secrets are configured.
