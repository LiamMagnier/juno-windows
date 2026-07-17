# Releasing Juno for Windows

## What CI produces today

`.github/workflows/windows.yml` runs on every push/PR on a Windows runner: frontend typecheck + vitest, `cargo fmt --check` + clippy (`-D warnings`) + tests, then `tauri build`, and uploads the **unsigned NSIS installer** (`Juno_<version>_x64-setup.exe`) as the `juno-windows-installer` artifact.

## Secrets required for signed, updatable releases

None of these live in the repository. Add them as GitHub Actions secrets when release infrastructure is ready:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signing key (generate with `npm run tauri signer generate`; commit ONLY the public key into `tauri.conf.json > plugins.updater.pubkey`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the key above |
| `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` | Authenticode code-signing certificate (base64 PFX) + password — or, preferably, an Azure Trusted Signing / HSM setup via `signCommand` |

Code signing matters doubly on Windows: unsigned installers trip SmartScreen, and the NSIS uninstaller runs with the same trust as the installer.

## Update channel

The Mac app updates from `https://chat.liams.dev/downloads/latest.json`. Windows needs its own manifest. The intended setup:

1. Set `plugins.updater.active: true` and the real `pubkey` in `src-tauri/tauri.conf.json`; set `createUpdaterArtifacts: true` in the bundle section.
2. Publish `latest.json` (Tauri updater schema: `version`, `pub_date`, `platforms."windows-x86_64".{signature,url}`) next to the installer — either as a GitHub release asset (current endpoint default) or at `https://chat.liams.dev/downloads/windows/latest.json` to match the macOS channel; update `plugins.updater.endpoints` accordingly.
3. The app checks for updates from Settings (plugin `updater` + `process` relaunch are already wired in the capability file).

## Version bumps

Keep `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` versions in lockstep. Tag `vX.Y.Z`.

## Architectures

x64 first (`windows-latest` runner). ARM64 requires the `aarch64-pc-windows-msvc` Rust target plus a verified CI toolchain (`npm run tauri build -- --target aarch64-pc-windows-msvc`) and its own updater platform entry — add only after genuinely testing on ARM64 hardware.
