// Hotseat MCP server: Claude Code asks a round of questions, the user answers out loud in the call window.
// stdout is the MCP transport. Log only to stderr.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { apiKey, ensureAgent, stateDir } from './agent.mjs';

const root = new URL('../', import.meta.url);
const ms = (name, fallback) => Number(process.env[name]) || fallback;
const SSE_GRACE_MS = ms('HOTSEAT_SSE_GRACE_MS', 10_000);
const CONNECT_MS = ms('HOTSEAT_CONNECT_MS', 90_000);
const PROGRESS_MS = ms('HOTSEAT_PROGRESS_MS', 15_000);
const log = (...args) => console.error('hotseat:', ...args);

// Session state.
let lastRoundId = 0;
let round = null; // the open round, or null
let finished = false; // a round has finished since the last end_call
let ended = false;
const clients = new Set();
let graceTimer = null;
let connectTimer = null;
let httpUrl = null;
let agentReady = null; // ensureAgent() runs once per session, on the first call

// While the call is open and waiting for Claude's next round, a marker file keyed by the Claude Code
// process tells hooks/stop.mjs not to let Claude end its turn and leave the person in silence.
const WAITING = new URL(`waiting-${process.ppid}`, stateDir);
function setWaiting(on) {
  try {
    if (on) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(WAITING, '');
    } else rmSync(WAITING, { force: true });
  } catch (err) {
    log('waiting marker:', err.message);
  }
}
process.on('exit', () => setWaiting(false));

// SSE

function push(event, data = {}) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

const roundEvent = (r) => ({ roundId: r.id, topic: r.topic, round: r.round, questions: r.questions, context: r.context });

function onSseConnect(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': hotseat\n\n');
  clients.add(res);
  clearTimeout(graceTimer);
  clearTimeout(connectTimer);
  if (round) res.write(`event: round\ndata: ${JSON.stringify(roundEvent(round))}\n\n`);
  else if (finished && !ended) res.write('event: thinking\ndata: {}\n\n');
  req.on('close', () => {
    clients.delete(res);
    if (clients.size) return;
    if (!round) return void setTimeout(() => !clients.size && setWaiting(false), SSE_GRACE_MS);
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => !clients.size && finish('hung_up'), SSE_GRACE_MS);
  });
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000).unref();

// Rounds

function finish(status, note) {
  const r = round;
  if (!r) return;
  round = null;
  finished = true;
  clearTimeout(graceTimer);
  clearTimeout(connectTimer);
  clearInterval(r.progressTimer);
  if (status !== 'hung_up') push('thinking');
  const answers = r.questions.map(({ id }) => ({ id, status: 'unanswered', ...r.answers.get(id) }));
  // callOpen tells Claude to send the next round straight to this call instead of offering `v` again.
  const callOpen = status !== 'hung_up' && clients.size > 0;
  const result = { status, answers, callOpen, durationSec: Math.round((Date.now() - r.startedAt) / 1000) };
  if (note) result.note = note;
  setWaiting(callOpen);
  log(`round ${r.id} ${status}`);
  r.resolve(result);
}

function record(input, answer) {
  if (!round || input.roundId !== round.id) return [409, { error: 'That round is closed.' }];
  if (!round.questions.some((q) => q.id === input.questionId)) return [400, { error: `Unknown question ${input.questionId}.` }];
  round.answers.set(input.questionId, answer);
  round.last = input.questionId;
  if (round.answers.size === round.questions.length) {
    finish([...round.answers.values()].every((a) => a.status === 'settled') ? 'settled' : 'partial');
  }
  return [200, { ok: true }];
}

function progressMessage(r) {
  const all = [...r.answers.values()];
  const settled = all.filter((a) => a.status === 'settled').length;
  const parts = [`${settled}/${r.questions.length} settled`];
  if (all.length > settled) parts.push(`${all.length - settled} parked`);
  const last = r.answers.get(r.last);
  if (last) {
    const title = r.questions.find((q) => q.id === r.last).title || r.last;
    parts.push(`${title}: ${last.status === 'settled' ? last.answer : 'parked'}`);
  }
  return parts.join(' · ');
}

function validate(args) {
  const { topic, round: n, questions, context = '' } = args || {};
  if (typeof topic !== 'string' || !topic.trim()) return 'topic is required.';
  if (!Array.isArray(questions) || !questions.length) return 'questions must be a non-empty list.';
  const ids = new Set();
  for (const q of questions) {
    if (!q || typeof q.id !== 'string' || !q.id) return 'every question needs an id.';
    if (typeof q.question !== 'string' || !q.question.trim()) return `question ${q.id} has no text.`;
    if (ids.has(q.id)) return `duplicate question id ${q.id}.`;
    ids.add(q.id);
  }
  if (n !== undefined && !Number.isInteger(n)) return 'round must be an integer.';
  if (typeof context !== 'string') return 'context must be text.';
  return null;
}

