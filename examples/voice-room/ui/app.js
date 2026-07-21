// Voice-room browser client. Talks to the SSE server in server.ts:
//   GET  /config    — personas + audio settings + options (prefills the setup panel)
//   GET  /events     — live stream (tokens, scores, utterances, audio chunks, control)
//   POST /session    — rebuild the room from an edited roster + audio settings
//   POST /say         — a human turn (also the barge-in signal)
//   POST /stop        — halt the conversation
//   POST /continue    — "I finished playing that utterance; send the next beat"
//
// Audio has three paths: browser Web Speech (zero-key), OpenAI buffered mp3, and
// OpenAI streamed mp3 (progressive playback via MediaSource, with a buffered
// fallback). The "wants the floor" meter is clickable to reveal exactly which
// factors produced it.

const PALETTE = ['#f0a35e', '#6ea8fe', '#e06c9f', '#8fd694', '#c792ea', '#f2d675'];
const FACTOR_LABELS = {
  eagerness: 'eagerness',
  relevance: 'relevance',
  arousal: 'arousal',
  happiness: 'happiness',
  addressed: 'addressed',
  justSpoke: 'just spoke',
};

const state = {
  config: null,
  personas: [], // live roster {id,name,blurb,openaiVoice,web}
  byId: new Map(),
  voices: [], // chosen SpeechSynthesisVoice per persona index (web mode)
  scores: new Map(), // id -> latest TurnScore (with factors)
  open: new Set(), // persona ids whose factor breakdown is expanded
  streaming: null, // {whoId, el} bubble receiving tokens
  currentAudio: null,
  mse: null, // active MediaSource player
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const color = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ------------------------------------------------------------------ config

async function loadConfig() {
  const cfg = await fetch('/config').then((r) => r.json());
  state.config = cfg;
  state.personas = cfg.roster.personas;
  state.byId = new Map(state.personas.map((p) => [p.id, p]));
  $('status-line').textContent = `thinking: ${cfg.roster.thinking} · audio: ${cfg.audio.backend === 'openai' ? `OpenAI ${cfg.audio.openaiModel}${cfg.audio.streaming ? ' (streaming)' : ''}` : 'browser voices'}`;
  renderStage();
  pickWebVoices();
  renderSetup();
}

// ------------------------------------------------------------- setup panel

function renderSetup() {
  const cfg = state.config;
  // audio settings
  const backend = $('audio-backend');
  backend.value = cfg.audio.backend;
  const model = $('audio-model');
  model.innerHTML = cfg.ttsModels.map((m) => `<option value="${m}">${m}</option>`).join('');
  model.value = cfg.audio.openaiModel;
  $('audio-streaming').checked = cfg.audio.streaming;
  const openai = cfg.openaiAvailable;
  $('audio-note').textContent = openai
    ? 'OpenAI TTS uses your key; browser voices are free.'
    : 'No OPENAI_API_KEY set — OpenAI TTS disabled; using free browser voices.';
  for (const el of [backend, model, $('audio-streaming')]) {
    if (!openai && el === backend) {
      backend.value = 'web';
    }
  }
  const syncAudioDisabled = () => {
    const useOpenai = backend.value === 'openai';
    model.disabled = !useOpenai || !openai;
    $('audio-streaming').disabled = !useOpenai || !openai;
    if (!openai) backend.disabled = true;
  };
  backend.onchange = syncAudioDisabled;
  syncAudioDisabled();

  // persona editor
  const editor = $('persona-editor');
  editor.innerHTML = '';
  cfg.personas.forEach((p, i) => editor.appendChild(personaEditor(p, i)));
}

function personaEditor(p, index) {
  const node = $('persona-template').content.firstElementChild.cloneNode(true);
  node.querySelector('.pname').textContent = p.name || `Persona ${index + 1}`;
  node.querySelector('.pname').style.color = color(index);
  node.querySelector('.remove').onclick = () => {
    node.remove();
  };
  const set = (f, v) => {
    node.querySelector(`[data-f="${f}"]`).value = v;
  };
  set('name', p.name);
  set('blurb', p.blurb);
  set('systemPrompt', p.systemPrompt);
  set('interests', (p.interests || []).join(', '));
  set('knowledge', p.knowledge);
  set('rate', p.voice?.web?.rate ?? 1);
  set('pitch', p.voice?.web?.pitch ?? 1);
  const voiceSel = node.querySelector('[data-f="voice"]');
  voiceSel.innerHTML = (state.config.voices || []).map((v) => `<option>${v}</option>`).join('');
  voiceSel.value = p.voice?.openaiVoice ?? state.config.voices?.[0] ?? 'alloy';
  for (const key of Object.keys(p.baseline || {})) {
    const el = node.querySelector(`[data-m="${key}"]`);
    if (el) el.value = p.baseline[key];
  }
  node.querySelector('[data-f="name"]').oninput = (e) => {
    node.querySelector('.pname').textContent = e.target.value || `Persona ${index + 1}`;
  };
  return node;
}

function readEditor() {
  const personas = [];
  for (const node of $('persona-editor').children) {
    const g = (f) => node.querySelector(`[data-f="${f}"]`).value;
    const m = (k) => Number(node.querySelector(`[data-m="${k}"]`).value);
    personas.push({
      name: g('name').trim() || 'Anon',
      blurb: g('blurb').trim(),
      systemPrompt: g('systemPrompt').trim(),
      interests: g('interests').split(',').map((s) => s.trim()).filter(Boolean),
      knowledge: g('knowledge').trim(),
      voice: { openaiVoice: g('voice'), web: { rate: Number(g('rate')), pitch: Number(g('pitch')) } },
      baseline: {
        eagerness: m('eagerness'),
        happiness: m('happiness'),
        anxiety: m('anxiety'),
        anger: m('anger'),
        stress: m('stress'),
      },
    });
  }
  const audio = {
    backend: $('audio-backend').value,
    openaiModel: $('audio-model').value,
    streaming: $('audio-streaming').checked,
  };
  return { personas, audio };
}

const BLANK_PERSONA = () => ({
  name: '',
  blurb: '',
  systemPrompt: 'You are a new voice in the room.',
  interests: [],
  knowledge: '',
  voice: { openaiVoice: state.config?.voices?.[0] ?? 'alloy', web: { rate: 1, pitch: 1 } },
  baseline: { eagerness: 0.5, happiness: 0.5, anxiety: 0.2, anger: 0.1, stress: 0.2 },
});

function setupHandlers() {
  $('toggle-setup').onclick = () => $('setup').classList.toggle('collapsed');
  $('add-persona').onclick = () => {
    const i = $('persona-editor').children.length;
    if (i >= 6) return;
    $('persona-editor').appendChild(personaEditor(BLANK_PERSONA(), i));
  };
  $('apply-setup').onclick = async () => {
    const body = readEditor();
    if (body.personas.length === 0) {
      $('setup-note').textContent = 'Add at least one persona.';
      return;
    }
    $('setup-note').textContent = 'rebuilding room…';
    stopPlayback();
    await fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // /session broadcasts {t:'reset'}; the handler clears + refetches.
    $('setup-note').textContent = 'ready — push-to-talk or type to start.';
  };
}

// -------------------------------------------------------------------- stage

function renderStage() {
  const stage = $('stage');
  stage.innerHTML = '';
  state.personas.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'persona';
    card.id = `p-${p.id}`;
    if (state.open.has(p.id)) card.classList.add('open');
    card.innerHTML = `
      <div class="top">
        <div class="avatar" style="background:${color(i)}">${esc((p.name || '?')[0])}</div>
        <div><div class="name">${esc(p.name)}</div></div>
      </div>
      <div class="blurb">${esc(p.blurb)}</div>
      <div class="meter"><span id="meter-${p.id}"></span></div>
      <div class="meter-label"><span>wants the floor</span><span><span id="pval-${p.id}">—</span> <span class="why">details ▾</span></span></div>
      <div class="factors" id="factors-${p.id}"></div>`;
    card.onclick = () => {
      if (state.open.has(p.id)) state.open.delete(p.id);
      else state.open.add(p.id);
      card.classList.toggle('open');
      renderFactors(p.id);
    };
    stage.appendChild(card);
  });
}

