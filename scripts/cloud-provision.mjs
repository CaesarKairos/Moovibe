import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const bin=path.resolve('node_modules/wrangler/bin/wrangler.js');
const exec=(args,capture=false)=>spawnSync(process.execPath,[bin,...args],{encoding:'utf8',stdio:capture?'pipe':'inherit'});
const json=args=>{const r=exec([...args,'--json'],true);if(r.status!==0)throw new Error(r.stderr||r.stdout);return JSON.parse(r.stdout||'[]')};
const d1=json(['d1','list']); let db=d1.find(x=>x.name==='moovibe-library');
if(!db){console.log('Creating D1 moovibe-library...');const r=exec(['d1','create','moovibe-library'],true);if(r.status!==0)throw new Error(r.stderr||r.stdout);console.log(r.stdout);db=json(['d1','list']).find(x=>x.name==='moovibe-library');}
const vectors=json(['vectorize','list']); if(!vectors.some(x=>(x.name||x.index_name)==='moovibe-movies-v1')) {console.log('Creating Vectorize moovibe-movies-v1...');if(exec(['vectorize','create','moovibe-movies-v1','--dimensions=768','--metric=cosine']).status!==0)process.exit(1);}
const queues=json(['queues','list']); for(const name of ['moovibe-pipeline','moovibe-pipeline-dlq']) if(!queues.some(x=>x.queue_name===name||x.name===name)){console.log(`Creating Queue ${name}...`);if(exec(['queues','create',name]).status!==0)process.exit(1);}
const configPath='workers/pipeline/wrangler.jsonc';let config=fs.readFileSync(configPath,'utf8');
if(!db?.uuid)throw new Error('D1 created/found but UUID was not returned');
config=config.replace(/"database_id":\s*"[^"]+"/,`"database_id": "${db.uuid}"`);fs.writeFileSync(configPath,config);
console.log(`Provisioning complete. D1 id written to ${configPath}. Existing resources were not deleted.`);
