// Makes sure the user's ElevenLabs account has the Hotseat voice agent, matching prompt.md and this file.
// Creates it on first use, PATCHes it when the config changes, and remembers the ids in the state dir.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://api.elevenlabs.io/v1/convai';
const root = new URL('../', import.meta.url);

// Plugin installs keep state in CLAUDE_PLUGIN_DATA (survives updates); a plain checkout uses .hotseat/.
export const stateDir = process.env.CLAUDE_PLUGIN_DATA
  ? pathToFileURL(process.env.CLAUDE_PLUGIN_DATA.replace(/\/?$/, '/'))
  : new URL('.hotseat/', root);

// The key the plugin asked for at install (userConfig), else ELEVENLABS_API_KEY from a checkout's .env.
// An unset userConfig can arrive as the literal "${user_config...}" placeholder, so ignore that.
export function apiKey() {
  const fromConfig = process.env.HOTSEAT_ELEVENLABS_KEY;
  if (fromConfig && !fromConfig.startsWith('${')) return fromConfig;
  return process.env.ELEVENLABS_API_KEY || '';
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
  confirm_round: clientTool(
    'confirm_round',
    'Send the round to Claude once the person confirms the recap ("yes", "send it", "confirm", "looks good").',
    {},
  ),
};

async function agentConfig(toolIds) {
  return {
    name: 'Hotseat',
    conversation_config: {
      agent: {
        first_message: 'Hey, one sec, pulling up the questions.',
        language: 'en',
        prompt: {
          prompt: await readFile(new URL('prompt.md', root), 'utf8'),
          llm: process.env.HOTSEAT_LLM || 'claude-sonnet-5-5',
          temperature: 0.3,
          tool_ids: toolIds,
        },
      },
      // Claude can take minutes between rounds: don't re-engage ("are you still there?") or hang up on silence.
      turn: { turn_timeout: 300, silence_end_call_timeout: 1800 },
      conversation: { max_duration_seconds: 3600 },
      ...(process.env.HOTSEAT_VOICE_ID ? { tts: { voice_id: process.env.HOTSEAT_VOICE_ID } } : {}),
    },
  };
}

export async function ensureAgent(key) {
  const file = new URL('agent.json', stateDir);
  mkdirSync(stateDir, { recursive: true });
  // A checkout that ran the old `npm run setup` already has an agent: reuse it instead of making a second one.
  const legacy = new URL('.hotseat/agent.json', root);
  if (!existsSync(file) && existsSync(legacy) && legacy.href !== file.href) copyFileSync(legacy, file);

  const prev = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({}));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([tools, await agentConfig([])]))
    .digest('hex');
  if (prev.agentId && prev.fingerprint === fingerprint) return prev.agentId;

  const call = async (method, path, body) => {
    const res = await fetch(API + path, {
      method,
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`ElevenLabs ${method} ${path} failed (${res.status})`), { status: res.status, detail: text });
    return text ? JSON.parse(text) : {};
  };

  const toolIds = {};
  for (const [name, body] of Object.entries(tools)) {
    const id = prev.toolIds?.[name];
    const patched = id && (await call('PATCH', `/tools/${id}`, body).then(
      () => true,
      (err) => { if (err.status === 404) return false; throw err; },
    ));
    toolIds[name] = patched ? id : (await call('POST', '/tools', body)).id;
  }

  const config = await agentConfig(Object.values(toolIds));
  const agentId = prev.agentId
    ? await call('PATCH', `/agents/${prev.agentId}`, config).then(
        () => prev.agentId,
        async (err) => { if (err.status === 404) return (await call('POST', '/agents/create', config)).agent_id; throw err; },
      )
    : (await call('POST', '/agents/create', config)).agent_id;

  await writeFile(file, JSON.stringify({ agentId, toolIds, fingerprint }, null, 2) + '\n');
  if (prev.toolId) await call('DELETE', `/tools/${prev.toolId}`).catch(() => {}); // Day 1 define_term tool
  return agentId;
}
