# Releasing Juno for Windows

## What CI produces

`.github/workflows/windows.yml` runs on every push/PR on a Windows runner:

- frontend typecheck + vitest
- `cargo fmt --check` + clippy (`-D warnings`) + tests
- `tauri build` (NSIS installer + **updater artifacts** when signing is configured)
- uploads the bundle as the `juno-windows-installer` artifact

On **tags** matching `v*` it also publishes a GitHub Release with:

| Asset | Purpose |
|---|---|
| `Juno_<version>_x64-setup.exe` | Manual install / first install |
| `*.nsis.zip` + `*.sig` | In-app auto-update payload |
| `latest.json` | Tauri updater manifest (`plugins.updater.endpoints`) |

## Auto-update (like macOS)

The app checks GitHub Releases in the background on launch (quiet — no popup).
When a newer version is ready, a **Relaunch to update** chip appears in the
sidebar footer. Settings → General also has **Check for updates**.

Endpoint: `https://github.com/LiamMagnier/juno-windows/releases/latest/download/latest.json`

## Secrets required for signed, updatable releases

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signing key (generate with `npx tauri signer generate -w ~/.tauri/juno-windows.key --ci`). Public half lives in `tauri.conf.json > plugins.updater.pubkey`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional password for the private key |
| `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` | Authenticode code-signing certificate (base64 PFX) — optional but recommended so SmartScreen stays quiet |

**If you lose the private key, auto-update breaks for every install that trusted the old pubkey** — generate a new pair and ship a manual installer once.

```bash
# One-time keypair (keep the private key out of git)
npx tauri signer generate -w ~/.tauri/juno-windows.key --ci
# Public → paste into tauri.conf.json plugins.updater.pubkey
cat ~/.tauri/juno-windows.key.pub
# Private → GitHub Actions secret
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/juno-windows.key
```

## Release checklist

1. Bump `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` in lockstep.
2. Commit to `main`, then tag and push:

```bash
git tag -a v0.2.3 -m "Juno for Windows v0.2.3"
git push origin main --tags
```

3. CI builds, signs updater artifacts, and attaches everything to the GitHub Release.
4. Users on a previous signed build get the quiet in-app update chip.

## Architectures

x64 first (`windows-latest` runner). ARM64 requires the `aarch64-pc-windows-msvc`
Rust target plus its own updater platform entry in `latest.json` — add only after
testing on ARM64 hardware.
