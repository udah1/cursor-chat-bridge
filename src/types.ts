// Shared types for cursor-chat-bridge.

/** A reference to a per-session conversation thread inside a transport (issue, forum topic, chat). */
export interface ThreadRef {
  /** Adapter name that owns this thread. */
  adapter: string;
  /** Adapter-specific thread identifier (issue number, topic id, chat id...). */
  thread: string;
  /** Optional adapter-specific extra data. */
  meta?: Record<string, unknown>;
}

/** A single inbound message observed in a thread. */
export interface InboundMsg {
  /** Adapter-unique message id (used to dedupe and to filter the agent's own posts). */
  id: string;
  text: string;
  /** Epoch millis. */
  ts: number;
  /** Adapter-native author id, when available (used to distinguish user vs agent). */
  authorId?: string;
}

export interface PollResult {
  messages: InboundMsg[];
  /** Opaque cursor to pass to the next poll (e.g. last-seen timestamp). */
  cursor: string | null;
  /** True if the thread signalled a stop (issue closed, /stop command, etc). */
  stopped: boolean;
}

/** Router callback used by push / global-ingest adapters (e.g. Telegram getUpdates). */
export type IngestRouter = (thread: string, msg: InboundMsg) => void;

export interface AdapterCapabilities {
  /** Adapter pushes messages via a single global ingest loop instead of per-thread poll. */
  globalIngest: boolean;
  /** Adapter posts under an identity distinct from the user (so own-message filtering is unnecessary). */
  separateBotIdentity: boolean;
}

export interface TransportAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  /** Validate config / warm up clients. Throw with a clear message if unusable. */
  init(): Promise<void>;

  /** Create (or reuse) a thread for a session. */
  ensureThread(sessionId: string, title: string, meta?: Record<string, unknown>): Promise<ThreadRef>;

  /** Post a message to a thread. Returns the adapter message id (used for own-message filtering). */
  send(thread: ThreadRef, text: string): Promise<{ messageId: string }>;

  /**
   * Pull adapters only: fetch messages after `cursor`.
   * Global-ingest adapters may leave this unimplemented.
   */
  poll?(thread: ThreadRef, cursor: string | null): Promise<PollResult>;

  /**
   * Global-ingest adapters only: start a single loop that routes inbound messages
   * to sessions by thread id. Returns a stop function.
   */
  startIngest?(router: IngestRouter): Promise<() => void>;

  /** Signal end of a session (close issue, post goodbye...). Best-effort. */
  stop?(thread: ThreadRef): Promise<void>;
}

export interface AdapterFactoryCtx {
  config: Record<string, any>;
  log: (msg: string) => void;
}
