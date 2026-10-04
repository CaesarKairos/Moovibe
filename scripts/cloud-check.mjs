import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const wrangler=path.resolve('node_modules/wrangler/bin/wrangler.js');
const run=(args)=>spawnSync(process.execPath,[wrangler,...args],{stdio:'inherit'}).status===0;
let ok=true;
for(const file of ['workers/pipeline/wrangler.jsonc','migrations/0001_library.sql','.dev.vars.example']) if(!fs.existsSync(file)){console.error(`missing: ${file}`);ok=false;}
if(!run(['whoami'])) { console.error('Cloudflare login is required: npx wrangler login'); ok=false; }
if(ok) {
  run(['d1','list']);
  run(['vectorize','list']);
  run(['queues','list']);
  console.log('Local files and Cloudflare authentication checked. Run npm run cloud:provision to create only missing named resources.');
}
process.exitCode=ok?0:1;
