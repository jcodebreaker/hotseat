// Creates (or updates) the Hotseat voice agent and its client tools on ElevenLabs.
// Run once, and again whenever prompt.md changes: `npm run setup`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.elevenlabs.io/v1/convai';
const STATE = new URL('./.hotseat/agent.json', import.meta.url);
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('Set ELEVENLABS_API_KEY in .env (copy .env.example).');
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}\n${text}`), { status: res.status });
  return text ? JSON.parse(text) : {};
}

const clientTool = (name, description, properties) => ({
  tool_config: {
    type: 'client',
    name,
    description,
    expects_response: true,
    response_timeout_secs: 10,
    parameters: { type: 'object', properties, required: Object.keys(properties) },
  },
});

const questionId = { type: 'string', description: 'The id of the question from the current round, such as q1.' };

const tools = {
  settle_answer: clientTool(
    'settle_answer',
    'Record the answer to one question once it is unambiguous, before asking the next one. Call it again for the same question to replace the answer ("go back").',
    {
      question_id: questionId,
      answer: { type: 'string', description: 'The decision in one plain sentence.' },
      quote: { type: 'string', description: "The person's exact words that settled it, verbatim." },
    },
  ),
  park_question: clientTool(
    'park_question',
    'Set one question aside when the person says park it, skip, or later.',
    {
      question_id: questionId,
      reason: { type: 'string', description: "Why it is parked, in the person's words." },
    },
  ),
};

const prev = await readFile(STATE, 'utf8').then(JSON.parse).catch(() => ({}));
const prevIds = prev.toolIds ?? {};

const toolIds = {};
for (const [name, body] of Object.entries(tools)) {
  const id = prevIds[name];
  const patched = id && (await call('PATCH', `/tools/${id}`, body).then(
    () => true,
    (err) => { if (err.status === 404) return false; throw err; },
  ));
  toolIds[name] = patched ? id : (await call('POST', '/tools', body)).id;
}

const agent = {
  name: 'Hotseat',
  conversation_config: {
    agent: {
      first_message: 'Hey, one sec, pulling up the questions.',
      language: 'en',
      prompt: {
        prompt: await readFile(new URL('./prompt.md', import.meta.url), 'utf8'),
        llm: process.env.HOTSEAT_LLM || 'claude-sonnet-5-5',
        temperature: 0.3,
        tool_ids: Object.values(toolIds),
      },
    },
    // Claude can take minutes between rounds: don't re-engage ("are you still there?") or hang up on silence.
    turn: { turn_timeout: 300, silence_end_call_timeout: 1800 },
    conversation: { max_duration_seconds: 3600 },
    ...(process.env.HOTSEAT_VOICE_ID ? { tts: { voice_id: process.env.HOTSEAT_VOICE_ID } } : {}),
  },
};

const agentId = prev.agentId
  ? await call('PATCH', `/agents/${prev.agentId}`, agent).then(() => prev.agentId)
  : (await call('POST', '/agents/create', agent)).agent_id;

await mkdir(new URL('./.hotseat/', import.meta.url), { recursive: true });
await writeFile(STATE, JSON.stringify({ agentId, toolIds }, null, 2) + '\n');

// Day 1 state had a single define_term tool; the agent no longer references it.
if (prev.toolId) {
  await call('DELETE', `/tools/${prev.toolId}`).catch((err) => {
    if (err.status !== 404) console.error(`Could not delete old tool ${prev.toolId}: ${err.message}`);
  });
}

console.log(`${prev.agentId ? 'Updated' : 'Created'} agent ${agentId}. Next: claude --plugin-dir ${new URL('.', import.meta.url).pathname}`);
