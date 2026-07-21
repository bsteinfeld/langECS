// Voice-room browser client. Talks to the SSE server in server.ts:
//   * GET  /roster    — who is in the room + how each persona should sound
//   * GET  /events    — the live stream (tokens, scores, utterances, lulls)
//   * POST /say        — a human turn (also the barge-in signal)
//   * POST /continue   — "I finished playing that utterance, send the next beat"
//
// Audio is zero-key: speech recognition + synthesis run in the browser (Web
// Speech API), with a distinct voice/rate/pitch per persona. If the server was
// started with OpenAI audio, utterances arrive as base64 mp3 and we play those
// instead.

const PALETTE = ['#f0a35e', '#6ea8fe', '#e06c9f', '#8fd694', '#c792ea'];

const state = {
  personas: [], // {id,name,blurb,openaiVoice,web:{rate,pitch}}
  byId: new Map(),
  audioMode: 'web',
  voices: [], // chosen SpeechSynthesisVoice per persona index
  streaming: null, // {whoId, el} bubble currently receiving tokens
  currentAudio: null, // HTMLAudioElement in OpenAI mode
};

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// --------------------------------------------------------------- roster / stage

async function loadRoster() {
  const r = await fetch('/roster').then((x) => x.json());
  state.personas = r.personas;
  state.audioMode = r.audioMode;
  state.byId = new Map(r.personas.map((p) => [p.id, p]));
  $('status-line').textContent = `thinking: ${r.thinking} · audio: ${r.audioMode === 'openai' ? 'OpenAI TTS' : 'browser voices'}`;
  renderStage();
  pickWebVoices();
}

function color(i) {
  return PALETTE[i % PALETTE.length];
}

function renderStage() {
  const stage = $('stage');
  stage.innerHTML = '';
  state.personas.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'persona';
    card.id = `p-${p.id}`;
    card.innerHTML = `
      <div class="top">
        <div class="avatar" style="background:${color(i)}">${p.name[0]}</div>
        <div><div class="name">${esc(p.name)}</div></div>
      </div>
      <div class="blurb">${esc(p.blurb)}</div>
      <div class="meter"><span id="meter-${p.id}"></span></div>
      <div class="meter-label"><span>wants the floor</span><span id="pval-${p.id}">—</span></div>`;
    stage.appendChild(card);
  });
}

function setSpeaking(whoId) {
  for (const p of state.personas) $(`p-${p.id}`).classList.toggle('speaking', p.id === whoId);
}

function updateScores(scores) {
  for (const s of scores) {
    const bar = $(`meter-${s.id}`);
    const val = $(`pval-${s.id}`);
    if (bar) bar.style.width = `${Math.round(s.p * 100)}%`;
    if (val) val.textContent = s.p.toFixed(2);
  }
}

// ------------------------------------------------------------------ transcript

function addBubble(who, whoId, text, isUser) {
  const log = $('log');
  const div = document.createElement('div');
  div.className = `msg${isUser ? ' user' : ''}`;
  const i = state.personas.findIndex((p) => p.id === whoId);
  const tint = isUser ? 'var(--user)' : color(i < 0 ? 0 : i);
  div.innerHTML = `<div class="who" style="color:${tint}">${esc(who)}</div><div class="body">${esc(text)}</div>`;
  log.appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
  return div.querySelector('.body');
}

function setStatus(text) {
  $('room-status').textContent = text;
}

// -------------------------------------------------------------------- audio

function pickWebVoices() {
  const all = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  state.voices = state.personas.map((_, i) => all[i % all.length] || null);
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = pickWebVoices;

function stopPlayback() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }
}

