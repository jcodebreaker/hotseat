// OpenAI Realtime engine, server side: mints a short-lived client secret for the call window.
// OpenAI keeps no saved agent, so the whole session (prompt.md, tools, voice) goes into each secret.
import { readFile } from 'node:fs/promises';
import { tools } from './agent.mjs';

const root = new URL('../', import.meta.url);
const clean = (v) => (v && !v.startsWith('${') ? v.trim() : '');

// The key the plugin asked for at install (userConfig), else OPENAI_API_KEY from a checkout's .env.
export function openaiKey() {
  return clean(process.env.HOTSEAT_OPENAI_KEY) || clean(process.env.OPENAI_API_KEY);
}

// Same tools as the ElevenLabs agent, in the Realtime function shape.
const functionTools = Object.values(tools).map(({ tool_config: t }) => ({
  type: 'function',
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

export async function sessionConfig(setting) {
  return {
    type: 'realtime',
    model: setting('HOTSEAT_REALTIME_MODEL') || 'gpt-realtime-2.1',
    instructions: await readFile(new URL('prompt.md', root), 'utf8'),
    audio: {
      input: {
        // semantic_vad waits for the person to finish a thought and never nudges on silence,
        // which matters while Claude works between rounds.
        turn_detection: { type: 'semantic_vad', create_response: true, interrupt_response: true },
        transcription: { model: setting('HOTSEAT_REALTIME_STT_MODEL') || 'gpt-live-transcribe' },
        noise_reduction: { type: 'near_field' },
      },
      output: { voice: setting('HOTSEAT_REALTIME_VOICE') || 'marin' },
    },
    tools: functionTools,
    tool_choice: 'auto',
  };
}

export async function clientSecret(key, setting) {
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session: await sessionConfig(setting) }),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`OpenAI client secret failed (${res.status})`), { status: res.status, detail: text });
  return JSON.parse(text).value;
}
