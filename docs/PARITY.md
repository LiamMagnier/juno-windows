# Feature parity audit — Windows vs Web/Mac

Snapshot from an automated cross-repo audit (web `juno/src/components/chat`, Mac
`juno-app/Juno/Features`, Windows `juno-windows/src`). Tracks composer/chat gaps.

## Addressed in the design pass
- **"+" add-menu** consolidating Photos / Files / **From library** / **Create a
  canvas** / **Add to project** (picker) / connectors — was: bare paperclip + read-only project chip.
- **Thinking slider** — replaced the discrete radio menu with a model-driven slider (ultra top tier).
- **Slash `/` command palette** in the composer (`/model`, `/canvas`, `/voice`, `/search`, `/research`, `/memory`, `/new`, `/projects`).
- **Deep-research** per-send toggle.
- **Canvas / artifacts** per-conversation toggle (was hardcoded on).
- **Memory** per-message toggle in the composer.
- **Model + token + cost footer** under assistant answers.
- **Read-aloud (TTS)** on assistant messages.

## Deferred (larger / riskier surfaces — follow-ups)
- Inline artifact card in the message stream (side panel only today).
- Select-to-quote from an artifact ("Modify / Ask").
- Image-edit overlay for generated images.
- Preflight clarification card + in-stream clarification wizard.
- Visual-learning / step-lab / inline-visual rich blocks.
- Model parameters panel (temperature/top-P/max-tokens) — website-only, not on Mac.
- Branch-from-here / fork-privately message actions.

## Already at parity (pre-existing)
Model selector (grouped, favorites, caps, pricing, lifecycle, plan gating), web
search, connectors (≤5), attach via picker + paste + OS drag-drop, private mode,
send⇄stop morph, quota bar, message actions (copy/edit-resend/regenerate/feedback/
continue/version pager), reasoning + activity disclosure, source chips, artifacts panel.
