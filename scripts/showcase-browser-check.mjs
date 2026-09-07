import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const root = path.resolve('local-preview-dist');
const server = createServer(async (req,res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(file);
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--disable-dev-shm-usage']});
  const page = await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>Boolean(window.__controlsTest),{timeout:30000});
  await page.getByRole('button',{name:'Start',exact:true}).click();
  await page.waitForTimeout(600);
  const first=await page.evaluate(()=>{
    const body=window.__controlsTest.getBody();
    const canvas=document.querySelector('canvas');
    return {nodes:body.x.length,finite:[...body.x,...body.y,...body.z].every(Number.isFinite),width:canvas.width,height:canvas.height};
  });
  assert.equal(first.nodes,15);
  assert(first.finite && first.width>0 && first.height>0);
  await page.evaluate(()=>{window.__controlsTest.setKeys(['KeyW']);window.__controlsTest.frameStep(90);window.__controlsTest.setKeys([]);});
  const moved=await page.evaluate(()=>window.__controlsTest.getPos());
  assert(Number.isFinite(moved.x)&&Number.isFinite(moved.y)&&Number.isFinite(moved.z));
  await mkdir('showcase-screenshots',{recursive:true});
  await page.screenshot({path:'showcase-screenshots/gameplay.png',animations:'disabled'});
  assert.deepEqual(errors,[],'browser errors');
  console.log('SHOWCASE BROWSER PASS',first,moved);
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
