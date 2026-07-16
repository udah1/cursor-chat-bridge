import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveSecret } from "./config.js";

/** Result of transcribing one audio file. */
export interface SttResult {
  text: string;
  /** Detected (or forced) language code, when the provider reports it. */
  language?: string;
  durationSec?: number;
}

export interface SttOptions {
  /** "auto" (or empty) lets the provider detect; otherwise a language code like "he"/"en". */
  language?: string;
  model?: string;
}

export interface SttProvider {
  readonly name: string;
  /** Transcribe the audio file at `filePath`. Should reject on failure (caller sanitizes errors). */
  transcribe(filePath: string, opts: SttOptions): Promise<SttResult>;
}

/** Speech-to-text configuration (part of BridgeConfig). */
export interface SttConfig {
  enabled: boolean;
  provider: "openai" | "local";
  model: string;
  language: string;
  apiKey?: string;
  apiKeyCommand?: string;
  baseUrl: string;
  localBin: string;
  localArgs: string[];
  maxBytes: number;
  timeoutMs: number;
  keepAudio: boolean;
}

export const STT_DEFAULTS: SttConfig = {
  enabled: false,
  provider: "openai",
  model: "whisper-1",
  language: "auto",
  apiKey: "",
  apiKeyCommand: "",
  baseUrl: "https://api.openai.com/v1",
  localBin: "whisper",
  localArgs: ["{file}", "--model", "base", "--output_format", "txt", "--language", "auto"],
  maxBytes: 25 * 1024 * 1024, // OpenAI Whisper hard limit
  timeoutMs: 60_000,
  keepAudio: true,
};

/** Trim provider errors/stderr so secrets or huge bodies never leak into a chat note. */
export function sanitizeSttError(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e);
  msg = msg.replace(/\s+/g, " ").trim();
  // Redact anything that looks like a bearer token / API key.
  msg = msg.replace(/\b(sk|gsk|Bearer)[-_A-Za-z0-9]{6,}\b/g, "[redacted]");
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

/** Wrap a promise with a hard timeout so a stuck provider can never block indefinitely. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "stt"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** OpenAI-compatible transcription endpoint (also works for Groq via `baseUrl`). */
class OpenAiSttProvider implements SttProvider {
  readonly name = "openai";
  constructor(private apiKey: string, private baseUrl: string) {}

  async transcribe(filePath: string, opts: SttOptions): Promise<SttResult> {
    if (!this.apiKey) throw new Error("openai stt: no API key configured");
    const bytes = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([bytes]), path.basename(filePath));
    form.append("model", opts.model || "whisper-1");
    form.append("response_format", "verbose_json");
    if (opts.language && opts.language !== "auto") form.append("language", opts.language);
    const r = await fetch(`${this.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`openai stt HTTP ${r.status}: ${detail.slice(0, 200)}`);
    }
    const j = (await r.json()) as { text?: string; language?: string; duration?: number };
    return { text: j.text ?? "", language: j.language, durationSec: j.duration };
  }
}

/** Local CLI transcriber (whisper.cpp / openai-whisper / any command that prints text to stdout). */
class LocalSttProvider implements SttProvider {
  readonly name = "local";
  constructor(private bin: string, private args: string[]) {}

  async transcribe(filePath: string, _opts: SttOptions): Promise<SttResult> {
    const args = this.args.map((a) => a.replace("{file}", filePath));
    const text = await new Promise<string>((resolve, reject) => {
      // execFile (no shell) avoids injection from config values.
      execFile(this.bin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return reject(new Error(`local stt: binary '${this.bin}' not found`));
          return reject(new Error(`local stt: ${String(stderr || err.message).slice(0, 200)}`));
        }
        resolve(String(stdout));
      });
    });
    return { text: text.trim() };
  }
}

/**
 * Build the configured STT provider, or null when STT is disabled / not usable. Resolves the API key
 * once here (never re-run per request) so secrets don't leak into hot paths.
 */
export function createSttProvider(stt: SttConfig | undefined): SttProvider | null {
  if (!stt || !stt.enabled) return null;
  if (stt.provider === "local") {
    return new LocalSttProvider(stt.localBin || "whisper", stt.localArgs ?? STT_DEFAULTS.localArgs);
  }
  // default: openai-compatible
  const key = resolveSecret(stt.apiKey, stt.apiKeyCommand);
  if (!key) return null; // configured but no key -> treat as unusable (caller notes it)
  return new OpenAiSttProvider(key, stt.baseUrl || STT_DEFAULTS.baseUrl);
}
