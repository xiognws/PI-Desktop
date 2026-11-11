# 0387 — The voice feature is removed from the desktop app

- **Status:** Accepted
- **Date:** 2026-11-10
- **Supersedes the product surface of:** 0281 (host speech capability), 0291 (speech settings card removal), 0313–0316 (live voice session target, spoken ask answers, docked widget)

## Context

The desktop app shipped two related capabilities:

1. **Dictation / voice input** — a recorder in the renderer, an on-device
   transcription engine (`@pi-workspace/voice-runtime`, `@picovoice/pvrecorder-node`),
   model download and a `voice/*` IPC surface.
2. **Live Voice** — app-owned real-time calls (Gemini Live, OpenAI Realtime,
   Codex) with their own microphone lease, permission handling, docked widget,
   "live work" admission machinery and a `voice/live/*` IPC surface.

It also exposed a **host speech capability** to plugins
(`speech.registerAdapter`, ADR 0281) that routed ASR/TTS through
`AppSettings.speech`.

None of it is used by this product line: there is no wake word, no
"read replies aloud" entry point, and the voice settings destination is the only
place either capability could be turned on. Every release since 0291 has been
carrying the code, the native dependency, the settings surface and about a
hundred tests for something nobody opens.

## Decision

Remove the voice feature entirely, instead of hiding its UI:

- Delete the runtime: `packages/voice-runtime`, `electron/main/live-voice/**`,
  `electron/main/voice-service.ts`, `electron/main/audio-backend.ts`,
  `electron/main/services/speech-service.ts`, `packages/agent-runtime/src/speech`,
  `packages/host-runtime/src/live-work/**`.
- Delete the UI: `src/features/voice/**`, `src/features/settings/voice/**`, the
  composer microphone hook, the toolbar `LiveVoiceControls`, the
  `LiveVoiceStatusHost`, the `live-voice-widget` renderer surface, the Voice
  settings destination and its search entry, the `voiceToggle` / `voiceCancel`
  shortcuts and their i18n labels.
- Delete the contracts: every `speech/*` and `voice/**` IPC channel (invoke and
  event), `SpeechStatus` / `SpeechTranscribeRequest` / `SpeechSynthesize*` types,
  `AppSettings.speech|liveVoice|voice`, `VoiceInputSettings`, the
  `speech.registerAdapter` plugin permission and host API, and the three
  `SPEECH_*` error codes.
- Delete the dependencies: `@picovoice/pvrecorder-node`,
  `@pi-workspace/voice-runtime`, and the `transcribe-cpp` bundler external.

## What deliberately stays

- **`VoiceOrigin` (`{callId, operationId}`)** and the optional `voiceOrigin`
  field on `AgentPromptRequest`, `AgentSteerRequest`, queued-turn records and
  durable message rows. It is already persisted by host-core and part of the
  queue/admission payload shape; ripping it out would widen this change into the
  agent admission path and the Rust schema for no user-visible gain. Nothing
  produces the value any more, and older rows must keep parsing.
- **Release-note history** (`changelog-*.ts`, `decisions-log.md`, ADRs, the
  `docs/adr/**` record itself). Those describe what shipped; they are not the
  current product.
- **Microphone permission text in the security spec** where it describes what a
  *plugin panel* may request — the plugin audio API (`audio.capture.background`)
  is a separate surface and was not touched.

## Consequences

- Persisted settings objects may still carry `speech`, `liveVoice` or `voice`;
  the renderer and main process no longer read, write or validate those keys, so
  they are inert. No migration is required, and no user action is expected.
- Old build directories keep whatever they cached; a clean `pnpm install`
  regenerates the lockfile without the two removed packages
  (`pnpm-lock.yaml` is part of this change).
- `docs/spec/03-runtime/{20-speech,live-voice,live-work-session}.md` and their
  zh-CN copies are deleted, with index rows, IPC tables, plugin-API pages and
  E2E scenarios updated in the same change. The twelve Live Voice / live-work
  test files and their fixtures go with them; the two `scripts/e2e-storage-*`
  module hooks lose their `@pi-workspace/voice-runtime/live` entry.
- The `Voice` settings destination disappears from the rail and from settings
  search; `navigation` reaches it by id nowhere else.

## Alternatives considered

- **Hide the entries, keep the code** (the strategy used for the earlier
  Hermes-desktop cut). Rejected: it keeps a native dependency, a transcription
  model downloader and ~100 tests alive for a surface that no longer exists, and
  every future refactor of the composer/IPC has to step around it.
- **Keep dictation, drop Live Voice.** Rejected: dictation is the same
  `voice-runtime` dependency and the same settings destination; the product has
  no entry point for either.

## Follow-ups (not blocking)

- Dead i18n strings: `liveVoice.*` and the `voice*` keys still sit in the locale
  catalogs and their type map; they are unreferenced and can be pruned with the
  next `i18n:keys` regeneration.
- Remaining prose mentions of voice in specs outside the deleted pages
  (logging categories, UI design-system notes, release runbook) are stale text,
  not contracts.
