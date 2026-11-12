// Local voice engine: the call runs entirely in this browser tab, no ElevenLabs account needed.
//   ears  - Whisper (transformers.js) on the mic, with a simple energy-based turn detector
//   mouth - Kokoro-82M (kokoro-js) text-to-speech
//   brain - a small rule-based interviewer that follows prompt.md's rules: ask, settle, park, recap, send
// It exposes the slice of the ElevenLabs `Conversation` API that call.html uses, so the page treats
// both engines the same. Models download from Hugging Face on the first call and are cached by the
// browser after that; inference never leaves the machine.

const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const FRAME = 320;           // 20 ms at 16 kHz
const START_FRAMES = 4;      // 80 ms above threshold starts an utterance
const END_MS = 800;          // this much quiet ends it
const MIN_SPEECH_MS = 250;   // shorter blips are ignored
const MAX_UTTER_MS = 30_000;
const PREROLL = 15;          // frames kept from before the start (300 ms)

export const Conversation = { startSession: (opts) => LocalSession.start(opts) };

class LocalSession {
  static async start(opts) {
    const s = new LocalSession(opts);
    await s.load();
    await s.listen();
    s.interviewer.greet();
    return s;
  }

  constructor(opts) {
    this.opts = opts;
    this.config = opts.config || {};
    this.voice = this.config.voice || 'af_heart';
    this.closed = false;
    this.muted = false;
    this.mode = 'listening';
    this.speech = Promise.resolve(); // queued speech, in order
    this.synthChain = Promise.resolve(); // one TTS inference at a time
    this.sayToken = 0;
    this.playing = null;
    this.hearing = Promise.resolve(); // one transcription at a time
    this.interviewer = new Interviewer(this);
  }

  status(text) { this.opts.onStatus?.(text); }

  // ---------- models ----------

