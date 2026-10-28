// UserPromptSubmit hook: when the user replies "v", "voice" or "call me", tell Claude
// they want to answer by voice. Every other prompt: exit 0 with no output.
let input = '';
for await (const chunk of process.stdin) input += chunk;

let prompt = '';
try {
  prompt = String(JSON.parse(input).prompt ?? '').trim().toLowerCase();
} catch {}

if (['v', 'voice', 'call me'].includes(prompt)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'The user chose to answer the pending questions by voice through ask_by_voice.',
    },
  }));
}
