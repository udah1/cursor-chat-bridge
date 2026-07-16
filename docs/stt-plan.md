# Voice message support (STT) — design

> Status: **implemented in v1** (asynchronous transcription). This document reflects the design
> after a plan review (verdict: FIX-FIRST). The key change from the first draft is that STT is
> **decoupled from the poll path** to avoid timeouts and message loss.

## Goal

A remote user sends a **voice message** (Telegram voice note, or a Discord `audio/*` attachment).
The agent receives a **text transcription** as if the user had typed it. Language is auto-detected
(Hebrew/English at least) and surfaced. Voice **replies** (TTS) are out of scope.

## Why async (the critical fix)

The daemon's `/poll` is a long-poll bounded to ~50–55s; the MCP tool and the `stop` hook abort
around 60s. Telegram's `drainInbox()` and Discord's cursor advance **when messages are fetched** —
so running transcription *inline* on the poll path risked: (a) exceeding the window → timeouts, and
(b) **silent message loss** if the client aborted after the inbox/cursor had already advanced.

**Design:** transcription runs as a **background job** inside the daemon. The original audio message
is **not delivered inline**; instead, when the transcript is ready it is **injected as a new inbound
message** into the session inbox. The next poll iteration (same long-poll, or a re-armed one via the
`stop` hook) drains it and delivers it to the agent. No inline blocking, no lost messages.

## Pipeline

1. **Capture (adapters).** Telegram `collectTgAttachments()` emits `kind:"audio"` for `message.voice`
   (OGG/Opus) and `message.audio`, carrying the `file_id` as `ref` and `durationSec`. Discord already
   classifies `audio/*` via `attachmentKind()`. (Telegram `video_note` is **deferred** — it's video and
   needs an extra audio-extraction step.)
2. **Download (daemon).** `materializeAttachments()` saves the bytes to
   `~/.cursor/chat-bridge/media/<session>/` (as for images). For audio, it does **not** append the
   "open with the Read tool" note (the agent can't read binary audio).
3. **Transcribe (daemon, async).** If `stt.enabled`, `routeSttMessages()` **suppresses** the audio
   message from immediate delivery and starts a background job (deduped by message id). The job:
   - enforces `maxBytes` (default 25 MB) and a hard `timeoutMs` (default 60 s) via `Promise.race`;
   - calls the configured `SttProvider`;
   - **injects** a new inbound message `id = "stt-<origId>"` with text
     `<caption/image notes>\n\n[voice transcript (<lang>)]: <text>` (or a clear failure/empty/too-large note);
   - never blocks the poll and never echoes provider stderr/secrets into the note (errors sanitized).
4. **Deliver.** The injected message is drained by a later poll and reaches the agent as normal text.

## Provider abstraction (`src/stt.ts`)

```ts
interface SttResult { text: string; language?: string; durationSec?: number; }
interface SttOptions { language?: string; model?: string; }
interface SttProvider { readonly name: string; transcribe(filePath: string, opts: SttOptions): Promise<SttResult>; }
createSttProvider(cfg): SttProvider | null   // returns null when disabled/misconfigured
```

- **`openai`** — POST multipart to `…/v1/audio/transcriptions` (`whisper-1`), `response_format:
  verbose_json` to get the detected language. Accepts OGG/Opus directly. Needs an API key
  (`apiKeyCommand` resolved via `resolveSecret`, or `BRIDGE_STT_API_KEY`). Runs inside the daemon,
  which already trusts the corporate CA (`NODE_EXTRA_CA_CERTS = caCertPath`).
- **`local`** — spawn a command (default `whisper`) via `execFile` (no shell) with `{file}` substituted
  into `localArgs`; stdout is the transcript. For offline / sensitive audio (recommended on corporate
  machines). Requires the binary (and usually `ffmpeg`) installed; validated at first use.

Provider is chosen **explicitly** by `stt.provider` (no "first configured wins" guessing).

## Config (`config.example.json` / env)

```jsonc
"stt": {
  "enabled": false,
  "provider": "openai",          // "openai" | "local"
  "model": "whisper-1",
  "language": "auto",            // "auto" | "he" | "en" | ...
  "apiKey": "",                  // or apiKeyCommand / BRIDGE_STT_API_KEY
  "apiKeyCommand": "",
  "baseUrl": "https://api.openai.com/v1",
  "localBin": "whisper",
  "localArgs": ["{file}", "--model", "base", "--output_format", "txt", "--language", "auto"],
  "maxBytes": 26214400,
  "timeoutMs": 60000,
  "keepAudio": true              // set false to delete the audio file after a successful transcript
}
```

Env overrides (mirroring `applyEnvOverrides`): `BRIDGE_STT_ENABLED`, `BRIDGE_STT_PROVIDER`,
`BRIDGE_STT_MODEL`, `BRIDGE_STT_LANGUAGE`, `BRIDGE_STT_API_KEY`, `BRIDGE_STT_BASE_URL`,
`BRIDGE_STT_LOCAL_BIN`.

## Security & data handling

- **Data residency:** cloud STT sends audio off-host. When `caCertPath` is set (corporate network),
  the default flips to `provider:"local"` unless `stt.provider` is set explicitly, and a one-time
  warning is logged when cloud STT is selected.
- **Secrets:** API keys resolved once at init via `resolveSecret`; `apiKeyCommand` run with `execFile`
  (fixed args, no shell); provider errors are sanitized/truncated before appearing in any note.
- **Retention:** `keepAudio:false` deletes the audio after a successful transcript. Media dir stays
  `0700`/files `0600` (see note below). (Automatic session TTL cleanup is a follow-up.)

## Stop-keyword safety

A transcribed "stop"/"עצור" must **not** silently end the session: the injected text is
`[voice transcript …]: stop`, which never exactly matches `isStop()`. Ending a session by voice
requires the agent to confirm, or the user to type `stop`.

## Scope (v1) & deferred

- **v1:** Telegram `message.voice` + `message.audio`; Discord `audio/*` attachments; `openai` + `local`
  providers; async injection; guards; config + env wiring.
- **Deferred:** `video_note` (needs ffmpeg audio extraction); automatic ffmpeg transcode for exotic
  local models; session-TTL media cleanup; TTS (voice replies); Groq (works via `openai` `baseUrl`).

## Testing

- **Unit (pure):** audio capture in `collectTgAttachments` (voice/audio) and `attachmentKind`.
- **Unit (daemon):** a `FakeSttProvider` asserts the injected `stt-<id>` message carries the transcript,
  that a transcribed "stop" does **not** trigger `isStop`, and that failures degrade to a safe note.
- **Manual:** send a Telegram voice note + a Discord audio clip; confirm the transcript reaches the
  agent and the audio file is saved (or deleted when `keepAudio:false`).
