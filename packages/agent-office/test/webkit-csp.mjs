// Minimal local-only diagnostic for the platform-specific WebKit CSP report.
// OFFICE_PLAYWRIGHT=/path/to/playwright/index.mjs bun test/webkit-csp.mjs
// Reports both outcomes: a working scheme-less source is not a failure.
import { pathToFileURL } from "node:url"
const modulePath=process.env.OFFICE_PLAYWRIGHT
if(!modulePath)throw new Error("Set OFFICE_PLAYWRIGHT to an installed Playwright module")
const {webkit}=await import(modulePath)
const playwrightInfo=await Bun.file(new URL("./package.json",modulePath.startsWith("file:")?modulePath:pathToFileURL(modulePath))).json().catch(()=>null)
const hits=[]
let origin
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
 const url=new URL(request.url),policy=url.searchParams.get("policy")||"scheme-less"
 if(url.pathname==="/")return new Response(`<iframe sandbox="allow-scripts" src="/_magpie/plugin/tok/index.html?policy=${policy}"></iframe>`,{headers:{"content-type":"text/html"}})
 if(url.pathname.endsWith("/index.html")) {
  const source=policy==="explicit"?`${origin}/_magpie/plugin/tok/`:`127.0.0.1:${server.port}/_magpie/plugin/tok/`
  return new Response(`<p id="result">not executed</p><script src="./app.js?policy=${policy}"></script>`,{headers:{"content-type":"text/html","content-security-policy":`default-src 'none'; script-src ${source};`}})
 }
 if(url.pathname.endsWith("/app.js")){hits.push(policy);return new Response('globalThis.APP_EXECUTED=true;document.querySelector("#result").textContent="executed";console.log("APP_EXECUTED")',{headers:{"content-type":"text/javascript"}})}
 return new Response("not found",{status:404})
}})
origin=`http://127.0.0.1:${server.port}`
let browser
try {
 browser=await webkit.launch()
 const results=[]
 for(const policy of ["scheme-less","explicit"]) {
  const page=await browser.newPage(),consoleMessages=[],pageErrors=[]
  page.on("console",message=>consoleMessages.push({type:message.type(),text:message.text()}))
  page.on("pageerror",error=>pageErrors.push(error.message))
  const responsePromise=page.waitForResponse(response=>response.url().includes("/index.html"))
  await page.goto(`${origin}/?policy=${policy}`)
  const response=await responsePromise,frame=page.frames().find(frame=>frame.url().includes("/index.html"))
  const observed=await frame.evaluate(()=>({executed:globalThis.APP_EXECUTED===true,text:document.querySelector("#result").textContent,documentOrigin:globalThis.origin,urlOrigin:location.origin}))
  results.push({policy,status:response.status(),csp:response.headers()["content-security-policy"],...observed,scriptRequested:hits.includes(policy),consoleMessages,pageErrors})
  await page.close()
 }
 const mac=process.platform==="darwin"?new TextDecoder().decode(Bun.spawnSync({cmd:["/usr/bin/sw_vers"]}).stdout).trim():null
 console.log(JSON.stringify({platform:process.platform,arch:process.arch,macOS:mac,bun:Bun.version,playwrightVersion:playwrightInfo?.version||null,webkitVersion:browser.version(),webkitBuild:webkit.executablePath().match(/webkit-(\d+)/)?.[1]||null,results},null,2))
 if(!results.find(r=>r.policy==="explicit").executed)throw new Error("Explicit source control did not execute")
}finally{if(browser)await browser.close();server.stop(true)}
