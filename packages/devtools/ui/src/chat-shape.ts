// Shape of a chat transcript (stdlib `Messages`-style components): pure data
// guard shared by the chat renderer and the World tab's classification —
// kept .tsx-free so node-side unit tests can import it.

export interface ChatMsg {
  role: string;
  content?: unknown;
  toolCalls?: { id?: string; name?: string; args?: unknown }[];
  toolCallId?: string;
  name?: string;
}

export function isChatTranscript(value: unknown): value is ChatMsg[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m) =>
        m !== null && typeof m === 'object' && typeof (m as { role?: unknown }).role === 'string',
    )
  );
}