  async load() {
    const files = new Map();
    const progress = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file + p.name, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      this.status(`Loading local voice ${Math.round((loaded / total) * 100)}%`);
    };
    this.status('Loading local voice…');
    const webgpu = !!(await navigator.gpu?.requestAdapter?.().catch(() => null));
    const [{ KokoroTTS }, { pipeline }] = await Promise.all([import(KOKORO_URL), import(TRANSFORMERS_URL)]);
    [this.tts, this.asr] = await Promise.all([
      KokoroTTS.from_pretrained(KOKORO_MODEL, {
        dtype: webgpu ? 'fp32' : 'q8',
        device: webgpu ? 'webgpu' : 'wasm',
        progress_callback: progress,
      }),
      pipeline('automatic-speech-recognition', this.config.sttModel || 'Xenova/whisper-base.en', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: progress,
      }),
    ]);
    this.status('Connecting…');
  }

  // ---------- mic and turn detection ----------

  async listen() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.inCtx = new AudioContext({ sampleRate: 16_000 });
    const src = this.inCtx.createMediaStreamSource(this.stream);
    this.inAnalyser = this.inCtx.createAnalyser();
    this.inAnalyser.fftSize = 512;
    src.connect(this.inAnalyser);

    const worklet = `registerProcessor('hotseat-tap', class extends AudioWorkletProcessor {
      process(inputs) { const c = inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
    });`;
    const url = URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' }));
    await this.inCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(this.inCtx, 'hotseat-tap');
    src.connect(tap);
    // A worklet only runs while connected to the graph; a muted gain keeps it out of the speakers.
    const sink = this.inCtx.createGain();
    sink.gain.value = 0;
    tap.connect(sink).connect(this.inCtx.destination);

    this.outCtx = new AudioContext();
    this.outAnalyser = this.outCtx.createAnalyser();
    this.outAnalyser.fftSize = 512;
    this.outAnalyser.connect(this.outCtx.destination);

    this.vad = { buf: new Float32Array(FRAME), fill: 0, floor: 0.005, loud: 0, active: false, frames: [], quietMs: 0, speechMs: 0, pre: [] };
    tap.port.onmessage = (e) => this.onSamples(e.data);
  }

  onSamples(chunk) {
    const v = this.vad;
    for (let i = 0; i < chunk.length; i++) {
      v.buf[v.fill++] = chunk[i];
      if (v.fill === FRAME) {
        this.onFrame(v.buf);
        v.buf = new Float32Array(FRAME);
        v.fill = 0;
      }
    }
  }

  onFrame(frame) {
    const v = this.vad;
    if (this.closed || this.muted) return;
    let sum = 0;
    for (const x of frame) sum += x * x;
    const rms = Math.sqrt(sum / frame.length);
    // While Hotseat talks, only a clearly louder voice counts, so its own echo doesn't interrupt it.
    const threshold = Math.max(0.012, v.floor * 3) * (this.mode === 'speaking' ? 3 : 1);
    const loud = rms > threshold;

    if (!v.active) {
      if (!loud) v.floor = v.floor * 0.98 + rms * 0.02;
      v.pre.push(frame);
      if (v.pre.length > PREROLL) v.pre.shift();
      v.loud = loud ? v.loud + 1 : 0;
      if (v.loud >= START_FRAMES) {
        v.active = true;
        v.frames = [...v.pre];
        v.pre = [];
        v.quietMs = 0;
        v.speechMs = v.loud * 20;
        if (this.mode === 'speaking') this.stopSpeaking(); // barge in
      }
      return;
    }
    v.frames.push(frame);
    if (loud) { v.speechMs += 20; v.quietMs = 0; } else v.quietMs += 20;
    if (v.quietMs >= END_MS || v.frames.length * 20 >= MAX_UTTER_MS) {
      const frames = v.frames, speechMs = v.speechMs;
      v.active = false;
      v.frames = [];
      v.loud = 0;
      if (speechMs >= MIN_SPEECH_MS) this.transcribe(frames);
    }
  }

  transcribe(frames) {
    const audio = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => audio.set(f, i * FRAME));
    this.hearing = this.hearing.then(async () => {
      if (this.closed) return;
      try {
        const out = await this.asr(audio);
        // Whisper marks noise as [BLANK_AUDIO], (coughs), *music* and the like.
        const text = String(out?.text ?? '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || this.closed) return;
        this.opts.onMessage?.({ source: 'user', message: text });
        await this.interviewer.hear(text);
      } catch (e) {
        this.opts.onError?.(e);
      }
    });
  }

  // ---------- speech ----------

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.opts.onModeChange?.({ mode });
  }

  // Queue a line. Resolves true once spoken, false if the person cut in or the call ended.
  say(text) {
    const token = this.sayToken;
    const done = this.speech.then(() => this.speak(text, token));
    this.speech = done.catch(() => {});
    return done;
  }

  async speak(text, token) {
    if (this.closed || token !== this.sayToken) return false;
    this.opts.onMessage?.({ source: 'ai', message: text });
    const parts = text.match(/[^.!?]+[.!?]+["')]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
    let next = this.synth(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const audio = await next;
      if (this.closed || token !== this.sayToken) return false;
      next = i + 1 < parts.length ? this.synth(parts[i + 1]) : null;
      this.setMode('speaking');
      if (!(await this.play(audio))) return false;
    }
    if (token === this.sayToken) this.setMode('listening');
    return true;
  }

  synth(text) {
    const run = this.synthChain.then(() => this.tts.generate(text, { voice: this.voice }));
    this.synthChain = run.catch(() => {});
    return run;
  }

  play(audio) {
    return new Promise((resolve) => {
      const buf = this.outCtx.createBuffer(1, audio.audio.length, audio.sampling_rate);
      buf.copyToChannel(audio.audio, 0);
      const src = this.outCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.outAnalyser);
      src.onended = () => { this.playing = null; resolve(true); };
      this.playing = { src, resolve };
      src.start();
    });
  }

  // Drop the current line and everything queued after it.
  stopSpeaking() {
    this.sayToken++;
    const p = this.playing;
    if (p) {
      this.playing = null;
      p.src.onended = null;
      try { p.src.stop(); } catch {}
      p.resolve(false);
    }
    this.setMode('listening');
  }

  // ---------- the Conversation surface call.html uses ----------

  // `ev` is the structured SSE event behind the [CLAUDE] frame; the text is only a fallback.
  sendUserMessage(text, ev) {
    if (!this.closed) this.interviewer.onClaude(text, ev);
  }

  getInputByteFrequencyData() { return this.bins(this.inAnalyser); }
  getOutputByteFrequencyData() { return this.bins(this.outAnalyser); }
  bins(analyser) {
    if (!analyser) return null;
    const out = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(out);
    return out;
  }

  setMicMuted(muted) {
    this.muted = muted;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted;
  }

  async endSession() {
    if (this.closed) return;
    this.stopSpeaking();
    this.closed = true;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    await Promise.allSettled([this.inCtx?.close(), this.outCtx?.close()]);
    this.opts.onDisconnect?.();
  }
}

