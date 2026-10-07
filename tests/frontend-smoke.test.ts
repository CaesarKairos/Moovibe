import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createServer,Server} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
let server:Server;
let origin='';
const contentTypes:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};

beforeAll(async()=>{
  server=createServer(async(req,res)=>{
    try{
      const pathname=decodeURIComponent(new URL(req.url||'/', 'http://local').pathname);
      const relative=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');
      const target=path.resolve(root,relative);
      if(!target.startsWith(root+path.sep))throw new Error('outside root');
      const info=await stat(target);
      if(!info.isFile())throw new Error('not a file');
      res.writeHead(200,{'content-type':contentTypes[path.extname(target)]||'application/octet-stream'});
      res.end(await readFile(target));
    }catch{res.writeHead(404,{'content-type':'text/html'});res.end('<!doctype html><title>Not found</title>');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('test server unavailable');
  origin=`http://127.0.0.1:${address.port}`;
});
afterAll(()=>new Promise<void>(resolve=>server.close(()=>resolve())));

const importsOf=(source:string)=>[...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map(match=>match[1]);

describe('public frontend boundary',()=>{
  it('serves the complete browser module graph as JavaScript, never HTML or /functions',async()=>{
    const html=await (await fetch(origin+'/')).text();
    const entry=html.match(/<script\s+type="module"\s+src="([^"]+)"/)?.[1];
    expect(entry).toBe('/js/script.js');
    const pending=[new URL(entry!,origin).href];
    const visited=new Set<string>();
    while(pending.length){
      const url=pending.pop()!;
      if(visited.has(url))continue;
      visited.add(url);
      expect(new URL(url).pathname).not.toMatch(/^\/functions(?:\/|$)/);
      const response=await fetch(url);
      const body=await response.text();
      expect(response.status,`${url} must resolve`).toBe(200);
      expect(response.headers.get('content-type'),`${url} returned HTML`).toMatch(/javascript/);
      expect(body.trimStart()).not.toMatch(/^<!doctype|^<html/i);
      for(const specifier of importsOf(body)){
        if(specifier.startsWith('.')||specifier.startsWith('/'))pending.push(new URL(specifier,url).href);
      }
    }
    expect([...visited].map(url=>new URL(url).pathname)).toEqual(expect.arrayContaining(['/js/script.js','/js/i18n/locales.js','/shared/languages.js']));
  });

  it('forbids every public JS source from importing Pages Functions',async()=>{
    const files=await readFile(path.join(root,'js','script.js'),'utf8').then(async script=>[
      ['js/script.js',script],
      ['js/i18n/locales.js',await readFile(path.join(root,'js','i18n','locales.js'),'utf8')]
    ] as const);
    for(const [file,source] of files)for(const specifier of importsOf(source))expect(specifier,`${file} crosses the browser/server boundary`).not.toMatch(/(?:^|\/)functions(?:\/|$)/);
  });

  it('registers navigation, picker, form, history and best-effort analytics behavior',async()=>{
    const source=await readFile(path.join(root,'js','script.js'),'utf8');
    expect(source).toContain("document.addEventListener('DOMContentLoaded'");
    expect(source).toContain("languageButton?.addEventListener('click'");
    expect(source).toContain("languagePicker?.addEventListener('keydown'");
    expect(source).toContain("navLinks.forEach");
    expect(source).toContain("searchForm.addEventListener('submit'");
    expect(source).toContain("window.addEventListener('popstate'");
    expect(source).toMatch(/fetch\('\/analytics'[\s\S]+?\.catch\(\(\)=>\{\}\)/);
    expect(source.indexOf('const errorMessage')).toBeLessThan(source.lastIndexOf('\n    applyLanguage();'));
  });
});