async function askByVoice(args, extra) {
  if (round) return toolError('A voice round is still open. Wait for its result.');
  const problem = validate(args);
  if (problem) return toolError(problem);
  await startHttp();

  const result = await new Promise((resolve) => {
    round = {
      id: ++lastRoundId,
      topic: args.topic,
      round: args.round ?? lastRoundId,
      questions: args.questions.map(({ id, title = '', question, recommendation = '' }) => ({ id, title, question, recommendation })),
      context: (args.context || '').slice(0, 1500),
      answers: new Map(),
      startedAt: Date.now(),
      resolve,
    };
    finished = false;
    ended = false;
    setWaiting(false);
    log(`round ${round.id}: ${round.questions.length} questions`);

    const r = round;
    const token = extra._meta?.progressToken;
    if (token !== undefined) {
      let tick = 0;
      r.progressTimer = setInterval(() => {
        extra
          .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++tick, message: progressMessage(r) } })
          .catch((err) => log('progress failed:', err.message));
      }, PROGRESS_MS);
    }
    extra.signal.addEventListener('abort', () => round === r && finish('hung_up', 'cancelled'), { once: true });

    if (clients.size) push('round', roundEvent(round));
    else openWindow();
  });
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function endCall() {
  if (round) finish('hung_up', 'call ended');
  if (!ended) push('end');
  ended = true;
  setWaiting(false);
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
}

const toolError = (text) => ({ isError: true, content: [{ type: 'text', text }] });

// Window

function openWindow() {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => !clients.size && finish('hung_up', 'window never connected'), CONNECT_MS);
  if (process.env.HOTSEAT_NO_OPEN === '1') return;
  const [cmd, ...args] =
    process.platform === 'darwin' ? ['open', httpUrl]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', httpUrl]
    : ['xdg-open', httpUrl];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => log(`could not open the browser (${err.message}); open ${httpUrl}`));
  child.unref();
}

// HTTP

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const body = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_000) throw new Error('body too large');
  }
  return JSON.parse(raw || '{}');
};

const routes = {
  'GET /': async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(new URL('public/call.html', root)));
  },
  'GET /api/token': async (req, res) => {
    const key = apiKey();
    if (!key) return json(res, 500, { error: 'No ElevenLabs API key. Add it in /plugin under hotseat.' });
    agentReady ??= ensureAgent(key).catch((err) => {
      agentReady = null;
      log(err.message, err.detail ?? '');
      throw err;
    });
    let agentId;
    try {
      agentId = await agentReady;
    } catch (err) {
      const msg = err.status === 401 ? 'ElevenLabs rejected the API key.' : 'Could not set up the voice agent on ElevenLabs.';
      return json(res, 502, { error: msg });
    }
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { 'xi-api-key': key },
    });
    if (!r.ok) return json(res, 502, { error: `ElevenLabs token request failed (${r.status})` });
    const { token } = await r.json();
    json(res, 200, { token });
  },
  'GET /api/events': onSseConnect,
  'POST /api/call': async (req, res) => {
    const { live } = await body(req);
    log(live ? 'call live' : 'call stopped');
    json(res, 200, { ok: true });
  },
  'POST /api/settle': async (req, res) => {
    const input = await body(req);
    if (typeof input.answer !== 'string' || !input.answer.trim()) return json(res, 400, { error: 'answer is required.' });
    json(res, ...record(input, { status: 'settled', answer: input.answer, quote: String(input.quote ?? '') }));
  },
  'POST /api/park': async (req, res) => {
    const input = await body(req);
    json(res, ...record(input, { status: 'parked', reason: String(input.reason ?? '') }));
  },
  'POST /api/hangup': async (req, res) => {
    await body(req).catch(() => ({}));
    finish('hung_up');
    setWaiting(false);
    json(res, 200, { ok: true });
  },
};

let starting = null;
function startHttp() {
  starting ??= new Promise((resolve, reject) => {
    const http = createServer(async (req, res) => {
      const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
      if (!route) return json(res, 404, { error: 'not found' });
      try {
        await route(req, res);
      } catch (err) {
        if (!res.headersSent) json(res, 400, { error: err.message });
      }
    });
    http.on('error', reject);
    http.listen(0, '127.0.0.1', () => {
      httpUrl = `http://127.0.0.1:${http.address().port}`;
      log(httpUrl);
      resolve();
    });
  });
  return starting;
}

// MCP

const tools = [
  {
    name: 'ask_by_voice',
    description:
      'Ask the user a round of questions on a voice call. Opens the call window on first use and reuses it after. Resolves when every question is settled or parked, or the call ends.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'What is being decided, in a few words.' },
        round: { type: 'integer', description: 'Round number, starting at 1.' },
        questions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'q1, q2, ...' },
              title: { type: 'string', description: 'Two or three words.' },
              question: { type: 'string' },
              recommendation: { type: 'string', description: 'Your recommended answer, so "yes" accepts it.' },
            },
            required: ['id', 'question'],
          },
        },
        context: { type: 'string', description: 'Brief for the voice agent: glossary terms in play, facts already found. Plain text, at most 1500 characters.' },
      },
      required: ['topic', 'round', 'questions'],
    },
  },
  {
    name: 'end_call',
    description: 'Say goodbye and end the voice call. Call it when there is nothing left to ask.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server({ name: 'hotseat', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  if (name === 'ask_by_voice') return askByVoice(args, { ...extra, _meta: request.params._meta });
  if (name === 'end_call') return endCall();
  return toolError(`Unknown tool ${name}.`);
});
server.onclose = () => process.exit(0);
await server.connect(new StdioServerTransport());
