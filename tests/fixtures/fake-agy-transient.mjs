// First model turn fails with the observed agy 503; probes and later turns use the normal fake.
import fs from 'node:fs';
if (['--version', 'models'].includes(process.argv[2])) {
  await import('./fake-agy.mjs');
} else {
  const log = process.env.COUNCIL_FAKE_TRANSIENT_LOG;
  if (!log) throw new Error('COUNCIL_FAKE_TRANSIENT_LOG required');
  fs.appendFileSync(log, JSON.stringify({ at: Date.now(), args: process.argv.slice(2) }) + '\n', 'utf8');
  const turns = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  if (turns > 1 && process.env.COUNCIL_FAKE_TRANSIENT_ALWAYS !== '1') {
    await import('./fake-agy.mjs');
  } else {
    const at = process.argv.indexOf('--conversation');
    const id = at >= 0 ? process.argv[at + 1] : '11111111-1111-4111-8111-111111111111';
    if (process.env.COUNCIL_FAKE_TRANSIENT_PARTIAL === '1') process.stdout.write(JSON.stringify({
      event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: process.env.COUNCIL_FAKE_TRANSIENT_PARTIAL_TEXT || 'partial answer' },
    }) + '\n');
    // COUNCIL_FAKE_TRANSIENT_NO_ID=1: the 503 arrives before anything names the conversation.
    const named = process.env.COUNCIL_FAKE_TRANSIENT_NO_ID !== '1';
    for (const event of [
      ...(named ? [{ event: 'init', conversation_id: id }] : []),
      { event: 'result', result: {
        ...(named ? { conversation_id: id } : {}), status: 'ERROR', response: '', num_turns: 1, finished_reason: 'error',
        error: 'API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      } },
    ]) process.stdout.write(JSON.stringify(event) + '\n');
    process.exitCode = 1;
  }
}
