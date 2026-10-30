import { fileOutcomeStore } from './outcome-store.ts';

// Test helper: `node outcome-store.worker.ts <dir> <worker id> <count>` appends <count> distinct records.
const [dir, id, count] = process.argv.slice(2);
if (dir === undefined || id === undefined || count === undefined) process.exit(2);
const store = fileOutcomeStore(dir);
for (let i = 0; i < Number(count); i += 1) {
  await store.append([{ v: 1, day: '2026-10-20', step: 'implement', provider: 'codex', model: 'gpt-a', effort: 'low', task: 'general', size: 'small', outcome: 'pass', seconds: Number(id) * 1000 + i }]);
}
