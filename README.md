<p align="center">
  <img alt="hotseat: Claude asks. You answer out loud." src="docs/img/og.png">
</p>

<h1 align="center">hotseat</h1>

<p align="center">A voice layer for Claude Code. When Claude has questions for you, answer them out loud on a call, and your exact words land back in the session.</p>

## See it

<p align="center">
  <a href="docs/img/demo.mp4"><img alt="31-second walkthrough: Claude asks a round, you reply v, a call opens, you answer by voice, the answers land in Claude Code, and the next round goes straight into the same call" src="docs/img/demo.gif"></a>
</p>
<p align="center"><sub>31 seconds, no sound. <a href="docs/img/demo.mp4">MP4 version</a>.</sub></p>

## How it works

1. **Claude asks a round of questions.** Grilling a plan, confirming a spec, anything with a recommendation per question. Hotseat adds one line at the end: `v · answer out loud`.
2. **Reply `v`.** A call window opens next to your terminal. Press **Pick up**.
3. **Talk it through.** A voice agent asks each question with Claude's recommendation, so "yes" accepts it. Say "you decide", "park it" or "go back" whenever you need to. Interrupt it like you would a person.
4. **Check, then send.** After the last question the window shows just your answers. Say "send it" or tap **Confirm**, or tap an answer to change it. Quiet for 20 seconds sends it as is.
5. **Your answers land in Claude Code** with the words you actually said, so nothing gets paraphrased away. Claude keeps going: glossary, ADRs, the next question.
6. **The next round goes straight into the same call.** No second `v`. Claude hangs up when nothing is left to ask.

Claude stays the brain: it picks the questions, reads the repo and writes the files. The voice agent is only ears and mouth.

## The call window

<p>
  <img alt="Live call: on-air light, spectrogram of both voices, the question being asked in full with Claude's suggestion, and a ledger of the round with your quotes" src="docs/img/call-light.png" width="49.5%">
  <img alt="Between rounds, in dark mode: amber light while Claude works, settled and parked answers in the ledger" src="docs/img/call-dark.png" width="49.5%">
</p>

- **On air.** A red light and a call timer while you talk, amber while Claude works on your answers.
- **Spectrogram.** Sixteen bands drawn from the call's real audio, ink for Claude and blue for you, so you can see who's talking and when.
- **The question in full,** with Claude's suggested answer under it and the last thing each side said.
- **A ledger of the round.** Settled answers keep your quote, parked ones keep the reason.

Built for Matt Pocock's [grilling and grill-with-docs skills](https://github.com/mattpocock/skills) (MIT), and it works for any round of questions.

## Install

In Claude Code:

```
/plugin marketplace add jcodebreaker/hotseat
/plugin install hotseat@hotseat
```

Paste your [ElevenLabs API key](https://elevenlabs.io/app/settings/api-keys) when asked (it's stored in your system keychain), then run `/reload-plugins`. On the first call hotseat creates its voice agent in your ElevenLabs account. Needs Node 22.9 or later. No ElevenLabs key? Skip it and use the [local voice](#local-voice-no-elevenlabs).

Try it: `/grill-with-docs <your idea>`, then reply `v`.

Claude Code moves a tool call that runs longer than 2 minutes to a background task. That's expected: Claude waits, and the answers arrive when the round is done.

## Local voice (no ElevenLabs)

Hotseat can run the whole call in the call window, on your machine, with no account and no per-minute cost:

- **Kokoro-82M** speaks ([kokoro-js](https://github.com/hexgrad/kokoro), WebGPU when available, else WASM).
- **Whisper** listens ([transformers.js](https://github.com/huggingface/transformers.js), `whisper-base.en` by default), with a simple energy-based turn detector. Talk over it to interrupt.
- A small rule-based interviewer stands in for the ElevenLabs agent. It follows the same rules as `prompt.md`: one question at a time, "yes" takes the recommendation, "you decide", "park it", "go back", "say that again", a recap, then "send it". Anything else is recorded as your answer in your own words, and Claude reads it.

Pick it in `/plugin` under hotseat by setting **Voice engine** to `local` (or leave the ElevenLabs key empty), or put `HOTSEAT_ENGINE=local` in a checkout's `.env`. The first call downloads about 170 MB of models from Hugging Face; the browser caches them, so later calls load in seconds and run offline. The call window always uses port 47817 so that cache sticks.

Trade-off: the local interviewer doesn't understand free-form talk the way an LLM agent does. It won't ask follow-ups on vague answers; it records them and leaves the reading to Claude.

## OpenAI Realtime

Hotseat can also run the call on [OpenAI Realtime](https://platform.openai.com/docs/guides/realtime) (`gpt-realtime-2.1`). Paste an OpenAI API key in `/plugin` under hotseat and set **Voice engine** to `openai`, or put `HOTSEAT_ENGINE=openai` and `OPENAI_API_KEY=...` in a checkout's `.env`.

- Nothing to create in your account: each call gets a short-lived client secret carrying `prompt.md`, the tools and the voice. Your API key stays in the server process.
- The browser talks to OpenAI over WebRTC. Interrupting uses OpenAI's `semantic_vad`.
- Quotes come from OpenAI's transcription of your last turn, not from the model's retelling, so your exact words still reach Claude.
- Optional: `HOTSEAT_REALTIME_MODEL`, `HOTSEAT_REALTIME_VOICE` (default `marin`), `HOTSEAT_REALTIME_STT_MODEL` (default `gpt-live-transcribe`).

Trade-off: the agent thinks with OpenAI's realtime model instead of Claude (`HOTSEAT_LLM` only applies to ElevenLabs). Billing is per audio token.

## Under the hood

```
Claude Code ──stdio MCP──▶ mcp/server.mjs   ask_by_voice(round), end_call()
                              │ HTTP on 127.0.0.1, random port
                              ▼
                         public/call.html ──WebRTC──▶ ElevenLabs agent or OpenAI Realtime (prompt.md)
                              ▲                            │
                              └── settle_answer / park_question (client tools)
```

- **`skills/hotseat`** tells Claude when to offer voice and how to use the answers. **`hooks/v.mjs`** catches a bare `v` reply, so it works even when Claude forgets.
- **`hooks/stop.mjs`** won't let Claude end its turn while you're on the call waiting: it has to send the next round or hang up. No silent calls.
- **`mcp/agent.mjs`** creates the voice agent and its two tools on the first call, and updates them whenever `prompt.md` changes.
- **The call window** is plain HTML with no build step: OKLCH tokens, Newsreader and IBM Plex, light and dark.

## Privacy

- The local server listens on `127.0.0.1` only. Your API key stays in the server process and never reaches the browser, which gets a short-lived conversation token instead.
- Call audio and the round's questions go to ElevenLabs or OpenAI, whichever runs the voice agent. The call window loads the ElevenLabs SDK from jsDelivr and its fonts from Google Fonts. hotseat has no server of its own.

## Develop

```sh
git clone https://github.com/jcodebreaker/hotseat && cd hotseat
npm install
cp .env.example .env            # ELEVENLABS_API_KEY=...
claude --plugin-dir .
npm run check                   # offline check of the MCP round lifecycle
```

## Roadmap

- [ ] Mid-call lookups: "Claude's checking…" while a sub-agent reads the repo, without leaving the call
- [ ] A menu-bar call window instead of a browser tab
- [x] OpenAI Realtime behind the same contract
- [ ] More voice providers
- [ ] Grill a diff or a PR, not only an idea

MIT.
