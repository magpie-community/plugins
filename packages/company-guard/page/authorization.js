const $=id=>document.getElementById(id);
const short=value=>value?value.slice(0,13):"未知";
let base,readKey,authorizationKey,authorizationNonce,editingRequest,authorizationBusy=false,authorizationRefreshing=false,revocationOpen=false,rangeOpen=false,rejectionOpen=false;
let activeAuthorizations=[];
let recentSummary='',recentReadAt='';
function el(tag,text,cls) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
async function api(route,params={},timeout=8000) {
  const url=new URL(route,base);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
  const response=await fetch(url,{headers:{'X-Receipt-Key':readKey},cache:'no-store',signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new Error('read_failed');return response.json();
}

const authorizationErrors={invalid_names:'请填写有效公司名称，每行一个，最多32个；本次设置尚未改变。',request_expired:'申请已过期，请在目标会话重新提出申请。',operation_expired:'保存已过期，请刷新后重新确认。',operation_busy:'另一个窗口正在保存授权，请稍后刷新重试。',invalid_registry:'授权配置校验未通过，请保留当前设置并联系维护。',authorization_too_large:'名单或会话数量超过容量，请缩小范围。',authorization_unavailable:'本机授权服务暂不可用，请刷新重试。',authorization_not_found:'这份授权已变化，请刷新查看。'};
Object.assign(authorizationErrors,{receipt_target_unavailable:'此回执已过期或缺少可核验的目录，请等待该会话的新请求。',already_authorized:'此会话已全部放行，请刷新查看。',pending_capacity:'待确认申请已满，请先处理已有申请。'});
Object.assign(authorizationErrors,{request_expired:'申请已过期或已处理，请刷新核对。',rejection_history_unavailable:'申请已拒绝，但操作记录保存未成功；请保留本机记录并联系维护。'});
function authorizationNotice(text,error=false){
  for(const id of ['authorization-notice',...($('authorization-editor').open?['authorization-editor-notice']:[])]){const notice=$(id);notice.textContent=text;notice.className=error?'error':'detail-message';notice.hidden=!text;}
}
async function authorizationPost(route,body){
  const response=await fetch(new URL('authorization/'+route,base),{method:'POST',headers:{'X-Receipt-Key':readKey,'X-Authorization-Key':authorizationKey,'X-Authorization-Nonce':authorizationNonce,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(10000)});
  const value=await response.json();if(!response.ok)throw new Error(authorizationErrors[value.error]||'未能保存授权，请刷新重试。');return value;
}
function pendingCard(row){
  const card=el('article',undefined,'authorization-card'),text=el('div',undefined,'authorization-task'),scope=el('div',undefined,'authorization-scope');
  const title=el('h3',row.taskTitle || '会话 '+short(row.session));title.title=row.taskTitle || row.session;
  const heading=el('div',undefined,'authorization-title'),agent=el('span',undefined,'authorization-agent');
  agent.append(el('strong',row.agentLabel || '来源未记录'));agent.setAttribute('aria-label','智能体：'+(row.agentLabel||'来源未记录'));
  heading.append(title,agent);
  const identity=el('p',undefined,'authorization-identity'),id=el('span',short(row.session),'mono'),workspace=el('span',row.workspace,'authorization-workspace');id.title=row.session;workspace.title=row.workspace;identity.append(id,workspace);
  text.append(heading,identity);
  scope.append(el('span','等待确认','authorization-scope-label'));
  if(row.requestedAt)scope.append(authorizationTime(row.requestedAt,'申请于 '));
  const button=el('button','设置放行范围');button.type='button';button.setAttribute('aria-label','设置放行范围 '+row.session);
  button.addEventListener('click',event=>{if(event.isTrusted&&!authorizationBusy){dismissRejection();openAuthorization(row);}});
  const actions=el('div',undefined,'authorization-pending-actions'),reject=el('button','拒绝申请');reject.type='button';reject.setAttribute('aria-label','拒绝申请 '+row.session);reject.addEventListener('click',event=>{if(event.isTrusted&&!authorizationBusy)openRejection(row,card,reject);});actions.append(button,reject);card.append(text,scope,actions);return card;
}
function dismissRejection(){
  document.querySelector('.rejection-confirm')?.remove();rejectionOpen=false;
}
function openRejection(row,card,trigger){
  dismissRejection();rejectionOpen=true;
  const confirm=el('div',undefined,'rejection-confirm'),message=el('p','确认拒绝本次申请？只关闭这条申请，当前脱敏与授权设置保持不变。'),actions=el('div',undefined,'authorization-actions'),yes=el('button','确认拒绝'),no=el('button','取消');yes.type=no.type='button';
  yes.addEventListener('click',event=>{if(event.isTrusted)rejectPending(row);});no.addEventListener('click',()=>{dismissRejection();trigger.focus();});actions.append(yes,no);confirm.append(message,actions);card.append(confirm);no.focus();
}
async function rejectPending(row){
  if(authorizationBusy||authorizationRefreshing)return;authorizationBusy=true;document.querySelectorAll('#authorization-panel button').forEach(b=>b.disabled=true);let message,errorState=false;
  try{const state=await api('authorization');authorizationNonce=state.nonce;await authorizationPost('reject',{requestId:row.id});if(editingRequest?.id===row.id)closeAuthorization();message='已拒绝本次申请，当前脱敏与授权设置保持不变。';}
  catch(error){message=error.message||'未能拒绝申请，请刷新重试。';errorState=true;}
  finally{authorizationBusy=false;document.querySelectorAll('#authorization-panel button').forEach(b=>b.disabled=false);await refreshAuthorizations();await refreshAuthorizationHistory();authorizationNotice(message,errorState);}
}
function authorizationTime(at,prefix=''){
  const date=new Date(at),time=el('time',prefix+date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}),'authorization-time');
  time.dateTime=date.toISOString();time.title=date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});return time;
}
function closeRanges(){
  document.querySelectorAll('.authorization-scope-detail').forEach(n=>n.remove());
  document.querySelectorAll('.scope-toggle[aria-expanded="true"]').forEach(b=>{b.setAttribute('aria-expanded','false');b.textContent='查看范围';});rangeOpen=false;
}
function showRange(row,tr,button,id){
  const open=button.getAttribute('aria-expanded')==='true';closeRanges();if(open)return;
  document.querySelector('.revocation-confirm')?.remove();revocationOpen=false;
  const detail=el('tr',undefined,'authorization-scope-detail'),cell=el('td');cell.colSpan=5;detail.id=id;
  cell.append(el('p','会话 '+row.session,'mono muted'));
  if(row.coverage==='all')cell.append(el('p','此会话内全部公司名称，包括后续历史和工具文字。'));
  else {const list=el('ul',undefined,'authorization-name-list');for(const name of row.names||[])list.append(el('li',name));cell.append(list,el('p','仅上述写法放行；简称与别名不会自动随全称放行。'));}
  detail.append(cell);tr.after(detail);button.setAttribute('aria-expanded','true');button.textContent='收起范围';rangeOpen=true;
}
function authorizationTable(rows){
  const wrap=el('div',undefined,'table-wrap'),table=el('table',undefined,'authorization-table'),head=el('thead'),line=el('tr'),body=el('tbody');wrap.tabIndex=0;wrap.setAttribute('aria-label','已启用授权表格，可横向滚动');
  table.append(el('caption','已启用授权','sr-only'));
  for(const text of ['智能体','会话 / 工作目录','授权范围','启用时间（北京）','操作']){const th=el('th',text);th.scope='col';line.append(th);}head.append(line);table.append(head,body);
  rows.forEach((row,index)=>{
    const tr=el('tr'),agent=el('td'),identity=el('td',undefined,'authorization-table-identity'),scope=el('td',undefined,'authorization-table-scope'),time=el('td'),action=el('td');
    agent.append(el('span',row.agentLabel||'来源未记录','session-agent'));
    identity.append(el('strong',row.taskTitle||'会话 '+short(row.session)));
    const id=el('p',short(row.session),'mono muted');id.title=row.session;identity.append(id,el('p',row.workspace,'authorization-workspace'));
    scope.append(el('span',row.coverage==='all'?'全部公司名称':`${Number(row.nameCount).toLocaleString('zh-CN')} 个名称`));
    const view=el('button','查看范围','view scope-toggle'),detailId='authorization-range-'+index;view.type='button';view.setAttribute('aria-label','查看授权范围 '+row.session);view.setAttribute('aria-expanded','false');view.setAttribute('aria-controls',detailId);view.addEventListener('click',()=>showRange(row,tr,view,detailId));scope.append(view);
    time.append(row.created?authorizationTime(row.created):document.createTextNode('—'));
    const revoke=el('button','恢复脱敏');revoke.type='button';revoke.setAttribute('aria-label','恢复脱敏 '+row.session);revoke.addEventListener('click',event=>{if(event.isTrusted&&!authorizationBusy)openRevocation(row,tr,revoke);});action.append(revoke);
    tr.append(agent,identity,scope,time,action);body.append(tr);
  });wrap.append(table);return wrap;
}
function renderRecentSessions(recent){
  $('recent-sessions').replaceChildren();
  recentSummary='';recentReadAt='';$('recent-sessions-refresh-status').textContent='';
  if(!recent?.available){$('recent-sessions-notice').textContent='最近回执暂时无法读取，请刷新重试。';return;}
  const rows=recent.sessions||[],at=new Date(recent.readAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  recentSummary=`${recent.requestCount} 条回执 · ${rows.length} 个会话`+(recent.unidentifiedCount?` · ${recent.unidentifiedCount} 条缺少标识`:'');recentReadAt=at;updateRecentRefreshNotice();
  if(!rows.length){$('recent-sessions').append(el('p','当前保留的回执中没有可识别的会话。','detail-message'));return;}
  const wrap=el('div',undefined,'table-wrap recent-sessions-wrap'),list=el('ul',undefined,'recent-session-list');wrap.tabIndex=0;wrap.setAttribute('aria-label','最近25条回执涉及的会话，可滚动');list.setAttribute('role','list');list.setAttribute('aria-label','最近回执涉及的会话');
  for(const row of rows){
    const item=el('li',undefined,'recent-session-item'),footer=el('div',undefined,'recent-session-footer'),meta=el('div',undefined,'recent-session-meta'),state=row.authorizationState==='all'?'all':row.pending?'pending':row.authorizationState==='names'?'names':'masked',status=el('div',undefined,'recent-session-status'),action=el('div',undefined,'recent-session-action');
    const title=el('h3',row.taskTitle||'会话名称暂未获取','recent-session-title'),agent=el('span',row.agentLabel||'来源未记录','session-agent'),count=el('span',row.requestCount+' 条回执','recent-session-count');
    title.title=title.textContent;agent.setAttribute('aria-label','智能体：'+(row.agentLabel||'来源未记录'));meta.append(agent,count);
    const badge=el('span',({all:'已放行',pending:'待确认',names:'部分放行',masked:'默认脱敏'})[state],'session-state session-state-'+state);badge.title='当前授权设置；逐条请求的实际处理结果见脱敏回执明细';status.append(badge);
    if(state==='pending'){const link=el('a','查看申请','session-action-link');link.href='#authorization-pending-section';action.append(link);}
    else if(state!=='all'){
      if(row.receiptId||row.reapplyRequestId){const button=el('button','申请取消脱敏');button.type='button';button.title=row.reapplyRequestId?'沿用上次已核验的申请目录，仍须重新确认放行范围':'只创建待确认申请，不改变当前脱敏';button.setAttribute('aria-label','申请取消脱敏 '+(row.taskTitle||row.session));button.addEventListener('click',event=>{if(event.isTrusted)requestFromReceipt(row,button);});action.append(button);}
      else{const unavailable=el('span',row.backgroundTask?'不支持申请':'暂不可申请','recent-session-unavailable');unavailable.title=row.backgroundTask?'后台任务不继承主会话授权；缺少独立可核验目录，当前不支持从此表申请放行':'缺少可核验的会话目录，目前仅支持 Codex；请等待该会话的新请求';unavailable.setAttribute('aria-label',unavailable.textContent+'：'+unavailable.title);action.append(unavailable);}
    }
    if(action.childElementCount)status.append(action);footer.append(meta,status);item.append(title,footer);list.append(item);
  }
  wrap.append(list);$('recent-sessions').append(wrap);
}
async function requestFromReceipt(row,button){
  if(authorizationBusy||authorizationRefreshing)return;authorizationBusy=true;button.disabled=true;$('recent-session-action-notice').textContent='正在创建申请…';let message,created=false;
  try{
    const state=await api('authorization');authorizationNonce=state.nonce;
    await authorizationPost('request',row.reapplyRequestId?{reapplyRequestId:row.reapplyRequestId}:{receiptId:row.receiptId,date:row.receiptDate});created=true;message='申请已创建，请在“待确认申请”中核对工作目录并确认放行范围。';
  }catch(error){message=error.message||'申请未创建，请刷新重试。';}
  finally{authorizationBusy=false;button.disabled=false;await refreshAuthorizations();await refreshAuthorizationHistory();$('recent-session-action-notice').textContent=message;if(created)$('authorization-pending-section').scrollIntoView({block:'nearest'});}
}
async function refreshAuthorizations(){
  if(authorizationBusy||authorizationRefreshing)return;authorizationRefreshing=true;
  $('authorization-refresh').disabled=true;
  dismissRejection();
  revocationOpen=false;rangeOpen=false;
  try{
    const state=await api('authorization');authorizationNonce=state.nonce;
    renderRecentSessions(state.recent);
    const options=await magpie.options.get(),entries=options.sessionAuthorizations||[];
    const verified=await authorizationPost('state',{entries});
    const managed=new Set(entries.map(e=>e.session));
    const pending=state.pending.filter(r=>!verified.active.some(a=>a.session===r.session&&a.requestId===r.id));
    if(editingRequest&&!pending.some(r=>r.id===editingRequest.id))closeAuthorization();
    $('authorization-pending').replaceChildren(...pending.map(pendingCard));
    if(!pending.length)$('authorization-pending').append(el('p','暂无待确认申请。','detail-message'));
    const active=[...verified.active,...state.legacy.filter(r=>!managed.has(r.session))];
    activeAuthorizations=active;
    $('authorization-active').replaceChildren(...(active.length?[authorizationTable(active)]:[]));
    if(!active.length)$('authorization-active').append(el('p','当前没有会话原名授权，默认脱敏。','detail-message'));
    authorizationNotice('');
  }catch(error){recentSummary='';recentReadAt='';$('recent-sessions-refresh-status').textContent='';authorizationNotice(error.message||'无法读取授权，请刷新重试。',true);$('recent-sessions-notice').textContent='刷新失败，下方为上次读取结果。';}
  finally{authorizationRefreshing=false;$('authorization-refresh').disabled=false;}
}
function openAuthorization(row){
  editingRequest=row;$('authorization-form').reset();$('authorization-name-list').value='';$('authorization-file-status').textContent='';$('authorization-file').value='';
  const target=$('authorization-target'),details=el('dl');target.replaceChildren(el('strong',row.taskTitle||'会话 '+short(row.session)));
  for(const [label,value] of [['智能体',row.agentLabel||'来源未记录'],['会话编号',row.session],['工作目录',row.workspace]])details.append(el('dt',label),el('dd',value));target.append(details);
  $('authorization-editor-notice').hidden=true;$('authorization-editor-notice').textContent='';updateAuthorizationScope();
  const prior=activeAuthorizations.find(a=>a.session===row.session);$('authorization-existing').textContent=prior?`当前范围：${prior.coverage==='all'?'全部公司名称':prior.nameCount+'个名称'}。本次确认将替换此会话的现有授权。`:'当前为默认脱敏。';
  $('authorization-editor').showModal();$('authorization-cancel').focus();
}
function closeAuthorization(){$('authorization-editor').close();editingRequest=null;$('authorization-form').reset();$('authorization-name-list').value='';$('authorization-file').value='';}
function updateAuthorizationScope(){
  const all=$('authorization-form').elements.coverage.value==='all';$('authorization-names').hidden=all;
  $('authorization-approve').disabled=authorizationBusy||!$('authorization-consent').checked;
  $('authorization-scope-note').textContent=all?'此会话后续发送的历史和工具文字也会保留公司原名。其他会话、分叉和子任务照常脱敏。':'按填写的具体名称放行，简称和别名需逐项填写，不会随全称自动放行。名单外名称继续脱敏；其他会话、分叉和子任务不会自动取得授权。';
}
function openRevocation(row,tr,trigger){
  document.querySelector('.revocation-confirm')?.remove();closeRanges();revocationOpen=true;const confirm=el('tr',undefined,'revocation-confirm'),cell=el('td');cell.colSpan=5;
  cell.append(el('p','确认恢复此会话的默认脱敏？已发送的原文不会被撤回。'));
  const yes=el('button','确认恢复脱敏'),no=el('button','取消');yes.type=no.type='button';
  yes.addEventListener('click',event=>{if(event.isTrusted)saveAuthorization({action:'revoke',session:row.session});});no.addEventListener('click',()=>{revocationOpen=false;confirm.remove();trigger.focus();});cell.append(yes,no);confirm.append(cell);tr.after(confirm);no.focus();
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
  finally{authorizationBusy=false;document.querySelectorAll('#authorization-panel button,#authorization-form input,#authorization-form textarea').forEach(b=>b.disabled=false);await refreshAuthorizations();if(editingRequest)updateAuthorizationScope();if(message)authorizationNotice(message,errorState);}
}
$('authorization-refresh').addEventListener('click',refreshAuthorizations);
for(const id of ['authorization-cancel','authorization-close'])$(id).addEventListener('click',()=>{if(!authorizationBusy)closeAuthorization();});
$('authorization-editor').addEventListener('cancel',event=>{event.preventDefault();if(!authorizationBusy)closeAuthorization();});
function canAutoRefresh(){return $('authorization-auto').checked&&magpie.visible&&!editingRequest&&!authorizationBusy&&!revocationOpen&&!rangeOpen&&!rejectionOpen;}
function updateRecentRefreshNotice(){if(recentSummary){$('recent-sessions-notice').textContent=recentSummary;$('recent-sessions-refresh-status').textContent=`更新于 ${recentReadAt}`+($('authorization-auto').checked?' · 每10秒刷新':' · 已暂停');}}
$('authorization-auto').addEventListener('change',()=>{updateRecentRefreshNotice();if(canAutoRefresh())refreshAuthorizations();});
$('authorization-form').addEventListener('change',updateAuthorizationScope);
$('authorization-file').addEventListener('change',async()=>{const file=$('authorization-file').files[0];if(!file)return;$('authorization-name-list').value='';if(file.size>2*1024*1024){$('authorization-file-status').textContent='文件超过 2 MiB，请缩小名单。';return;}try{$('authorization-name-list').value=await file.text();$('authorization-file-status').textContent='已在本机读取文件，请核对范围后确认。';}catch{$('authorization-file-status').textContent='无法读取文件，请重新选择 UTF-8 文本文件。';}});
// The service deliberately disallows native form submission in its sandbox.
// A trusted button click uses the existing explicit-consent and signed API path.
$('authorization-form').addEventListener('submit',event=>event.preventDefault());
$('authorization-approve').addEventListener('click',event=>{if(!event.isTrusted||!editingRequest||!$('authorization-consent').checked)return;const coverage=$('authorization-form').elements.coverage.value,names=$('authorization-name-list').value.split(/[\n；;]/).map(n=>n.trim()).filter(Boolean);saveAuthorization({action:'approve',requestId:editingRequest.id,coverage,names:coverage==='names'?names:[]});});

async function start(){try{await magpie.ready;const options=await magpie.options.get();readKey=options.receiptReadKey;authorizationKey=options.authorizationKey;if(!/^[a-f0-9]{64}$/.test(readKey||"")||!/^[a-f0-9]{64}$/.test(authorizationKey||""))throw new Error("授权服务尚未配置，请联系维护。");base=new URL(".",location.href).href;await refreshAuthorizations();magpie.onVisibility?.(visible=>{if(visible&&canAutoRefresh())refreshAuthorizations();});setInterval(()=>{if(canAutoRefresh())refreshAuthorizations();},10000);}catch(error){authorizationNotice(error.message||"授权服务暂不可用，请重新打开此页。",true);}}
start();

async function refreshAuthorizationHistory(){
  if(!$('authorization-history').parentElement.open)return;
  try{const data=await api('audit');$('authorization-history').replaceChildren();
    for(const row of data.authorizations){const line=el('p',undefined,'history-row'),time=el('time',new Date(row.at).toLocaleString('zh-CN'));time.dateTime=row.at;
      const content=el('span',({approve:'批准放行',revoke:'恢复脱敏',reject:'拒绝申请'}[row.action]||row.action)+' · 会话 '+short(row.session)+' · '+(row.action==='reject'?'保持原有授权设置':row.action==='revoke'?'恢复默认脱敏':row.coverage==='all'?'全部名称':row.nameCount+' 个名称'));
      if(row.reapplyRequestId){const button=el('button','重新申请','view history-reapply');button.type='button';button.setAttribute('aria-label','重新申请 '+row.session);button.title='沿用上次已核验的工作目录，仅创建新申请，仍须重新确认';button.addEventListener('click',event=>{if(event.isTrusted)requestFromReceipt(row,button);});content.append(button);}
      line.append(time,content);$('authorization-history').append(line);}
    if(!data.authorizations.length)$('authorization-history').textContent='暂无可用记录。';
  }catch{$('authorization-history').textContent='记录暂时无法读取，请重新展开重试。';}
}
$('authorization-history').parentElement.addEventListener('toggle',refreshAuthorizationHistory);