function setSpeaking(whoId) {
  for (const p of state.personas) $(`p-${p.id}`)?.classList.toggle('speaking', p.id === whoId);
}

function updateScores(scores) {
  for (const s of scores) {
    state.scores.set(s.id, s);
    const bar = $(`meter-${s.id}`);
    const val = $(`pval-${s.id}`);
    if (bar) bar.style.width = `${Math.round(s.p * 100)}%`;
    if (val) val.textContent = s.p.toFixed(2);
    renderFactors(s.id);
  }
}

// The factor breakdown: exactly where "wants the floor" comes from (#4).
function renderFactors(id) {
  const box = $(`factors-${id}`);
  if (!box || !state.open.has(id)) return;
  const s = state.scores.get(id);
  if (!s || !s.factors) {
    box.innerHTML = '<div class="fsum">no score yet</div>';
    return;
  }
  const scale = 1.6;
  const row = (label, v) => {
    const pos = v >= 0;
    const w = Math.min(Math.abs(v) / scale, 1) * 50;
    const style = pos ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
    return `<div class="frow"><span>${label}</span><div class="fbar"><i class="${pos ? 'pos' : 'neg'}" style="${style}"></i></div><span class="fv">${v >= 0 ? '+' : ''}${v.toFixed(2)}</span></div>`;
  };
  const rows = Object.keys(FACTOR_LABELS).map((k) => row(FACTOR_LABELS[k], s.factors[k] ?? 0));
  box.innerHTML = `${rows.join('')}<div class="fsum">raw score ${Number(s.raw ?? 0).toFixed(2)} → softmax → p ${s.p.toFixed(2)}</div>`;
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
const setStatus = (t) => {
  $('room-status').textContent = t;
};

// -------------------------------------------------------------------- audio

function pickWebVoices() {
  const all = ('speechSynthesis' in window ? speechSynthesis.getVoices() : []).filter((v) => v.lang.startsWith('en'));
  state.voices = state.personas.map((_, i) => all[i % all.length] || null);
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = pickWebVoices;

function stopPlayback() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }
  if (state.mse) {
    state.mse.stop();
    state.mse = null;
  }
}

