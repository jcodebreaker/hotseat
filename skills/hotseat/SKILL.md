---
name: hotseat
description: Lets the user answer a round of questions out loud on a voice call through the ask_by_voice tool. Use whenever you are about to ask the user a round of questions (grilling, grill-with-docs, confirming a plan), and when the user replies "v", "voice" or "call me".
---

# Hotseat

`ask_by_voice` puts a round of questions to the user on a live voice call and returns their answers with quotes. You still own the questions, the plan and every file; the call only collects answers.

## Offer voice

Whenever you ask the user a round of questions, `ask_by_voice` is available, and no call is open, end the message with exactly this line:

```
v · answer out loud
```

Never start a call unprompted.

## On `v`

1. Send the round you just asked through `ask_by_voice`: same questions, same recommendations, ids `q1`, `q2`, … in order. Put the glossary terms in play and facts you already found into `context` (plain text, under 1500 chars).
2. If no questions are open, ask in text what they want to talk through. Never call `ask_by_voice` with an empty list.

## While the call runs

- If the call moves to a background task, stop and wait for its result. Do not continue the plan, edit files or ask anything else.
- When the result arrives, restate each answer with its quote, then carry on with the work those answers unlock.
- If the result has `callOpen: true`, the user is still on the call, waiting. Send the next round straight through `ask_by_voice`: do not offer `v` and do not wait for a reply. Show the round in text too, so the transcript keeps it, and say it went to the call.
- Keep the gap short: run lookups for the next round in parallel, then call `ask_by_voice`. The user is listening to silence meanwhile.

## Results

- `settled`: use the answers.
- `partial`: use the settled answers; ask the parked ones in text, with the reason the user gave.
- `hung_up`: use what was settled; ask the `unanswered` ones in text.

## Ending

When nothing is left to ask, call `end_call`.

The first call may need permission for `mcp__plugin_hotseat_hotseat__ask_by_voice`; tell the user they can allow it once.
