// Chat rendering for stdlib `Messages` components: role-colored bubbles with
// tool-call chips, plus a composer that follows the stdlib send convention
// (Messages append + MessageWaiting when the tag exists in the registry).

import { memo, useState } from 'react';
import type { ChatMsg } from '../chat-shape';
import { isChatTranscript } from '../chat-shape';
import { jsonPreview } from '../format';
import { useStore } from '../store';
import { SendIcon } from './icons';

export type { ChatMsg } from '../chat-shape';
export { isChatTranscript } from '../chat-shape';

const ROLE_LABEL: Record<string, string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
};

const Bubble = memo(function Bubble({ msg }: { msg: ChatMsg }) {
  const role = ROLE_LABEL[msg.role] ?? 'other';
  const content =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content == null
        ? ''
        : jsonPreview(msg.content, 400);
  return (
    <div className={`chat-msg chat-${role}`}>
      <div className="chat-msg-head">
        <span className="chat-role">{msg.role}</span>
        {msg.name !== undefined && <span className="chat-name">{msg.name}</span>}
        {msg.toolCallId !== undefined && (
          <span className="chat-toolcall-id">↩ {msg.toolCallId}</span>
        )}
      </div>
      {content !== '' && <div className="chat-content">{content}</div>}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="chat-toolcalls">
          {msg.toolCalls.map((call, i) => (
            <span key={call.id ?? `call-${String(i)}`} className="chip chip-toolcall">
              <span className="chat-toolcall-name">{call.name ?? 'tool'}</span>(
              {jsonPreview(call.args, 48)})
              {call.id !== undefined && <span className="chat-toolcall-id"> {call.id}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export function ChatTranscript({ messages }: { messages: ChatMsg[] }) {
  if (messages.length === 0) {
    return <div className="chat-empty">Transcript is empty — send a message below.</div>;
  }
  return (
    <div className="chat-transcript">
      {messages.map((msg, i) => (
        <Bubble key={`${String(i)}-${msg.role}-${String(msg.content).slice(0, 24)}`} msg={msg} />
      ))}
    </div>
  );
}

/** Composer: `send` command = external Messages append (+ MessageWaiting) + run. */
export function ChatComposer({ entity }: { entity: number }) {
  const { state, command } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const running = state.world?.running === true;
  const hasWaitingTag = (state.world?.components ?? []).some((c) => c.name === 'MessageWaiting');

  const send = async (): Promise<void> => {
    const content = text.trim();
    if (content === '' || busy) return;
    setBusy(true);
    const components: { name: string; value: unknown }[] = [
      { name: 'Messages', value: [{ role: 'user', content }] },
    ];
    if (hasWaitingTag) components.push({ name: 'MessageWaiting', value: true });
    const result = await command({ type: 'send', entity, components });
    setBusy(false);
    if (result.ok) setText('');
  };

  return (
    <div className="chat-composer">
      <textarea
        className="input chat-composer-input"
        placeholder="Message this agent… (sends + runs)"
        aria-label="Message to send"
        value={text}
        rows={2}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
        }}
      />
      <button
        type="button"
        className="btn btn-accent"
        disabled={text.trim() === '' || busy || running || state.status !== 'open'}
        onClick={() => void send()}
        title={running ? 'A run is in flight' : 'Append a user message and run'}
      >
        <SendIcon />
        Send
      </button>
    </div>
  );
}
