# hotseat

A Claude Code plugin that lets you answer Claude's questions out loud. When Claude asks you a round of questions, reply `v` and a voice call opens in your browser. A voice agent asks each question with Claude's recommendation (say "yes" to accept), and your answers, with your exact words, land back in the Claude Code transcript. Claude stays the brain and writes the files; the voice agent is only ears and mouth.

Built for Matt Pocock's [grilling and grill-with-docs skills](https://github.com/mattpocock/skills) (MIT), but it works for any round of questions.

## Install

In Claude Code:

```
/plugin marketplace add jcodebreaker/hotseat
/plugin install hotseat@hotseat
```

Paste your [ElevenLabs API key](https://elevenlabs.io/app/settings/api-keys) when asked (it goes to your system keychain), then `/reload-plugins`. On the first call Hotseat creates its voice agent in your ElevenLabs account; nothing else to set up. Needs Node 22.9 or later.

## Use

1. Run `/grill-with-docs <idea>` (or anything that makes Claude ask you questions).
2. Claude ends the round with `v · answer out loud`. Reply `v`.
3. Press start in the tab that opens and talk. Say "you decide", "park it" or "go back" when you need to.
4. Later rounds arrive in the same call. Claude hangs up when nothing is left to ask.

Claude Code moves a tool call that runs longer than 2 minutes to a background task. That is expected: Claude waits, and the answers arrive as a task notification when the round is done.

## How it works

```
Claude Code ──stdio MCP──▶ mcp/server.mjs   ask_by_voice(round), end_call()
                              │ HTTP on 127.0.0.1, random port
                              ▼
                         public/call.html ──WebRTC──▶ ElevenLabs agent (prompt.md)
                              ▲                            │
                              └── settle_answer / park_question (client tools)
```

- `skills/hotseat` tells Claude to offer voice and how to use the results; `hooks/v.mjs` flags a `v` reply so it works even if Claude forgets.
- `hooks/stop.mjs` stops Claude from ending its turn while you're on the call waiting for the next round: it has to send the round or hang up.
- The MCP server mints a conversation token, so your API key never leaves your machine.
- `mcp/agent.mjs` creates the voice agent and its two client tools on the first call, and updates them when `prompt.md` changes.


## Develop

```sh
git clone https://github.com/jcodebreaker/hotseat && cd hotseat
npm install
cp .env.example .env            # ELEVENLABS_API_KEY=...
claude --plugin-dir .
npm run check                   # offline check of the MCP round lifecycle
```
