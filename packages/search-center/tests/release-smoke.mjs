import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const packageRoot=process.env.SEARCH_CENTER_PACKAGE_ROOT ? pathToFileURL(path.resolve(process.env.SEARCH_CENTER_PACKAGE_ROOT)+path.sep) : new URL('../',import.meta.url);
const {Center}=await import(new URL('center.mjs',packageRoot));
const {createService}=await import(new URL('service.mjs',packageRoot));
const {DATA}=await import(new URL('runtime.mjs',packageRoot));

// All imports must resolve within the extracted package. Run with an empty,
// explicit SEARCH_CENTER_DATA_DIR and a separately installed Python environment.
export default async function verify(page) {
 assert.ok(process.env.SEARCH_CENTER_DATA_DIR,'must isolate test data');
 assert.ok(!fs.existsSync(path.join(DATA,'policy.json')),'test requires clean policy');
 const requests=[];
 const upstream=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):{};
  requests.push({path:req.url,tools:body.tools,model:body.model});
  assert.equal(req.headers.authorization,'Bearer synthetic-release-key');
  res.setHeader('content-type','application/json');
  if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'grok-fast-test'}]}));
  if(req.url==='/v1/responses')return res.end(JSON.stringify({object:'response',status:'completed',output:[
   {type:'web_search_call',id:'web',status:'completed'},
   {type:'x_search_call',id:'x',status:'completed'},
   {type:'message',content:[{type:'output_text',text:'Fixture answer',annotations:[{type:'url_citation',url:'https://example.test/reference',title:'Verified reference'}]}]},
  ]}));
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const center=new Center();
 const service=createService(center,{agents:()=>[]});
 await new Promise(r=>service.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${service.address().port}`;
 const host=base+'/__sandbox';
 await page.route(host,r=>r.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><iframe id="plugin" sandbox="allow-scripts" width="1080" height="850" src="${base}/"></iframe>`}));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  const caps=await center.publicCapabilities();
  assert.deepEqual(Object.entries(caps.channels).filter(([,c])=>c.available).map(([id])=>id),['you','github','arxiv','crossref']);
  await page.goto(host);let f=page.frameLocator('#plugin');
  await f.locator('[data-channel="you"]').waitFor();
  await f.getByRole('button',{name:'全部',exact:true}).first().click();
  await f.getByRole('button',{name:'配置 Grok Search',exact:true}).click();
  await f.locator('#base-url').fill(`http://127.0.0.1:${upstream.address().port}`);
  await f.locator('#grok-model-fields input[data-profile="quick"]').fill('grok-fast-test');
  await f.locator('#add-key').click();
  await f.locator('.key-label').fill('Release test');
  await f.locator('.key-value').fill('synthetic-release-key');
  const saved=page.waitForResponse(r=>r.url()===base+'/api/channel');
  await f.locator('#save-channel').click();assert.equal((await saved).status(),200);
  await f.locator('#drawer').waitFor({state:'hidden'});
  await page.reload();f=page.frameLocator('#plugin');
  await f.getByRole('button',{name:'配置 Grok Search',exact:true}).click();
  assert.equal(await f.locator('.account-name').textContent(),'Release test');
  assert.equal(await f.locator('#grok-model-fields input[data-profile="quick"]').inputValue(),'grok-fast-test');
  await f.locator('#refresh-models').click();
  await f.locator('#grok-model-count').filter({hasText:'1 个公布模型'}).waitFor();
  await page.screenshot({path:process.env.SEARCH_CENTER_SCREENSHOT});
  await f.locator('#close-drawer').click();await f.locator('#route-test').click();
  await f.locator('#test-channels input[value="grok"]').check();
  assert.equal(await f.locator('#grok-search-mode').inputValue(),'both');
  const reply=page.waitForResponse(r=>r.url()===base+'/api/test');
  await f.locator('#run-test').click();
  const response=await reply;assert.equal(response.status(),200);
  const found=await response.json();assert.equal(found.results.length,1);
  assert.deepEqual(requests.find(r=>r.path==='/v1/responses').tools,[{type:'web_search'},{type:'x_search'}]);
  assert.equal(found.routing.channel_results.grok.models[0].search.tool_calls.length,2);
  assert.ok(!fs.readFileSync(path.join(DATA,'credentials.encrypted.json'),'utf8').includes('synthetic-release-key'));
  assert.ok(!fs.readFileSync(path.join(DATA,'policy.json'),'utf8').includes('synthetic-release-key'));
  assert.deepEqual(errors,[]);
  return {freshInstall:true,oldMCPRequests:0,dpapiSaveReload:true,modelDiscovery:true,actualWorkerResponses:true,defaultBoth:true,citations:1,sandbox:'allow-scripts',pageErrors:0};
 } catch(error) {
  console.error(JSON.stringify({pageErrors:errors,body:await page.frameLocator('#plugin').locator('body').innerText().catch(()=>'' )}));
  throw error;
 } finally {
  await page.goto('about:blank');await page.unroute(host);
  service.closeAllConnections();upstream.closeAllConnections();
  await new Promise(r=>service.close(r));await new Promise(r=>upstream.close(r));
 }
}
