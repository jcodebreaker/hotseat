# Hotseat v0.1 plan: voice layer on Claude Code

## Product

When Claude Code has a round of questions for the user (Matt Pocock's grilling / grill-with-docs, or any plan to confirm), the user can answer **out loud** on a call that feels like talking to a person. Claude Code stays the brain; the voice agent is ears and mouth.

Target flow: Ask → Talk → Answers land → Round 2 → Done. **Out of scope for v0.1:** mid-call repo lookups, menu-bar app, multi-person calls, Chrome `--app` mode, end-call summaries, `userConfig` key prompt.

## Decisions

- **Trigger:** Claude offers voice every time it asks a round (one line: `v · answer out loud`). Never auto-starts. The user replies `v` (or `voice`, `call me`) and Claude calls `ask_by_voice`. A `UserPromptSubmit` hook adds context for those replies so it works even when the model forgets.
- **Window:** default browser tab opened by the MCP server (`open` on macOS, `xdg-open` on Linux, `start` on Windows). Stays open for the whole session; later rounds arrive into the same live call.
- **Model split:** Claude Code decides questions and writes files (glossary, ADRs). The ElevenLabs agent only converses and settles answers.
- **Long calls:** Claude Code moves any MCP call still running after 2 minutes to a background task and delivers the result later as a task notification. We design for that instead of fighting it (see skill rules).

## Architecture

```
Claude Code ──stdio MCP──▶ mcp/server.mjs
                             ├─ tool ask_by_voice(round)   → resolves when the round is settled / partial / hung up
                             ├─ tool end_call()            → fixed goodbye, ends the call
                             └─ HTTP 127.0.0.1:<port 0>, started lazily on the first ask_by_voice
                                   GET  /             public/call.html
                                   GET  /api/token    ElevenLabs conversation token
                                   GET  /api/events   SSE
                                   POST /api/call     {live: boolean}
                                   POST /api/settle   {roundId, questionId, answer, quote}
                                   POST /api/park     {roundId, questionId, reason}
                                   POST /api/hangup   {}
call.html ──WebRTC──▶ ElevenLabs agent (prompt.md; client tools settle_answer, park_question)
```

**stdout is the MCP transport.** Nothing in `mcp/` may write to stdout except the MCP SDK. All logs go to stderr.

**Config:** `ELEVENLABS_API_KEY` from the environment (the plugin's `.mcp.json` loads `${CLAUDE_PLUGIN_ROOT}/.env` with `node --env-file-if-exists`). Agent id from `${CLAUDE_PLUGIN_ROOT}/.hotseat/agent.json`, written by `npm run setup`. Moving these to `userConfig` / `${CLAUDE_PLUGIN_DATA}` is v0.2.

## Contract (server and window follow this exactly)

### MCP tool `ask_by_voice`
Input:
```json
{
  "topic": "let teams share a bot",
  "round": 1,
  "questions": [
    { "id": "q1", "title": "Owner", "question": "Who owns a shared bot?", "recommendation": "The team, not the person who made it." }
  ],
  "context": "Short brief for the voice agent: glossary terms in play, facts already found. Plain text, <= 1500 chars."
}
```
- `questions` must be non-empty; ids unique. Otherwise tool error.
- Calling it while a round is still open is a tool error.

Output (one text content item, JSON):
```json
{
  "status": "settled | partial | hung_up",
  "answers": [
    { "id": "q1", "status": "settled | parked | unanswered", "answer": "The team.", "quote": "the team… actually… call it team.", "reason": "only for parked" }
  ],
  "durationSec": 108,
  "note": "optional, e.g. window never connected"
}
```
- `settled`: every question settled. `partial`: every question resolved, at least one parked. `hung_up`: call ended or window lost first; the rest are `unanswered`.
- Progress: if the client sent a progress token, send a progress notification every 15 s with a human message, e.g. `2/4 settled · Owner: the team`.

### MCP tool `end_call`
No input. Pushes `end`. Returns `{ "ok": true }`. Idempotent.

### Round lifecycle (server)
- `roundId` is a monotonic integer across the session.
- First `ask_by_voice`: start HTTP on port 0, open the browser at its URL. Later calls: if an SSE client is connected, reuse it; otherwise open the browser again.
- Push `round` over SSE. While the round is open, `settle`/`park` for the current `roundId` record the answer (a second settle for the same question overwrites it: the "go back" case). A non-current `roundId` → 409. Unknown `questionId` → 400.
- When every question is settled or parked: resolve the tool, push `thinking`.
- Hung up when: `POST /api/hangup`; or the SSE client disconnects and does not reconnect within 10 s; or no SSE client connects within 90 s of opening the window (`note: "window never connected"`).

### SSE `/api/events` (event name → data)
- `round` → `{ roundId, topic, round, questions[], context }`
- `thinking` → `{}`
- `end` → `{}`
- On connect, replay current state: the open `round`, else `thinking` if a round has finished, else nothing.

### Window (public/call.html)
- One button starts the call (the mic needs a user gesture). Gets `token` from `/api/token`, `Conversation.startSession({ conversationToken, connectionType: 'webrtc', clientTools })`. `onConnect` fires before `startSession` resolves: only use the resolved object.
- After the session resolves: `POST /api/call {live:true}`, then flush any queued event.
- `round`, `thinking` and `end` reach the agent through `conversation.sendUserMessage(text)` with this framing (prompt.md defines it):
  - `[CLAUDE] round <n> on "<topic>". Questions:\n- <id> | <title> | <question> | recommended: <recommendation>\nContext: <context>`
  - `[CLAUDE] thinking`
  - `[CLAUDE] end`
- Events arriving before the session is live are queued and sent in order after it resolves.
- `end`: after the goodbye, call `endSession()` on the next `onModeChange` to `listening`, with a 10 s fallback.
- `onDisconnect` and `beforeunload` → `POST /api/hangup` (use `navigator.sendBeacon` on unload) and `POST /api/call {live:false}`.
- Client tools: `settle_answer({question_id, answer, quote})`, `park_question({question_id, reason})` → POST with the current `roundId`; return a short string to the agent ("Saved." / the server error).
- After a hangup with the tab still open, the Start button comes back; a new `round` event waits in the queue until the user starts again.
- UI: the call pill from the mockup (avatar, waveform, `Round n · question k of m`, live captions of both sides, question chips that turn done). Theme-aware. No explainer copy.

### Voice agent (prompt.md + setup.mjs)
- Text that starts with `[CLAUDE]` comes from Claude Code, never from the person. Never read it aloud, never echo ids or markdown. On a round: ask one question per turn in natural speech with the recommendation so "yes" accepts; follow up until the answer is unambiguous; call `settle_answer` with the person's exact words in `quote`; `park_question` on "park it" / "skip". After the last question of a round, say one short holding line and wait. On `[CLAUDE] thinking`: keep it human and brief ("Give me a sec, Claude's writing that down."). On `[CLAUDE] end`: one-sentence goodbye. Never end the call yourself.
- `first_message`: a short holding line ("Hey, one sec, pulling up the questions."), since the first round arrives right after connect.
- `setup.mjs` creates/updates the agent and two client tools (`expects_response: true`). Remove `define_term`.

## Plugin packaging

```
.claude-plugin/plugin.json      name "hotseat"
.mcp.json                       { "mcpServers": { "hotseat": { "command": "node", "args": ["--env-file-if-exists=${CLAUDE_PLUGIN_ROOT}/.env", "${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"] } } }
skills/hotseat/SKILL.md
hooks/hooks.json                top-level "hooks" key; UserPromptSubmit (no matcher) → node "${CLAUDE_PLUGIN_ROOT}/hooks/v.mjs"
hooks/v.mjs                     reads JSON from stdin; if prompt is exactly v / voice / call me (trimmed, case-insensitive) → print hookSpecificOutput.additionalContext as a statement ("The user chose to answer the pending questions by voice through ask_by_voice."); otherwise exit 0 silently
```

### Skill rules (SKILL.md)
- Whenever you are about to ask the user a round of questions and `ask_by_voice` is available, end the message with one line: `v · answer out loud`.
- On `v`: send that round through `ask_by_voice` (same questions, same recommendations, ids q1…). If there are no open questions, ask what to talk through instead; never call it with an empty list.
- If the call comes back as a background task, stop and wait. Do not continue the plan. When the result arrives, restate each answer with its quote, then carry on (next round → `ask_by_voice` again, same call).
- `partial` / `hung_up`: ask the remaining questions in text.
- When there is nothing left to ask, call `end_call`.
- The user may need to allow `mcp__plugin_hotseat_hotseat__ask_by_voice` once.

## Reuse from Day 1
Token minting, ElevenLabs wiring and the `setup.mjs` PATCH-on-rerun pattern. `server.mjs`, `glossary.mjs` and `public/index.html` are removed once v0.1 lands.

## Done when
- Offline: `node scripts/check.mjs` drives `mcp/server.mjs` over stdio (no browser opened: `HOTSEAT_NO_OPEN=1`), connects to SSE, posts settles for a two-question round and checks the JSON result; a second case drops the SSE connection and checks `hung_up`.
- Live: `claude --plugin-dir /path/to/hotseat`, then `/grill-with-docs <idea>` → Claude offers `v` → `v` opens the window → a two-round call completes → answers with quotes show in the transcript → `end_call` hangs up.