// ---------- the interviewer ----------

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (t) => (t ? t.split(' ').length : 0);
const sentence = (t) => { t = t.trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
const clip = (t, n = 10) => { const w = t.trim().replace(/[.!?]+$/, '').split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')}…` : w.join(' '); };

// Thinking noises are not answers; "mhm" and "uh huh" mean yes.
const FILLER = /^((h?m+)|(u+h+)|(u+m+)|(e+r+)|(a+h+)|(o+h+)|well|so|hmm+|let me think|um+ let me think)$/;
const YES = /^(mhm|mm hmm|uh huh|yes|yeah|yep|yup|ya|sure|ok|okay|right|correct|exactly|agreed|absolutely|definitely|perfect|fine|great|good|cool|sounds (good|right|great|fine)|that'?s (right|fine|good|it)|go (with|for) (it|that)|do (it|that)|makes sense|let'?s do (it|that)|i agree)\b/;
const NO = /^(no|nope|nah|not really|no way|i don'?t think so)$/;
const DECIDE = /\b(you decide|your call|up to you|you choose|you pick|whatever you (think|recommend|suggest)|go with your|i don'?t mind|either (is|way)|dealer'?s choice|don'?t care)\b/;
const PARK = /\b(park (it|that|this)|skip (it|that|this)|come back to (it|that|this)|later|pass|not sure yet|no idea|next question|park|skip)\b/;
const BACK = /\b(go back|previous (one|question)|back to the (last|previous)|undo that)\b/;
const REPEAT = /\b(repeat|say (that|it) again|what was the question|pardon|come again|sorry what)\b/;
const SEND = /\b(send( it)?|confirm|looks good|ship it|go ahead|that'?s (it|all)|all good|done)\b/;
const CHANGE = /\b(change|wait|redo|fix|actually|go back|wrong|edit)\b/;
const ORDINALS = { first: 1, one: 1, second: 2, two: 2, third: 3, three: 3, fourth: 4, four: 4, fifth: 5, five: 5, sixth: 6, six: 6, seventh: 7, seven: 7, eighth: 8, eight: 8, ninth: 9, nine: 9, tenth: 10, ten: 10 };

class Interviewer {
  constructor(session) {
    this.s = session;
    this.round = null;
    this.phase = 'idle'; // idle | asking | review | waiting | ended
    this.idx = 0;
    this.answers = {};
    this.changing = false;
    this.pendingNo = null; // the person said "no": ask what instead, keep their words
    this.greeted = false;
  }

  get tools() { return this.s.opts.clientTools; }
  get q() { return this.round?.questions[this.idx]; }

  greet() {
    // A round already queued gets asked right away; otherwise say one holding line.
    setTimeout(() => {
      if (!this.round && this.phase === 'idle' && !this.greeted) {
        this.greeted = true;
        this.s.say("Hi, I'm here. Claude's lining up the first question.");
      }
    }, 400);
  }

  onClaude(text, ev) {
    const type = ev?.type ?? (/^\[CLAUDE\] round/.test(text) ? 'round' : /^\[CLAUDE\] (thinking|end)/.exec(text)?.[1]);
    if (type === 'round') return this.startRound(ev?.data ?? parseRound(text));
    if (type === 'thinking') {
      if (this.phase === 'thinking') return;
      this.phase = 'thinking';
      return void this.s.say("Give me a sec, Claude's writing that down.");
    }
    if (type === 'end') {
      this.phase = 'ended';
      return void this.s.say("That's everything for now. Thanks, talk soon.");
    }
    const change = /^\[CLAUDE\] change (\S+)/.exec(text);
    if (change) return this.redo(change[1]);
  }

  startRound(r) {
    if (!r?.questions?.length) return;
    this.round = r;
    this.answers = {};
    this.idx = 0;
    this.changing = false;
    this.pendingNo = null;
    this.phase = 'asking';
    this.greeted = true;
    this.ask();
  }

  ask(prefix = '') {
    const q = this.q;
    let line = sentence(q.question);
    if (q.recommendation) line += ` I'd suggest: ${sentence(q.recommendation)} Sound right?`;
    return this.s.say(prefix + line);
  }

  redo(id) {
    const i = this.round?.questions.findIndex((q) => q.id === id) ?? -1;
    if (i < 0) return;
    this.s.stopSpeaking();
    this.idx = i;
    this.changing = true;
    this.pendingNo = null;
    this.phase = 'asking';
    const q = this.q;
    this.s.say(`Sure, let's redo that one. ${sentence(q.question)}${q.recommendation ? ` I'd suggest: ${sentence(q.recommendation)}` : ''}`);
  }

  async hear(text) {
    const t = norm(text);
    if (!t) return;
    if (FILLER.test(t)) {
      if (this.phase === 'asking' || this.phase === 'review') this.s.say('Take your time.');
      return;
    }
    if (this.phase === 'asking') return this.answer(text, t);
    if (this.phase === 'review') return this.review(t);
    if (this.phase === 'thinking' || this.phase === 'waiting') return void this.s.say("Claude's still on it. One moment.");
    if (this.phase === 'idle') return void this.s.say("Still waiting on Claude's first question.");
  }

  async answer(text, t) {
    const q = this.q;
    if (REPEAT.test(t) && words(t) <= 6) return void this.ask();
    if (BACK.test(t) && words(t) <= 6) {
      if (this.idx === 0) return void this.s.say("That's the first one. " + sentence(q.question));
      this.idx--;
      this.pendingNo = null;
      return void this.ask('Going back. ');
    }
    if (this.pendingNo == null && NO.test(t) && q.recommendation) {
      this.pendingNo = text;
      return void this.s.say('Okay. What would you go with instead?');
    }
    const quote = this.pendingNo ? `${this.pendingNo} … ${text}` : text;
    this.pendingNo = null;

    if (DECIDE.test(t)) {
      if (!q.recommendation) return void this.s.say("I don't have a suggestion for this one. What's your gut say?");
      this.s.say(`Okay, going with ${clip(q.recommendation)}.`);
      return this.settle(q.recommendation, quote);
    }
    if (PARK.test(t) && (words(t) <= 6 || /\bpark (it|that|this)\b/.test(t))) return this.park(text);
    if (YES.test(t) && words(t) <= 8 && !/\b(but|except|although|no|not)\b/.test(t)) return this.settle(q.recommendation || 'Yes.', quote);
    // Anything else is their answer in their own words; Claude reads the quote.
    return this.settle(sentence(text), quote);
  }

  async settle(answer, quote) {
    const id = this.q.id;
    const res = await this.tools.settle_answer({ question_id: id, answer, quote });
    if (/closed/i.test(res)) return void (this.phase = 'waiting');
    this.answers[id] = { status: 'settled', answer };
    this.next();
  }

  async park(reason) {
    const id = this.q.id;
    const res = await this.tools.park_question({ question_id: id, reason });
    if (/closed/i.test(res)) return void (this.phase = 'waiting');
    this.answers[id] = { status: 'parked', reason };
    this.s.say('Parked.');
    this.next();
  }

  next() {
    const qs = this.round.questions;
    if (this.changing) {
      this.changing = false;
      if (qs.every((q) => this.answers[q.id])) {
        this.phase = 'review';
        return void this.s.say('Updated. Send it now?');
      }
    }
    const open = qs.findIndex((q, i) => i > this.idx && !this.answers[q.id]);
    const first = open >= 0 ? open : qs.findIndex((q) => !this.answers[q.id]);
    if (first >= 0) {
      this.idx = first;
      return void this.ask();
    }
    if (qs.length === 1) {
      this.phase = 'waiting';
      return void this.s.say('Got it, passing it to Claude.');
    }
    this.phase = 'review';
    const parts = qs.map((q) => {
      const a = this.answers[q.id];
      return a.status === 'parked' ? `${q.title || 'one'} parked` : clip(a.answer, 8);
    });
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}` : parts[0];
    this.s.say(`Quick check: ${list}. Send it to Claude?`);
  }

  async review(t) {
    const n = Object.entries(ORDINALS).find(([w]) => new RegExp(`\\b${w}\\b`).test(t))?.[1] ?? Number(/\b(\d+)\b/.exec(t)?.[1]);
    const wantsChange = CHANGE.test(t) || BACK.test(t) || /\blast one\b/.test(t);
    if (wantsChange) {
      const qs = this.round.questions;
      const i = /\blast\b/.test(t) || !n ? qs.length - 1 : Math.min(qs.length, n) - 1;
      return this.redo(qs[i].id);
    }
    if (SEND.test(t) || YES.test(t)) {
      this.phase = 'waiting';
      const res = await this.tools.confirm_round();
      return void this.s.say(/closed|sent/i.test(res) ? 'Got it, passing it to Claude.' : res);
    }
    this.s.say('Should I send it, or change one? Say which one.');
  }
}

// Fallback when only the [CLAUDE] text frame arrives.
function parseRound(text) {
  const head = /^\[CLAUDE\] round (\d+) on "(.*)"\. Questions:/.exec(text);
  if (!head) return null;
  const questions = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const cells = line.slice(2).split(' | ');
    const recCell = cells.at(-1)?.startsWith('recommended:') ? cells.pop() : 'recommended: ';
    const [id, title, ...rest] = cells;
    questions.push({ id, title, question: rest.join(' | '), recommendation: recCell.slice('recommended:'.length).trim() });
  }
  return { round: Number(head[1]), topic: head[2], questions };
}
