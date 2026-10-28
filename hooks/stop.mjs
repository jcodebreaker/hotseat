// Stop hook: if the person is still on a call waiting for the next round, don't let Claude end its turn
// in silence. The MCP server keeps waiting-<claude pid> in its state dir; we look for it up our process ancestry.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stateDir } from '../mcp/agent.mjs';

let input = {};
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  input = JSON.parse(raw);
} catch {}

// One nudge per turn: if Claude already continued because of us, let it stop.
if (input.stop_hook_active || process.platform === 'win32') process.exit(0);

let pid = process.ppid;
for (let i = 0; i < 6 && pid > 1; i++) {
  if (existsSync(new URL(`waiting-${pid}`, stateDir))) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        'The user is still on the hotseat voice call, waiting in silence for the next round. ' +
        'Send your next questions through ask_by_voice now, or call end_call if nothing is left to ask. ' +
        'If an ask_by_voice result is still on its way from a background task, wait for it instead.',
    }));
    break;
  }
  try {
    pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    break;
  }
}
