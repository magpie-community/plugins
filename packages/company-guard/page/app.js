const $ = id => document.getElementById(id);
const short = value => value ? value.slice(0,8) : '未知';
const scopeNames = {user:'用户文字',history:'历史',instructions:'指令',tool_results:'工具结果',tool_arguments:'工具参数',tool_schema:'工具说明'};
const count = value => value ?? '—';
const label = status => status==='已替换，回复处理完成'?'已替换 · 回复完成':status;
const statusOf = r => r.statusLabel || r.status;
const agentsOf = r => r.agentIds?.length ? r.agentIds : [r.agent || 'unknown'];
let report=null,busy=false,pageVisible=true,base,readKey,expanded=null,expiryTimer;
function el(tag,text,cls) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function agentRows() {const selected=$('agent').value;return (report?.rows || []).filter(r=>!selected || agentsOf(r).includes(selected));}
function updateTasks() {
  const selected=$('task').value,tasks=new Map(),rows=agentRows();
  for(const r of rows){const id=r.task || r.thread || '';if(id)tasks.set(id,(tasks.get(id)||0)+1);}
  $('task').replaceChildren(new Option('全部任务',''));
  for(const [id,n] of tasks){const title=rows.find(r=>(r.task || r.thread)===id)?.taskTitle,option=new Option(`${title || '会话 '+short(id)} · ${short(id)} · ${n} 条`,id);option.title=id;$('task').add(option);}
  if(tasks.has(selected))$('task').value=selected;
}
function updateAgents() {
  const selected=$('agent').value,previousLabel=$('agent').selectedOptions[0]?.textContent;
  const choices=new Map((report?.agentOptions || []).map(a=>[a.id,a.label]));
  for(const r of report?.rows || [])for(const id of agentsOf(r))if(!choices.has(id))choices.set(id,r.agentLabel || (id==='unknown'?'来源未记录':id));
  // Keep an explicitly selected agent when its requests leave the recent window.
  if(selected&&!choices.has(selected))choices.set(selected,previousLabel || selected);
  $('agent').replaceChildren(new Option('全部智能体',''));
  for(const [id,name] of choices)$('agent').add(new Option(name,id));
  if(choices.has(selected))$('agent').value=selected;
  updateTasks();
}
function updateNotice() {
  if(!report || $('notice').classList.contains('error'))return;
  const tasks=new Set(agentRows().map(r=>r.task || r.thread).filter(Boolean));
  const mode=expanded?'查看明细时暂停刷新':$('auto').checked?'每10秒刷新':'自动刷新已暂停';
  $('notice').textContent=`更新于 ${new Date(report.readAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · ${tasks.size} 个任务 · ${mode}`;
}
async function api(route,params={}) {
  const url=new URL(route,base);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
  const response=await fetch(url,{headers:{'X-Receipt-Key':readKey},cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('read_failed');return response.json();
}
function closeDetail() {
  clearTimeout(expiryTimer);document.querySelector('.detail-row')?.remove();
  const button=document.querySelector('button[aria-expanded="true"]');if(button){button.textContent='查看';button.setAttribute('aria-expanded','false');}expanded=null;updateNotice();
}
async function showDetail(r,tr,button) {
  if(expanded===r.id){closeDetail();return;}closeDetail();expanded=r.id;updateNotice();
  button.textContent='收起';button.setAttribute('aria-expanded','true');
  const row=el('tr',undefined,'detail-row'),cell=el('td'),content=el('div',undefined,'detail-pairs'),meta=el('div',undefined,'detail-meta');cell.colSpan=7;row.id='detail-'+r.id;button.setAttribute('aria-controls',row.id);
  cell.append(el('div','替换内容','detail-title'),content);content.append(el('p','正在读取本机明细…','detail-message'));
  for(const [k,v] of [['智能体',r.agentLabel || '来源未记录'],['处理结果',label(statusOf(r))],['同步检查',r.requestChecked?'已确认':'缺少确认'],['回复处理',r.replyProcessingOK===true?'成功':r.replyProcessingOK===false?'未成功':'缺少确认'],['完成确认',r.completionSource==='stream'?'流式回复已正常结束':r.hostCompletionObserved===true?'宿主已完成':r.hostCompletionObserved===false?'调用未完成':'尚未取得']])meta.append(el('span',k+'：'+v));
  for(const [key,s] of Object.entries(r.scopes || {}))meta.append(el('span',`${scopeNames[key] || key} ${s.replacements} 处 / 检查 ${s.checkedTexts} 段`));
  cell.append(meta);if(r.statusReason)cell.append(el('p',r.statusReason,'detail-message'));
  cell.append(el('div',`任务 ${r.taskTitle ? r.taskTitle+' · ' : ''}${r.task || r.thread || '未知'} · 请求 ${r.id} · 插件 ${r.version || '未知'}`,'identity mono'));row.append(cell);tr.after(row);
  try {
    const d=await api('details',{id:r.id});if(expanded!==r.id || !row.isConnected)return;
    content.replaceChildren();
    if(!d.available){content.append(el('p','未保留明细或已过期。新请求的原名称与代号可查看 30 分钟，重启后清空。','detail-message'));return;}
    if(!d.pairs.length){content.append(el('p','本次没有名称替换。','detail-message'));return;}
    const table=el('table',undefined,'pairs'),head=el('thead'),hr=el('tr');hr.append(el('th','替换前'),el('th','替换后的代号'));head.append(hr);table.append(head);const body=el('tbody');
    for(const pair of d.pairs){const line=el('tr');line.append(el('td',pair.original),el('td',pair.token,'mono'));body.append(line);}table.append(body);content.append(table);
    expiryTimer=setTimeout(()=>{if(expanded===r.id)content.replaceChildren(el('p','明细已过期，回执数量仍可核对。','detail-message'));},Math.max(0,d.expiresAt-Date.now()));
  } catch {if(expanded===r.id)content.replaceChildren(el('p','明细服务暂时不可用，请稍后刷新重试。','detail-message'));}
}
function render() {
  closeDetail();const selected=$('task').value;
  const rows=agentRows().filter(r=>!selected || (r.task || r.thread || '')===selected);
  $('totals').replaceChildren();
  for(const [n,name] of [[rows.length,'请求'],[rows.filter(r=>r.status==='已替换，回复处理完成').length,'替换与回复完成'],[rows.filter(r=>r.status==='未确认' && statusOf(r)!=='调用未完成').length,'证据待齐'],[rows.filter(r=>statusOf(r)==='调用未完成').length,'调用未完成'],[rows.filter(r=>r.status==='处理失败').length,'失败']]){const v=el('span');v.append(el('b',n),document.createTextNode(name));$('totals').append(v);}
  const diagnosticCount=report?.diagnostics?.observed || 0;$('diagnostics').hidden=!diagnosticCount;
  $('diagnostics').textContent=diagnosticCount?`当日跨任务记录到 ${diagnosticCount} 次插件处理超时或异常；日志没有请求编号，无法归到某一条回执。`:'';
  $('rows').replaceChildren();
  for(const r of rows){
    const tr=el('tr'),d=new Date(r.at),time=el('td',Number.isNaN(d.getTime())?'未知':d.toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));time.title=r.at || '';tr.append(time);
    tr.append(el('td',r.agentLabel || '来源未记录','agent-source'));
    const ids=el('td'),task=el('span',r.taskTitle || '会话 '+short(r.task || r.thread),'task-name');task.title=r.taskTitle || r.task || r.thread || '未知';ids.append(task,el('span',short(r.task || r.thread)+' / '+short(r.id),'mono muted'));ids.title=(r.task || r.thread || '未知')+' / '+r.id;tr.append(ids);
    tr.append(el('td',count(r.replacedNames)+' / '+count(r.replacements),'number'),el('td',count(r.restoredNames),'number'),el('td',r.processingMs==null?'—':r.processingMs+' ms','number'));
    const cell=el('td'),button=el('button','查看','view');button.type='button';button.setAttribute('aria-expanded','false');button.addEventListener('click',()=>showDetail(r,tr,button));cell.append(button);tr.append(cell);$('rows').append(tr);
  }
  $('empty').hidden=rows.length!==0;
}
async function refresh() {
  if(busy)return;const requestedDay=$('date').value;busy=true;$('refresh').disabled=true;$('notice').className='';$('notice').textContent='读取中…';
  try {
    const next=await api('receipts',{date:requestedDay});if(requestedDay!==$('date').value)return;report=next;updateAgents();
    render();updateNotice();
  } catch {$('notice').className='error';$('notice').textContent=report?'读取失败，下方为上次结果；请刷新重试。':'读取失败，请刷新重试。';}
  finally {busy=false;$('refresh').disabled=false;if(requestedDay!==$('date').value)refresh();}
}
$('date').value=new Date().toISOString().slice(0,10);$('filters').addEventListener('submit',e=>e.preventDefault());$('date').addEventListener('change',()=>{refresh();});
$('agent').addEventListener('change',()=>{updateTasks();render();if(!busy)updateNotice();});
$('task').addEventListener('change',render);$('refresh').addEventListener('click',refresh);
$('auto').addEventListener('change',()=>{if($('auto').checked&&pageVisible&&!expanded)refresh();else if(!busy)updateNotice();});
async function start(){try{await magpie.ready;const options=await magpie.options.get();readKey=options.receiptReadKey;
if(!/^[a-f0-9]{64}$/.test(readKey||""))throw new Error("not_configured");base=new URL(".",location.href).href;pageVisible=magpie.visible;
magpie.onVisibility?.(value=>{pageVisible=value;if(!value)closeDetail();else if($('auto').checked&&!expanded)refresh();});await refresh();setInterval(()=>{if($("auto").checked&&pageVisible&&!expanded)refresh();},10000);
}catch{$("notice").className="error";$("notice").textContent="未连接回执服务，请重新打开此页。";$("refresh").disabled=true;}}
start();