// Play one utterance, then tell the server to send the next beat.
function play(u) {
  const done = () => fetch('/continue', { method: 'POST' });
  if (state.audioMode === 'openai' && u.audioBase64) {
    const audio = new Audio(`data:audio/mp3;base64,${u.audioBase64}`);
    state.currentAudio = audio;
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
    return;
  }
  if (!('speechSynthesis' in window)) {
    setTimeout(done, u.approxMs || 1200);
    return;
  }
  const idx = state.personas.findIndex((p) => p.id === u.whoId);
  const persona = state.byId.get(u.whoId);
  const utter = new SpeechSynthesisUtterance(u.text);
  if (state.voices[idx]) utter.voice = state.voices[idx];
  utter.rate = persona?.web?.rate ?? 1;
  utter.pitch = persona?.web?.pitch ?? 1;
  utter.onend = done;
  utter.onerror = done;
  speechSynthesis.speak(utter);
}

// ------------------------------------------------------------------- events

function onEvent(e) {
  switch (e.kind) {
    case 'user':
      addBubble('You', null, e.text, true);
      break;
    case 'scores':
      updateScores(e.scores);
      setSpeaking(e.pickId);
      break;
    case 'token': {
      if (!state.streaming || state.streaming.whoId !== e.whoId) {
        state.streaming = { whoId: e.whoId, el: addBubble(e.who, e.whoId, '', false) };
      }
      state.streaming.el.textContent += e.text;
      window.scrollTo(0, document.body.scrollHeight);
      break;
    }
    case 'utterance':
      if (state.streaming && state.streaming.whoId === e.whoId) {
        state.streaming.el.textContent = e.text; // finalize streamed text
      } else {
        addBubble(e.who, e.whoId, e.text, false);
      }
      state.streaming = null;
      setStatus('');
      play(e);
      break;
    case 'lull':
      setSpeaking(null);
      setStatus('the room is quiet — your turn');
      break;
  }
}

function connect() {
  const src = new EventSource('/events');
  src.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'event') onEvent(msg.e);
    else if (msg.t === 'thinking') setStatus('…');
    else if (msg.t === 'lull') {
      setSpeaking(null);
      setStatus('the room is quiet — your turn');
    } else if (msg.t === 'preempt') {
      stopPlayback();
      state.streaming = null;
    }
  };
  src.onerror = () => setStatus('reconnecting…');
}

// --------------------------------------------------------------- user input

function sendText(text) {
  const t = (text || '').trim();
  if (!t) return;
  stopPlayback(); // barge in: silence the room immediately
  fetch('/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: t }),
  });
}

// Push-to-talk via the Web Speech recognition API (Chrome/Edge/Safari).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let recognized = '';

function setupPushToTalk() {
  const btn = $('talk');
  if (!SR) {
    btn.textContent = '🎙 Voice not supported here — type below';
    btn.style.opacity = 0.6;
    $('hint').textContent = 'This browser lacks the Web Speech recognition API (try Chrome). Typing works everywhere.';
    return;
  }
  $('hint').textContent = 'Hold the button, speak, release. Cutting in silences the room.';

  const start = (ev) => {
    ev.preventDefault();
    stopPlayback(); // barge in the instant you press
    recognized = '';
    recog = new SR();
    recog.lang = 'en-US';
    recog.interimResults = true;
    recog.continuous = true;
    recog.onresult = (r) => {
      recognized = Array.from(r.results).map((x) => x[0].transcript).join(' ');
    };
    recog.start();
    btn.classList.add('recording');
    btn.textContent = '● listening — release to send';
  };
  const stop = (ev) => {
    ev.preventDefault();
    if (!recog) return;
    recog.stop();
    recog = null;
    btn.classList.remove('recording');
    btn.textContent = '🎙 Hold to talk (or type below)';
    if (recognized.trim()) sendText(recognized);
  };

  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mouseup', stop);
  btn.addEventListener('touchend', stop);
}

function setupTextInput() {
  const input = $('text-input');
  const send = () => {
    sendText(input.value);
    input.value = '';
  };
  $('send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
}

loadRoster().then(() => {
  connect();
  setupPushToTalk();
  setupTextInput();
});
