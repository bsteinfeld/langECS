// Model contracts (R43). Types only — the engine never uses them; adapters
// (@langecs/ai-sdk, @langecs/langchain) and the stdlib build on these.

export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
  name?: string;
  /**
   * Reasoning / "thinking" text a model emitted alongside its answer
   * (o1/o3, Claude extended thinking, DeepSeek-R1, …). Output-only and
   * observation-oriented: adapters populate it from the provider's reasoning
   * blocks, but it is never sent back to the model (`content` is the durable
   * answer). Plain JSON like the rest of `Msg`, so it survives snapshots — drop
   * it before persisting if the reasoning is sensitive.
   */
  thinking?: string;
  meta?: Record<string, unknown>;
};

export type ToolSpec = {
  name: string;
  description?: string;
  /** JSON Schema. */
  parameters?: Record<string, unknown>;
};

export interface ModelRequest {
  messages: Msg[];
  system?: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Nucleus sampling (0–1). Set this or `temperature`, not both. */
  topP?: number;
  /** Top-K sampling: only consider the K most likely tokens. */
  topK?: number;
  /** Penalize tokens by their existing frequency. Provider ranges vary. */
  frequencyPenalty?: number;
  /** Penalize tokens that have appeared at all. Provider ranges vary. */
  presencePenalty?: number;
  /**
   * Sampling seed. With a fixed seed (and temperature) supporting providers
   * return near-deterministic output — useful for reproducible runs and tests.
   */
  seed?: number;
  /** Stop generation when any of these strings is produced. */
  stopSequences?: string[];
}

export interface ModelResult {
  message: Msg;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
  raw?: unknown;
}

export interface Model {
  generate(req: ModelRequest): Promise<ModelResult>;
  stream?(req: ModelRequest, onChunk: (d: { text?: string }) => void): Promise<ModelResult>;
}

/**
 * Deterministic `Model` for tests (R44): returns the scripted turns in order,
 * supports `stream` by chunking content, throws if called more times than scripted.
 */
export function scriptedModel(turns: (Msg | ((req: ModelRequest) => Msg))[]): Model {
  let index = 0;
  const next = (req: ModelRequest): Msg => {
    const turn = turns[index];
    if (turn === undefined) {
      throw new Error(
        `scriptedModel exhausted: ${turns.length} turn(s) scripted, call ${index + 1} requested.`,
      );
    }
    index += 1;
    return typeof turn === 'function' ? turn(req) : turn;
  };
  return {
    async generate(req) {
      return { message: next(req), finishReason: 'stop' };
    },
    async stream(req, onChunk) {
      const message = next(req);
      const text = message.content;
      const chunkSize = Math.max(1, Math.ceil(text.length / 4));
      for (let at = 0; at < text.length; at += chunkSize) {
        onChunk({ text: text.slice(at, at + chunkSize) });
      }
      return { message, finishReason: 'stop' };
    },
  };
}
