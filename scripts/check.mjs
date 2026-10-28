// Offline check: drive mcp/server.mjs over stdio, answer a round through the HTTP API, then drop the window.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))],
  env: {
    ...process.env,
    HOTSEAT_NO_OPEN: '1',
    ELEVENLABS_API_KEY: 'fake-key',
    HOTSEAT_SSE_GRACE_MS: '500',
    HOTSEAT_PROGRESS_MS: '100',
    HOTSEAT_REVIEW_MS: '5000',
  },
  stderr: 'pipe',
});
const port = new Promise((resolve) => {
  let buf = '';
  transport.stderr.on('data', (chunk) => {
    buf += chunk;
    const m = buf.match(/hotseat: http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) resolve(Number(m[1]));
  });
});
const client = new Client({ name: 'hotseat-check', version: '0.0.0' });
await client.connect(transport);

const questions = [
  { id: 'q1', title: 'Owner', question: 'Who owns a shared bot?', recommendation: 'The team.' },
  { id: 'q2', title: 'Limit', question: 'How many teams can share one?', recommendation: 'One.' },
];
const ask = (round, onprogress) =>
  client.callTool({ name: 'ask_by_voice', arguments: { topic: 'share a bot', round, questions, context: 'none' } }, undefined, { onprogress });
const result = (res) => JSON.parse(res.content[0].text);

// Read SSE events into a queue; next() waits for the next one.
function sse(base) {
  const ctrl = new AbortController();
  const events = [];
  let wake = () => {};
  (async () => {
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    let buf = '';
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = frame.match(/^event: (.*)$/m)?.[1];
        if (event) events.push({ event, data: JSON.parse(frame.match(/^data: (.*)$/m)[1]) });
        wake();
      }
    }
  })().catch(() => {});
  const next = async () => {
    while (!events.length) await new Promise((r) => (wake = r));
    return events.shift();
  };
  return { next, close: () => ctrl.abort() };
}
const post = (base, path, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref());

await step('rejects an empty round', async () => {
  const res = await client.callTool({ name: 'ask_by_voice', arguments: { topic: 't', round: 1, questions: [] } });
  assert.equal(res.isError, true);
});

await step('settles a two-question round', async () => {
  const progress = [];
  const pending = ask(1, (p) => progress.push(p));
  const base = `http://127.0.0.1:${await Promise.race([port, timeout(5000)])}`;
  const events = sse(base);
  const { event, data } = await events.next();
  assert.equal(event, 'round');
  assert.equal(data.roundId, 1);
  assert.deepEqual(data.questions.map((q) => q.id), ['q1', 'q2']);

  const second = await client.callTool({ name: 'ask_by_voice', arguments: { topic: 't', round: 2, questions } });
  assert.equal(second.isError, true, 'a second ask while open is an error');
  assert.equal((await post(base, '/api/settle', { roundId: 9, questionId: 'q1', answer: 'x' })).status, 409);
  assert.equal((await post(base, '/api/settle', { roundId: 1, questionId: 'q9', answer: 'x' })).status, 400);

  assert.equal((await post(base, '/api/settle', { roundId: 1, questionId: 'q1', answer: 'The person.', quote: 'me' })).status, 200);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await post(base, '/api/settle', { roundId: 1, questionId: 'q1', answer: 'The team.', quote: 'the team… actually… call it team.' })).status, 200);
  assert.equal((await post(base, '/api/confirm', { roundId: 1 })).status, 409, 'nothing to confirm before the last answer');
  assert.equal((await post(base, '/api/settle', { roundId: 1, questionId: 'q2', answer: 'One.', quote: 'just one' })).status, 200);

  // Every question has an answer: the round waits for the person to check it.
  const check = await events.next();
  assert.equal(check.event, 'review');
  assert.equal(check.data.roundId, 1);
  let resolved = false;
  pending.then(() => (resolved = true));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(resolved, false, 'not sent before confirm');
  // A late "go back" still lands, and restarts the check.
  assert.equal((await post(base, '/api/settle', { roundId: 1, questionId: 'q2', answer: 'Two.', quote: 'make it two' })).status, 200);
  assert.equal((await events.next()).event, 'review');
  assert.equal((await post(base, '/api/hold', { roundId: 1 })).status, 200);
  assert.equal((await events.next()).event, 'review');
  assert.equal((await post(base, '/api/confirm', { roundId: 1 })).status, 200);

  const out = result(await Promise.race([pending, timeout(5000)]));
  assert.equal(out.status, 'settled');
  assert.deepEqual(out.answers, [
    { id: 'q1', status: 'settled', answer: 'The team.', quote: 'the team… actually… call it team.' },
    { id: 'q2', status: 'settled', answer: 'Two.', quote: 'make it two' },
  ]);
  assert.equal((await post(base, '/api/confirm', { roundId: 1 })).status, 409, 'confirm twice');
  assert.equal(typeof out.durationSec, 'number');
  assert.equal((await events.next()).event, 'thinking');
  assert.ok(progress.some((p) => p.message?.startsWith('1/2 settled · Owner: The person.')), 'progress message');
  assert.equal((await post(base, '/api/settle', { roundId: 1, questionId: 'q1', answer: 'late' })).status, 409);
  events.close();
});

await step('hangs up when the window drops', async () => {
  const base = `http://127.0.0.1:${await port}`;
  const events = sse(base);
  assert.equal((await events.next()).event, 'thinking', 'replays thinking on connect');
  const pending = ask(2);
  const { event, data } = await events.next();
  assert.equal(event, 'round');
  assert.equal(data.roundId, 2);
  assert.equal((await post(base, '/api/park', { roundId: 2, questionId: 'q2', reason: 'skip' })).status, 200);
  events.close();

  const out = result(await Promise.race([pending, timeout(5000)]));
  assert.equal(out.status, 'hung_up');
  assert.deepEqual(out.answers, [
    { id: 'q1', status: 'unanswered' },
    { id: 'q2', status: 'parked', reason: 'skip' },
  ]);
});

await step('end_call is idempotent', async () => {
  assert.deepEqual(result(await client.callTool({ name: 'end_call', arguments: {} })), { ok: true });
  assert.deepEqual(result(await client.callTool({ name: 'end_call', arguments: {} })), { ok: true });
});

await client.close();
process.exit(failed ? 1 : 0);
