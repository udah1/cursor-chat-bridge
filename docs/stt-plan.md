# Voice message support (STT) — implementation plan

> Status: **PLAN ONLY — not implemented.** This document describes how speech‑to‑text (STT) would
> be added on top of the image‑attachment pipeline that already exists. Nothing here is wired up yet.

## Goal

Let a remote user send a **voice message** (Telegram voice note, Discord voice/audio attachment) and
have the agent receive a **text transcription** as if the user had typed it — optionally keeping the
original audio for reference. Language should be auto‑detected (Hebrew/English at minimum).

## What already exists (reused as‑is)

The image work added a generic attachment pipeline that STT slots straight into:

- `InboundAttachment` (`src/types.ts`) already has a `kind: "audio"` variant.
- Both adapters already **detect** audio: `attachmentKind()` (Discord) classifies `audio/*` and audio
  extensions; Telegram's `collectTgAttachments()` currently only emits images but the shape is ready.
- `TransportAdapter.fetchAttachment()` already downloads bytes for any attachment kind (Discord CDN,
  Telegram `getFile`), and the daemon's `materializeAttachments()` already saves them to
  `~/.cursor/chat-bridge/media/<session>/`.

So the audio bytes can already reach disk. STT is "what happens **after** an `audio` attachment is
saved".

## Changes required

### 1. Capture audio in the adapters
- **Telegram** (`collectTgAttachments`): also emit attachments for `message.voice` (OGG/Opus),
  `message.audio` (music), and `message.video_note`. Each exposes a `file_id` → set as `ref`, and
  `mime_type`/`duration` when present.
- **Discord**: already classified by `attachmentKind`; no change needed beyond confirming `.ogg`/
  `.m4a` voice clips are covered (they are).

### 2. STT service abstraction (`src/stt.ts`, new)
```ts
export interface SttResult { text: string; language?: string; durationSec?: number; }
export interface SttProvider { transcribe(bytes: Buffer, filename: string): Promise<SttResult>; }
```
Providers (pick per config, first configured wins):
- **OpenAI Whisper API** (`whisper-1` / `gpt-4o-transcribe`) — simplest, returns language; needs
  `OPENAI_API_KEY`.
- **Groq Whisper** — cheap/fast, OpenAI‑compatible endpoint.
- **Local `whisper.cpp` / `faster-whisper`** — offline, no data leaves the machine (best for the
  corporate/Amdocs case where audio may be sensitive). Invoked as a child process on the saved file.

### 3. Wire STT into the daemon
In `materializeAttachments()`, after an `audio` attachment is saved:
- If STT is enabled, call `sttProvider.transcribe(buf, filename)`.
- Replace/augment the message text: `m.text = m.text || transcript` and append a note
  `[voice message transcribed (he): "<transcript>"]` so the agent treats it as the user's words.
- On failure, degrade to `[voice message received but transcription failed: <err>]` + keep the file.

### 4. Config (`config.example.json` / env)
```jsonc
"stt": {
  "enabled": false,
  "provider": "openai",        // openai | groq | local
  "apiKeyCommand": "…",        // or STT_API_KEY env
  "model": "whisper-1",
  "language": "auto",          // auto-detect; or force "he"/"en"
  "localBin": "whisper"        // for provider=local
}
```
Env overrides: `BRIDGE_STT_ENABLED`, `BRIDGE_STT_PROVIDER`, `BRIDGE_STT_API_KEY`, `BRIDGE_STT_MODEL`.

## Corporate‑network considerations (Amdocs / Zscaler)
- Same lesson as images: cloud STT endpoints may be TLS‑intercepted. The daemon already runs with
  `NODE_EXTRA_CA_CERTS = caCertPath`, so an OpenAI/Groq call inherits the corporate CA and should
  work — but audio may be **sensitive**, so the **local `whisper.cpp`** provider is the recommended
  default on corporate machines (no data leaves the host).

## Language detection
- Whisper returns the detected language for free (`SttResult.language`); surface it in the note.
- For the reverse direction (TTS replies) a separate plan would be needed — out of scope here.

## Testing strategy
- Unit: audio classification in `collectTgAttachments` + `attachmentKind` (pure, no network).
- Unit: a `FakeSttProvider` to test the daemon note‑rewriting without a real model.
- Manual: send a Telegram voice note + a Discord audio clip; confirm transcript + saved file.

## Rollout
1. Land audio capture (adapters) — harmless, no behavior change without STT enabled.
2. Add `src/stt.ts` + local provider, default `enabled:false`.
3. Enable behind config; document in README.
