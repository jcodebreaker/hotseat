// OpenAI Realtime engine: the call runs on an OpenAI speech-to-speech model over WebRTC.
// The server mints a short-lived client secret with the whole session config (prompt.md, tools,
// voice); this tab only connects with it, so the API key never reaches the browser.
// It exposes the slice of the ElevenLabs `Conversation` API that call.html uses, so the page treats
// every engine the same.

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const FIRST_MESSAGE = 'Hey, one sec, pulling up the questions.';
const QUOTE_WAIT_MS = 2000; // how long a tool call waits for the person's last words to be transcribed

export const Conversation = { startSession: (opts) => RealtimeSession.start(opts) };

class RealtimeSession {
  static async start(opts) {
    const s = new RealtimeSession(opts);
    try {
      await s.connect();
    } catch (err) {
      s.teardown();
      throw err;
    }
    s.say(FIRST_MESSAGE);
    return s;
  }

  constructor(opts) {
    this.opts = opts;
    this.closed = false;
    this.mode = 'listening';
    this.responding = false;  // a response is in flight on the server
    this.wantResponse = false; // another response.create is owed once it finishes
    this.pendingCalls = [];   // function calls from the current response
    this.lastUser = null;     // { itemId, transcript } of the person's latest turn
    this.transcripts = new Map(); // itemId -> resolve, for turns still being transcribed
  }

  // ---------- connection ----------

  async connect() {
    if (!this.opts.conversationToken) throw new Error('No OpenAI client secret.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const pc = (this.pc = new RTCPeerConnection());
    this.audio = Object.assign(document.createElement('audio'), { autoplay: true });
    pc.ontrack = (e) => {
      this.audio.srcObject = e.streams[0];
      this.outAnalyser = this.analyse(e.streams[0]);
    };
    for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
    this.inAnalyser = this.analyse(this.stream);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.endSession();
    };

    const dc = (this.dc = pc.createDataChannel('oai-events'));
    dc.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      this.onServerEvent(ev);
    };
    dc.onclose = () => this.endSession();
    const opened = new Promise((resolve, reject) => {
      dc.onopen = resolve;
      setTimeout(() => reject(new Error('OpenAI Realtime did not connect.')), 15_000);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await fetch(CALLS_URL, {
      method: 'POST',
      body: offer.sdp,
      headers: { authorization: `Bearer ${this.opts.conversationToken}`, 'content-type': 'application/sdp' },
    });
    if (!r.ok) throw new Error(`OpenAI Realtime refused the call (${r.status}).`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
    await opened;
    this.opts.onConnect?.();
  }

  analyse(stream) {
    this.ctx ??= new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    this.ctx.createMediaStreamSource(stream).connect(analyser); // not to the destination: <audio> plays it
    return analyser;
  }

  send(ev) {
    if (!this.closed && this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
  }

  // ---------- responses ----------

  // One response at a time: the server rejects a response.create while another is in flight.
  requestResponse(response) {
    if (this.closed) return;
    if (this.responding) { this.wantResponse = true; return; }
    this.responding = true;
    this.send(response ? { type: 'response.create', response } : { type: 'response.create' });
  }

  say(text) {
    this.requestResponse({ instructions: `Say exactly this, and nothing else: "${text}"` });
  }

  // ---------- server events ----------

  onServerEvent(ev) {
    switch (ev.type) {
      case 'response.created':
        this.responding = true;
        break;
      case 'response.done':
        this.responding = false;
        this.onResponseDone(ev.response);
        break;
      case 'output_audio_buffer.started':
        this.setMode('speaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.setMode('listening');
        break;
      case 'conversation.item.added': {
        const item = ev.item;
        const claude = item?.content?.[0]?.text?.startsWith?.('[CLAUDE]');
        if (item?.type === 'message' && item.role === 'user' && !claude) this.heardSinceSettle = true;
        break;
      }
      case 'input_audio_buffer.committed':
        // The person finished a turn: tool calls should quote this one, once it is transcribed.
        this.lastUser = { itemId: ev.item_id, transcript: null };
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(ev.transcript ?? '').trim();
        if (this.lastUser?.itemId === ev.item_id) this.lastUser.transcript = text;
        this.transcripts.get(ev.item_id)?.(text);
        this.transcripts.delete(ev.item_id);
        if (text) this.opts.onMessage?.({ source: 'user', message: text });
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        this.transcripts.get(ev.item_id)?.(null);
        this.transcripts.delete(ev.item_id);
        break;
      case 'response.output_audio_transcript.done':
        if (ev.transcript) this.opts.onMessage?.({ source: 'ai', message: ev.transcript });
        break;
      case 'error':
        // A response.create that raced a server-started response: send it again once that one is done.
        if (ev.error?.code === 'conversation_already_has_active_response') { this.wantResponse = true; break; }
        this.opts.onError?.(ev.error ?? ev);
        break;
    }
  }

  async onResponseDone(response) {
    const calls = (response?.output ?? []).filter((item) => item.type === 'function_call');
    if (calls.length) {
      // Hold other responses until the tool results are in the conversation.
      this.responding = true;
      for (const item of calls) await this.runTool(item);
      this.responding = false;
      this.wantResponse = false;
      return this.requestResponse();
    }
    if (this.wantResponse) {
      this.wantResponse = false;
      this.requestResponse();
    }
  }

  async runTool(item) {
    let args = {};
    try { args = JSON.parse(item.arguments || '{}'); } catch {}
    // The model hears audio, so its `quote` can drift into paraphrase. The transcript of the
    // person's last turn is their exact words, which is what the quote is meant to be.
    if (item.name === 'settle_answer') {
      const heard = await this.lastTranscript();
      if (heard) args.quote = heard;
    }
    // gpt-realtime tends to chain settle_answer straight into confirm_round, skipping the recap
    // prompt.md asks for. Only let the round go once the person has spoken since the last answer.
    // (Tapping Confirm, or the quiet timeout, still sends it without the model.)
    if (item.name === 'confirm_round' && !this.heardSinceSettle) {
      return this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: item.call_id, output: 'Not sent: the person has not confirmed yet. Give the one-sentence recap and ask whether to send it.' },
      });
    }
    if (item.name === 'settle_answer' || item.name === 'park_question') this.heardSinceSettle = false;
    let output;
    try {
      const tool = this.opts.clientTools?.[item.name];
      output = tool ? await tool(args) : `Unknown tool ${item.name}.`;
    } catch (err) {
      output = `Failed: ${err?.message || err}`;
    }
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: item.call_id, output: String(output ?? '') },
    });
  }

  lastTranscript() {
    const last = this.lastUser;
    if (!last) return Promise.resolve(null);
    if (last.transcript != null) return Promise.resolve(last.transcript);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), QUOTE_WAIT_MS);
      this.transcripts.set(last.itemId, (text) => { clearTimeout(timer); resolve(text); });
    });
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.opts.onModeChange?.({ mode });
  }

  // ---------- the slice of the ElevenLabs Conversation API that call.html uses ----------

  // `[CLAUDE] ...` frames arrive as user text; prompt.md tells the model they come from Claude Code.
  sendUserMessage(text) {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: String(text) }] },
    });
    this.requestResponse();
  }

  getInputByteFrequencyData() { return this.muted ? null : this.bins(this.inAnalyser); }
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

  teardown() {
    this.closed = true;
    for (const resolve of this.transcripts.values()) resolve(null);
    this.transcripts.clear();
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    if (this.audio) this.audio.srcObject = null;
    this.ctx?.close().catch(() => {});
  }

  async endSession() {
    if (this.closed) return;
    this.teardown();
    this.opts.onDisconnect?.();
  }
}
