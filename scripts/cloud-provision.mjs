import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const bin = path.resolve('node_modules/wrangler/bin/wrangler.js');
const exec = (args, capture = false) =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });

const json = (args) => {
  const result = exec([...args, '--json'], true);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout || '[]');
};

const queueExists = (name) => {
  // `queues list` has no --json in Wrangler 4.147.0. `queues info` performs a
  // direct lookup, so this does not depend on parsing the human-readable table.
  const result = exec(['queues', 'info', name], true);
  if (result.status === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`;
  if (/Queue ["“].+?["”] does not exist\./i.test(output)) return false;

  throw new Error(`Could not determine whether queue "${name}" exists:\n${output}`);
};

const d1 = json(['d1', 'list']);
let db = d1.find((database) => database.name === 'moovibe-library');
if (!db) {
  console.log('Creating D1 moovibe-library...');
  const result = exec(['d1', 'create', 'moovibe-library'], true);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  console.log(result.stdout);
  db = json(['d1', 'list']).find((database) => database.name === 'moovibe-library');
}

const vectors = json(['vectorize', 'list']);
if (!vectors.some((index) => (index.name || index.index_name) === 'moovibe-movies-v1')) {
  console.log('Creating Vectorize moovibe-movies-v1...');
  const result = exec([
    'vectorize',
    'create',
    'moovibe-movies-v1',
    '--dimensions=768',
    '--metric=cosine',
  ]);
  if (result.status !== 0) process.exit(1);
}

for (const name of ['moovibe-pipeline', 'moovibe-pipeline-dlq']) {
  if (!queueExists(name)) {
    console.log(`Creating Queue ${name}...`);
    const result = exec(['queues', 'create', name]);
    if (result.status !== 0) process.exit(1);
  }
}

if (!db?.uuid) throw new Error('D1 created/found but UUID was not returned');

const configPath = 'workers/pipeline/wrangler.jsonc';
const originalConfig = fs.readFileSync(configPath, 'utf8');
const databaseIdPattern = /("database_name"\s*:\s*"moovibe-library"[\s\S]*?"database_id"\s*:\s*)"[^"]+"/;
if (!databaseIdPattern.test(originalConfig)) {
  throw new Error(`Could not find the moovibe-library database_id in ${configPath}`);
}
const config = originalConfig.replace(databaseIdPattern, `$1"${db.uuid}"`);
if (config !== originalConfig) fs.writeFileSync(configPath, config);

console.log(`Provisioning complete. D1 id written to ${configPath}. Existing resources were not deleted.`);
