import type { InboundMsg } from "./types.js";

/** A language we have canned strings for. */
export type AckLanguage = "he" | "en";
/** What the user configures: a fixed language, or match whatever they wrote in. */
export type AckLanguageSetting = AckLanguage | "auto";

/** Acknowledgment notes ("got it, on it…") posted the moment a remote message lands. */
export interface AckConfig {
  enabled: boolean;
  language: AckLanguageSetting;
  /**
   * Channels that get acks. Defaults to the bot-identity ones: on GitHub the agent posts as the
   * user, so an ack would read as you replying to yourself.
   */
  adapters: string[];
  /** Echo a snippet of the transcript in the follow-up ack for voice notes. */
  echoTranscript: boolean;
  maxTranscriptChars: number;
}

export const ACK_DEFAULTS: AckConfig = {
  enabled: false,
  language: "auto",
  adapters: ["discord", "telegram"],
  echoTranscript: true,
  maxTranscriptChars: 200,
};

interface AckStrings {
  text: string;
  image: string;
  voice: string;
  voiceNoStt: string;
  media: string;
  transcript: string;
  transcriptPlain: string;
  stopped: string;
}

const STRINGS: Record<AckLanguage, AckStrings> = {
  en: {
    text: "Got it, on it…",
    image: "Got the image, taking a look…",
    voice: "Got your voice message, transcribing…",
    voiceNoStt: "Got your voice message — transcription is off, so I can't read it.",
    media: "Got the file, taking a look…",
    transcript: "Got your request: “{text}”",
    transcriptPlain: "Got your request, on it…",
    stopped: "Remote chat session stopped.",
  },
  he: {
    text: "קיבלתי, בודק…",
    image: "קיבלתי את התמונה, בודק…",
    voice: "קיבלתי הודעה קולית, מתמלל…",
    voiceNoStt: "קיבלתי הודעה קולית — התמלול כבוי, אז אני לא יכול לקרוא אותה.",
    media: "קיבלתי את הקובץ, בודק…",
    transcript: "קיבלתי את הבקשה: «{text}»",
    transcriptPlain: "קיבלתי את הבקשה, מטפל…",
    stopped: "השיחה המרוחקת נעצרה.",
  },
};

/** True when acks are on for this channel. */
export function ackEnabledFor(cfg: AckConfig | undefined, adapter: string): cfg is AckConfig {
  if (!cfg?.enabled) return false;
  return (cfg.adapters ?? ACK_DEFAULTS.adapters).includes(adapter);
}

// Hebrew is the only script worth testing for: with just he/en strings, "not Hebrew" means English.
const HEBREW = /[\u0590-\u05FF]/;
const LETTER = /\p{L}/u;

/**
 * Which language to answer a piece of user text in, or null when there's nothing to go on —
 * an emoji-only or numeric message carries no signal, so the caller falls back to the session's
 * last known language rather than guessing.
 */
export function detectLanguage(text: string | undefined | null): AckLanguage | null {
  if (!text) return null;
  if (HEBREW.test(text)) return "he";
  return LETTER.test(text) ? "en" : null;
}

/** Normalize a transcriber-reported language, which may be a code ("he") or a name ("hebrew"). */
export function normalizeLanguage(code: string | undefined | null): AckLanguage | null {
  if (!code?.trim()) return null;
  return /^he/i.test(code.trim()) ? "he" : "en";
}

/**
 * Settle on the language for one ack: an explicit config wins, otherwise the signal from this
 * message, otherwise whatever the user last wrote in this session, otherwise English.
 */
export function resolveLanguage(
  cfg: AckConfig,
  detected?: AckLanguage | null,
  sticky?: AckLanguage | null
): AckLanguage {
  if (cfg.language === "he" || cfg.language === "en") return cfg.language;
  return detected ?? sticky ?? "en";
}

/**
 * Language for the goodbye note. Unlike a normal message, the trigger here is a command token:
 * Hebrew speakers type "stop" in English constantly, so it's a poor language signal and the
 * session's own language outranks it. A literal "עצור" still decides when there's no history.
 */
export function resolveStopLanguage(
  cfg: AckConfig,
  sticky?: AckLanguage | null,
  detected?: AckLanguage | null
): AckLanguage {
  return resolveLanguage(cfg, sticky ?? detected);
}

function strings(lang: AckLanguage): AckStrings {
  return STRINGS[lang] ?? STRINGS.en;
}

/** Collapse a transcript to one short line so the echo stays readable in chat. */
export function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (max <= 0 || one.length <= max) return one;
  return one.slice(0, max - 1).trimEnd() + "…";
}

/**
 * The immediate "got it" for a freshly arrived message, or null when it shouldn't be acked.
 * Daemon-injected messages (STT transcripts) are skipped: they get their own note from
 * `ackForTranscript`, so a single voice note never produces three replies.
 */
export function ackForMessage(
  msg: InboundMsg,
  sttEnabled: boolean,
  cfg: AckConfig,
  lang: AckLanguage
): string | null {
  if (msg.synthetic) return null;
  const s = strings(lang);
  const kinds = new Set((msg.attachments ?? []).map((a) => a.kind));
  if (kinds.has("audio")) return sttEnabled ? s.voice : s.voiceNoStt;
  if (kinds.has("image")) return s.image;
  if (kinds.has("video") || kinds.has("file")) return s.media;
  return s.text;
}

/** The follow-up ack for a voice note, once the transcript is in. */
export function ackForTranscript(transcript: string, cfg: AckConfig, lang: AckLanguage): string {
  const s = strings(lang);
  const t = truncate(transcript, cfg.maxTranscriptChars ?? ACK_DEFAULTS.maxTranscriptChars);
  if (!cfg.echoTranscript || !t) return s.transcriptPlain;
  return s.transcript.replace("{text}", t);
}

export function ackForStop(lang: AckLanguage): string {
  return strings(lang).stopped;
}
