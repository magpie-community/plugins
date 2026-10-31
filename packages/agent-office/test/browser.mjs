// Run against magpie web with this plugin installed from the checkout.
// OFFICE_PLAYWRIGHT=/path/to/playwright/index.mjs OFFICE_HOST_URL='http://127.0.0.1:4571/?k=...' bun test/browser.mjs
// Uses real host navigation, bridge, theme and sandbox. Only live.js is
// replaced with synthetic prompts; no user sessions or model calls needed.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
const { chromium, webkit } = await import(process.env.OFFICE_PLAYWRIGHT || 'playwright')
const host=process.env.OFFICE_HOST_URL
if(!host) throw new Error('Set OFFICE_HOST_URL to an authenticated magpie web URL')
const output=process.env.OFFICE_QA_OUTPUT || '/tmp/agent-office-browser-qa'
mkdirSync(output,{recursive:true})
const now=Date.now(),marker='SECRET-PROMPT-123'
const snapshot={v:2,written:now,text:true,sessions:Array.from({length:12},(_,i)=>({
 key:`qa|${i}`,agent:'claude',session:`qa-${i}`,source:'files',phase:i===0?'error':i===1?'thinking':'done',
 title:`${marker} 布局回归测试 ${i}`,query:`${marker} user`,reply:`${marker} reply`,error:i===0?`${marker} error`:'',
 project:'fixture',cwd:'/fixture',model:'fixture-model',updated:now-(i===0?2*3600e3:i*100),touched:now-(i===0?2*3600e3:i*100),
 turns:1,messages:[{role:'user',text:marker,at:now},{role:'assistant',text:marker,at:now}],
}))}
function overlap(a,b){return Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5}
for(const engine of (process.env.OFFICE_BROWSERS||'chromium,webkit').split(',')) {
 const type=engine==='webkit'?webkit:chromium
 const browser=await type.launch({headless:true,timeout:30000,...(engine==='chromium'?{executablePath:process.env.OFFICE_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})})
 try {
 for(const [width,height] of [[600,620],[820,650],[1440,1000]]) {
  console.log(`START ${engine} ${width}x${height}`)
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2,colorScheme:'dark'})
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
  await page.route('**/live.js*',route=>route.fulfill({contentType:'text/javascript',body:`globalThis.AgentOfficeLive=${JSON.stringify(snapshot)};`}))
  // magpie 0.1.2305 web emits scheme-less numeric-host CSP sources.
  // Chromium accepts them; WebKit rejects every resource. Optional test-only
  // normalization adds the existing response URL's scheme, keeping the same
  // exact host/path allowlist. It does not change the bridge or sandbox.
  if(engine==='webkit' && process.env.OFFICE_NORMALIZE_WEBKIT_CSP==='1') {
   await page.route('**/_magpie/plugin/**/index.html',async route=>{
    const response=await route.fetch()
    const headers=response.headers()
    const origin=new URL(route.request().url())
    headers['content-security-policy']=(headers['content-security-policy']||'').replaceAll(origin.host+'/_magpie/',origin.origin+'/_magpie/')
    await route.fulfill({response,headers})
   })
   console.log('WebKit test-only CSP URL-scheme normalization enabled')
  }
  await page.goto(host)
  await page.waitForTimeout(1000)
  await page.getByText('Agent 办公室',{exact:true}).click()
  await page.waitForSelector('iframe')
  let frame
  for(let attempt=0;attempt<5;attempt++) {
   const iframe=await page.waitForSelector('iframe')
   frame=await iframe.contentFrame()
   try {await frame.waitForFunction(()=>document.querySelector('#nDone')?.textContent==='10',{timeout:30000});break}
   catch(e){if(attempt===4||!e.message.includes('detached'))throw e;console.log('reacquire reloaded plugin frame')}
  }
  await frame.locator('#settingsBtn').click();await frame.locator('#optText').check();await frame.locator('#settingsBtn').click()
  const dimensions=await frame.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,docHeight:document.documentElement.scrollHeight}))
  assert(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions))
  assert(dimensions.docHeight<=dimensions.height+1,JSON.stringify(dimensions))
  for(const id of ['settings','todayMenu']) {
   await frame.locator(id==='settings'?'#settingsBtn':'#todayBtn').click()
   const bounds=await frame.locator('#'+id).evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight}})
   assert(bounds.left>=0&&bounds.right<=bounds.w+1&&bounds.top>=0&&bounds.bottom<=bounds.h+1,`${engine} menu ${JSON.stringify(bounds)}`)
   await page.screenshot({path:`${output}/${engine}-${width}-${id}.png`})
   await frame.locator(id==='settings'?'#settingsBtn':'#todayBtn').click()
  }
  // ISO/2D/list/3D plus background/foreground must not reactivate a hidden renderer.
  for(const dim of ['iso','2d','3d']) {
   await frame.locator(`[data-dim="${dim}"]`).click()
   await frame.evaluate(()=>{
    Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'))
   })
   await page.waitForTimeout(250)
   const boxes=await frame.locator('.tag:visible').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}}))
   for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert(!overlap(boxes[i],boxes[j]),`${engine} ${width} ${dim} label overlap`)
  }
  if(width===1440) {
   await frame.locator('#settingsBtn').click()
   for(const scene of ['office','station','cafe','castle','pirate','graveyard']) {
    await frame.locator('#optScene').selectOption(scene)
    for(const quality of ['low','medium','high']) {
     await frame.locator('#optQuality').selectOption(quality)
     await page.waitForTimeout(80)
    }
   }
   await frame.locator('#optScene').selectOption('office')
   await frame.locator('#optQuality').selectOption('medium')
   await frame.locator('#settingsBtn').click()
  }
  await frame.locator('[data-mode="list"]').click()
  const buffer=await frame.locator('#office3d').evaluate(e=>[e.width,e.height])
  await frame.evaluate(()=>{for(let i=0;i<5;i++)dispatchEvent(new Event('resize'));document.dispatchEvent(new Event('visibilitychange'))})
  assert.deepEqual(await frame.locator('#office3d').evaluate(e=>[e.width,e.height]),buffer)
  await frame.locator('[data-mode="office"]').click()
  await frame.locator('#settingsBtn').click();await frame.locator('[data-hide="1h"]').click();await frame.locator('[data-hide="6h"]').click();await frame.locator('#settingsBtn').click()
  assert.equal(await frame.locator('.toast').count(),0,'filtering must not replay old alerts')
  await frame.evaluate(()=>{const real=Date.now;Date.now=()=>real()+11*60e3})
  await frame.waitForFunction(()=>document.querySelector('#rows').textContent.includes(AgentOfficeModel.text(document.documentElement.lang).noProgress))
  if(!(await frame.locator('#rail').isVisible())) await frame.locator('#sideBtn').click()
  await frame.locator('.rail-row').first().click()
  assert(await frame.locator('#pop').innerText().then(t=>t.includes(marker)))
  await frame.locator('#settingsBtn').click()
  await frame.locator('#optText').uncheck()
  await frame.locator('#settingsBtn').click()
  const leak=await frame.locator('body').evaluate((body,marker)=>({text:body.textContent.includes(marker),attrs:[...body.querySelectorAll('*')].some(n=>[...n.attributes].some(a=>a.value.includes(marker)))}),marker)
  assert(!leak.text&&!leak.attrs,`${engine} stale private DOM ${JSON.stringify(leak)}`)
  await page.screenshot({path:`${output}/${engine}-${width}-privacy.png`})
  await frame.locator('#pop .px').click()
  assert(!(await frame.locator('#pop').textContent()).includes(marker),'closed panel retains no private messages')
  assert.deepEqual(errors,[],`${engine} page errors`)
  console.log(`${engine} ${width}x${height} DPR2 iframe ${dimensions.width}x${dimensions.height}: menus, labels, modes, privacy PASS`)
  await page.waitForTimeout(2800)
  await page.close()
 }
 } finally {await browser.close()}
}
