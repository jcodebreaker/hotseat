// Stop hook: if the person is still on a call waiting for the next round, don't let Claude end its turn
// in silence. The MCP server keeps .hotseat/waiting-<claude pid>; we look for it up our process ancestry.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let input = {};
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  input = JSON.parse(raw);
} catch {}

// One nudge per turn: if Claude already continued because of us, let it stop.
if (input.stop_hook_active || process.platform === 'win32') process.exit(0);

const root = new URL('../', import.meta.url);
let pid = process.ppid;
for (let i = 0; i < 6 && pid > 1; i++) {
  if (existsSync(new URL(`.hotseat/waiting-${pid}`, root))) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        'The user is still on the hotseat voice call, waiting in silence for the next round. ' +
        'Send your next questions through ask_by_voice now, or call end_call if nothing is left to ask.',
    }));
    break;
  }
  try {
    pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    break;
  }
}