const cont = () => fetch('/continue', { method: 'POST' });

function playBuffered(base64, approxMs) {
  if (!base64) {
    setTimeout(cont, approxMs || 1200);
    return;
  }
  const audio = new Audio(`data:audio/mp3;base64,${base64}`);
  state.currentAudio = audio;
  audio.onended = cont;
  audio.onerror = cont;
  audio.play().catch(cont);
}

function playWebSpeech(u) {
  if (!('speechSynthesis' in window)) {
    setTimeout(cont, u.approxMs || 1200);
    return;
  }
  const idx = state.personas.findIndex((p) => p.id === u.whoId);
  const persona = state.byId.get(u.whoId);
  const utter = new SpeechSynthesisUtterance(u.text);
  if (state.voices[idx]) utter.voice = state.voices[idx];
  utter.rate = persona?.web?.rate ?? 1;
  utter.pitch = persona?.web?.pitch ?? 1;
  utter.onend = cont;
  utter.onerror = cont;
  speechSynthesis.speak(utter);
}

// Progressive playback of streamed mp3 via MediaSource; null if unsupported.
function createMsePlayer(onEnded) {
  if (!('MediaSource' in window) || !MediaSource.isTypeSupported('audio/mpeg')) return null;
  const ms = new MediaSource();
  const audio = new Audio();
  audio.src = URL.createObjectURL(ms);
  audio.onended = onEnded;
  audio.onerror = onEnded;
  let sb = null;
  const queue = [];
  let ended = false;
  let started = false;
  const flush = () => {
    if (!sb || sb.updating) return;
    if (queue.length) {
      sb.appendBuffer(queue.shift());
      if (!started) {
        started = true;
        audio.play().catch(() => {});
      }
      return;
    }
    if (ended && ms.readyState === 'open') {
      try {
        ms.endOfStream();
      } catch {}
    }
  };
  ms.addEventListener('sourceopen', () => {
    try {
      sb = ms.addSourceBuffer('audio/mpeg');
      sb.addEventListener('updateend', flush);
      flush();
    } catch {
      onEnded();
    }
  });
  return {
    push: (bytes) => {
      queue.push(bytes);
      flush();
    },
    end: () => {
      ended = true;
      flush();
    },
    stop: () => {
      try {
        audio.pause();
      } catch {}
      try {
        if (ms.readyState === 'open') ms.endOfStream();
      } catch {}
    },
  };
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
    case 'audio-chunk': {
      if (state.mse === null) state.mse = createMsePlayer(cont);
      if (state.mse) state.mse.push(b64ToBytes(e.base64));
      break;
    }
    case 'utterance':
      if (state.streaming && state.streaming.whoId === e.whoId) state.streaming.el.textContent = e.text;
      else addBubble(e.who, e.whoId, e.text, false);
      state.streaming = null;
      setStatus('');
      // Choose the playback path.
      if (e.streamed && state.mse) {
        const mse = state.mse;
        state.mse = null;
        mse.end(); // onEnded (== cont) fires when playback finishes
      } else if (e.audioBase64) {
        state.mse = null;
        playBuffered(e.audioBase64, e.approxMs); // OpenAI buffered, or streaming w/o MSE
      } else {
        playWebSpeech(e); // browser voices
      }
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
    } else if (msg.t === 'stopped') {
      stopPlayback();
      state.streaming = null;
      setSpeaking(null);
      setStatus('stopped');
    } else if (msg.t === 'preempt') {
      stopPlayback();
      state.streaming = null;
    } else if (msg.t === 'reset') {
      stopPlayback();
      state.streaming = null;
      $('log').innerHTML = '';
      state.scores.clear();
      setStatus('new room ready — your turn');
      loadConfig();
    }
  };
  src.onerror = () => setStatus('reconnecting…');
}

// --------------------------------------------------------------- user input

function sendText(text) {
  const t = (text || '').trim();
  if (!t) return;
  stopPlayback();
  fetch('/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) });
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let recognized = '';

function setupPushToTalk() {
  const btn = $('talk');
  if (!SR) {
    btn.textContent = '🎙 Voice input not supported — type below';
    btn.style.opacity = 0.6;
    $('hint').textContent = 'This browser lacks Web Speech recognition (try Chrome). Typing works everywhere.';
    return;
  }
  $('hint').textContent = 'Hold to talk, release to send. Cutting in silences the room.';
  const start = (ev) => {
    ev.preventDefault();
    stopPlayback();
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

function setupControls() {
  const input = $('text-input');
  const send = () => {
    sendText(input.value);
    input.value = '';
  };
  $('send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  $('stop-btn').addEventListener('click', () => {
    stopPlayback();
    fetch('/stop', { method: 'POST' });
  });
}

loadConfig().then(() => {
  connect();
  setupHandlers();
  setupPushToTalk();
  setupControls();
});
