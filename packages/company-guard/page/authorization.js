const $=id=>document.getElementById(id);
const short=value=>value?value.slice(0,8):"未知";
let base,readKey,authorizationKey,authorizationNonce,editingRequest,authorizationBusy=false,revocationOpen=false;
let activeAuthorizations=[];
function el(tag,text,cls) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
async function api(route,params={},timeout=8000) {
  const url=new URL(route,base);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
  const response=await fetch(url,{headers:{'X-Receipt-Key':readKey},cache:'no-store',signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new Error('read_failed');return response.json();
}

const authorizationErrors={invalid_names:'请填写有效公司名称，每行一个，最多32个；本次设置尚未改变。',request_expired:'申请已过期，请在目标会话重新提出申请。',operation_expired:'保存已过期，请刷新后重新确认。',operation_busy:'另一个窗口正在保存授权，请稍后刷新重试。',invalid_registry:'授权配置校验未通过，请保留当前设置并联系维护。',authorization_too_large:'名单或会话数量超过容量，请缩小范围。',authorization_unavailable:'本机授权服务暂不可用，请刷新重试。',authorization_not_found:'这份授权已变化，请刷新查看。'};
function authorizationNotice(text,error=false){$('authorization-notice').textContent=text;$('authorization-notice').className=error?'error':'detail-message';}
async function authorizationPost(route,body){
  const response=await fetch(new URL('authorization/'+route,base),{method:'POST',headers:{'X-Receipt-Key':readKey,'X-Authorization-Key':authorizationKey,'X-Authorization-Nonce':authorizationNonce,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(10000)});
  const value=await response.json();if(!response.ok)throw new Error(authorizationErrors[value.error]||'未能保存授权，请刷新重试。');return value;
}
function sessionCard(row,kind){
  const card=el('article',undefined,'authorization-card'),text=el('div',undefined,'authorization-task'),scope=el('div',undefined,'authorization-scope');
  const title=el('h3',row.taskTitle || '会话 '+short(row.session));title.title=row.taskTitle || row.session;
  const identity=el('p',undefined,'authorization-identity');identity.append(el('span',row.session,'mono'),el('span',row.workspace,'authorization-workspace'));
  text.append(title,identity);
  scope.append(el('span',kind==='pending'?'等待确认':row.coverage==='all'?'全部公司名称':`${Number(row.nameCount).toLocaleString('zh-CN')} 个名称`,'authorization-scope-label'));
  if(kind!=='pending'&&row.coverage!=='all')scope.append(el('span',row.legacy?'已有名单授权':'指定名单','detail-message'));
  const at=kind==='pending'?row.requestedAt:row.created;
  if(at){const date=new Date(at),time=el('time',(kind==='pending'?'申请于 ':'启用于 ')+date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}),'authorization-time');time.dateTime=date.toISOString();time.title=date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});scope.append(time);}
  const button=el('button',kind==='pending'?'设置放行范围':'恢复脱敏');button.type='button';button.setAttribute('aria-label',(kind==='pending'?'设置放行范围 ':'恢复脱敏 ')+row.session);
  button.addEventListener('click',event=>{if(!event.isTrusted||authorizationBusy)return;if(kind==='pending')openAuthorization(row);else openRevocation(row,card);});card.append(text,scope,button);return card;
}
async function refreshAuthorizations(){
  if(authorizationBusy)return;
  revocationOpen=false;
  try{
    const state=await api('authorization');authorizationNonce=state.nonce;
    const options=await magpie.options.get(),entries=options.sessionAuthorizations||[];
    const verified=await authorizationPost('state',{entries});
    const managed=new Set(entries.map(e=>e.session));
    const pending=state.pending.filter(r=>!verified.active.some(a=>a.session===r.session&&a.requestId===r.id));
    $('authorization-pending').replaceChildren(...pending.map(r=>sessionCard(r,'pending')));
    $('authorization-pending-section').hidden=!pending.length;
    const active=[...verified.active,...state.legacy.filter(r=>!managed.has(r.session))];
    activeAuthorizations=active;
    $('authorization-active').replaceChildren(...active.map(r=>sessionCard(r,'active')));
    if(!active.length)$('authorization-active').append(el('p','当前没有会话原名授权，默认脱敏。','detail-message'));
    authorizationNotice(`${pending.length} 个待确认申请 · ${active.length} 个已启用授权`);
  }catch(error){authorizationNotice(error.message||'无法读取授权，请刷新重试。',true);}
}
function openAuthorization(row){
  editingRequest=row;$('authorization-form').reset();$('authorization-name-list').value='';$('authorization-file-status').textContent='';$('authorization-file').value='';
  $('authorization-target').textContent=`${row.taskTitle ? row.taskTitle+' · ' : ''}${row.session} · ${row.workspace}`;$('authorization-editor').hidden=false;updateAuthorizationScope();$('authorization-editor').scrollIntoView({block:'nearest'});$('authorization-name-list').focus();
  const prior=activeAuthorizations.find(a=>a.session===row.session);$('authorization-existing').textContent=prior?`当前范围：${prior.coverage==='all'?'全部公司名称':prior.nameCount+'个名称'}。本次确认将替换此会话的现有授权。`:'当前为默认脱敏。';
}
function closeAuthorization(){$('authorization-editor').hidden=true;editingRequest=null;$('authorization-name-list').value='';$('authorization-file').value='';}
function updateAuthorizationScope(){
  const all=$('authorization-form').elements.coverage.value==='all';$('authorization-names').hidden=all;
  $('authorization-scope-note').textContent=all?'此会话后续发送的历史和工具文字也会保留公司原名。其他会话、分叉和子任务照常脱敏。':'名单外名称继续脱敏。其他会话、分叉和子任务不会自动取得授权。';
}
function openRevocation(row,card){
  document.querySelector('.revocation-confirm')?.remove();revocationOpen=true;const confirm=el('div',undefined,'revocation-confirm');
  confirm.append(el('p','确认恢复此会话的默认脱敏？已发送的原文不会被撤回。'));
  const yes=el('button','确认恢复脱敏'),no=el('button','取消');yes.type=no.type='button';
  yes.addEventListener('click',event=>{if(event.isTrusted)saveAuthorization({action:'revoke',session:row.session});});no.addEventListener('click',()=>{revocationOpen=false;confirm.remove();});confirm.append(yes,no);card.append(confirm);
}
async function waitForAuthorizationReload(plan){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    try{
      const state=await api('authorization',{},1000);
      if(state.revision===plan.revision){authorizationNonce=state.nonce;return;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('配置已提交，服务尚未重新连接。请刷新核对当前授权状态。');
}
async function saveAuthorization(action){
  if(authorizationBusy)return;authorizationBusy=true;document.querySelectorAll('#authorization-panel button,#authorization-form input,#authorization-form textarea').forEach(b=>b.disabled=true);
  let plan,message,errorState=false;
  try{
    authorizationNotice('正在保存并同步到请求处理…');
    const before=await magpie.options.get(),entries=before.sessionAuthorizations||[];
    plan=await authorizationPost('plan',{...action,entries});
    const latest=await magpie.options.get();if(JSON.stringify(latest.sessionAuthorizations||[])!==JSON.stringify(entries))throw new Error('授权刚被其他窗口修改，请刷新后重新确认。');
    try{await magpie.options.set({...latest,sessionAuthorizations:plan.entries,sessionAuthorizationRevision:plan.revision});}
    catch(error){const saved=await magpie.options.get();if(saved.sessionAuthorizationRevision!==plan.revision)throw error;}
    // Saving options restarts the local service. Wait for the new process to
    // report this revision before committing its persisted operation.
    await waitForAuthorizationReload(plan);
    await authorizationPost('commit',{operationId:plan.operationId,entryMac:plan.entryMac});
    closeAuthorization();message=action.action==='revoke'?'已恢复此会话的默认脱敏。':'已启用。仅上述会话和确认范围允许原名。';
  }catch(error){message=error.message||'保存未完成，请刷新核对当前状态。';errorState=true;if(plan){try{const state=await api('authorization');authorizationNonce=state.nonce;await authorizationPost('cancel',{operationId:plan.operationId,entryMac:plan.entryMac});}catch{}}}
  finally{authorizationBusy=false;document.querySelectorAll('#authorization-panel button,#authorization-form input,#authorization-form textarea').forEach(b=>b.disabled=false);await refreshAuthorizations();if(message)authorizationNotice(message,errorState);}
}
$('authorization-refresh').addEventListener('click',refreshAuthorizations);$('authorization-cancel').addEventListener('click',closeAuthorization);
$('authorization-form').addEventListener('change',updateAuthorizationScope);
$('authorization-file').addEventListener('change',async()=>{const file=$('authorization-file').files[0];if(!file)return;$('authorization-name-list').value='';if(file.size>2*1024*1024){$('authorization-file-status').textContent='文件超过 2 MiB，请缩小名单。';return;}try{$('authorization-name-list').value=await file.text();$('authorization-file-status').textContent='已在本机读取文件，请核对范围后确认。';}catch{$('authorization-file-status').textContent='无法读取文件，请重新选择 UTF-8 文本文件。';}});
// The service deliberately disallows native form submission in its sandbox.
// A trusted button click uses the existing explicit-consent and signed API path.
$('authorization-form').addEventListener('submit',event=>event.preventDefault());
$('authorization-approve').addEventListener('click',event=>{if(!event.isTrusted||!editingRequest||!$('authorization-consent').checked)return;const coverage=$('authorization-form').elements.coverage.value,names=$('authorization-name-list').value.split(/[\n；;]/).map(n=>n.trim()).filter(Boolean);saveAuthorization({action:'approve',requestId:editingRequest.id,coverage,names:coverage==='names'?names:[]});});

async function start(){try{await magpie.ready;const options=await magpie.options.get();readKey=options.receiptReadKey;authorizationKey=options.authorizationKey;if(!/^[a-f0-9]{64}$/.test(readKey||"")||!/^[a-f0-9]{64}$/.test(authorizationKey||""))throw new Error("授权服务尚未配置，请联系维护。");base=new URL(".",location.href).href;await refreshAuthorizations();magpie.onVisibility?.(visible=>{if(visible&&!editingRequest&&!authorizationBusy&&!revocationOpen)refreshAuthorizations();});setInterval(()=>{if(magpie.visible&&!editingRequest&&!authorizationBusy&&!revocationOpen)refreshAuthorizations();},10000);}catch(error){authorizationNotice(error.message||"授权服务暂不可用，请重新打开此页。",true);}}
start();
