const $=id=>document.getElementById(id);
const errors={invalid_rules:'规则格式不正确，请检查名称和别名。',invalid_names:'名称须为2至120个字符，包含中文或字母，不能使用纯数字或脱敏代号。',too_many_names:'名称和别名合计最多512个，请缩小范围。',duplicate_names:'名称或别名重复，请保留一处。',rules_changed:'规则刚被其他窗口修改。请先刷新，再重新编辑。',rules_unavailable:'本机规则服务暂不可用，请稍后刷新。'};
let base,readKey,writeKey,nonce,revision,rules=[],baseline='',editing=null,formBaseline='',removing=null,busy=false,loaded=false,leaveAction=null;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const json=value=>JSON.stringify(canonical(value));
const terms=row=>typeof row==='string'?{name:row,aliases:[]}:{name:row.name,aliases:row.aliases||[]};
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function notice(text,error=false){$('rule-notice').textContent=text;$('rule-notice').className=error?'error':'';}
function editorNotice(text,error=false){$('editor-message').textContent=text;$('editor-message').className=error?'error':'';}
const aliasInputs=()=>[...$('rule-aliases').querySelectorAll('input')];
function draft(){return {name:$('rule-name').value,aliases:aliasInputs().map(input=>input.value)};}
function markDraft(){$('draft-state').textContent=dirty()?'有未保存的修改':'当前生效内容';editorNotice('');}
function numberAliases(){
  [...$('rule-aliases').children].forEach((row,index)=>{
    row.querySelector('label').textContent=`简称或别名 ${index+1}`;
    row.querySelector('button').setAttribute('aria-label',`移除简称或别名 ${index+1}`);
  });
  $('alias-count').textContent=`${aliasInputs().filter(input=>input.value.trim()).length} 个已填写`;
}
let aliasSerial=0;
function addAlias(value='',focus=true,after=null){
  if(aliasInputs().length>=511){editorNotice('名称和别名合计最多512个，请减少条目。',true);return null;}
  const row=el('div',undefined,'alias-input-row'),label=el('label'),input=el('input'),remove=el('button','移除');
  input.type='text';input.id='alias-'+(++aliasSerial);input.maxLength=120;input.autocomplete='off';input.spellcheck=false;input.value=value;input.setAttribute('aria-describedby','alias-help');label.htmlFor=input.id;remove.type='button';
  remove.addEventListener('click',()=>{if(busy)return;row.remove();if(!$('rule-aliases').children.length)addAlias('',false);numberAliases();markDraft();});
  input.addEventListener('input',numberAliases);
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();if(input.value.trim()&&addAlias('',true,row))markDraft();}});
  input.addEventListener('paste',event=>{
    const values=event.clipboardData?.getData('text/plain').split(/\r\n|\r|\n/).map(text=>text.trim()).filter(Boolean)||[];
    if(values.length<2)return;event.preventDefault();if(aliasInputs().length+values.length-1>511){editorNotice('名称和别名合计最多512个，请减少条目。',true);return;}input.value=values[0];let previous=row;
    for(const text of values.slice(1))previous=addAlias(text,false,previous);
    numberAliases();markDraft();
  });
  row.append(label,input,remove);if(after)after.after(row);else $('rule-aliases').append(row);numberAliases();if(focus)input.focus();return row;
}
function dirty(){return editing!==null&&json(draft())!==formBaseline;}
function setBusy(value){busy=value;document.querySelectorAll('main button,main input,main textarea').forEach(node=>node.disabled=value||(!loaded&&node.getAttribute('role')!=='tab'));}
async function api(route,body,timeout=8000){
  const response=await fetch(new URL(route,base),{method:body===undefined?'GET':'POST',headers:body===undefined?{'X-Receipt-Key':readKey}:{'X-Receipt-Key':readKey,'X-Authorization-Key':writeKey,'X-Authorization-Nonce':nonce,'Content-Type':'application/json'},body:body===undefined?undefined:json(body),cache:'no-store',signal:AbortSignal.timeout(timeout)});
  const result=await response.json();if(!response.ok){let message=errors[result.error]||'读取或保存未完成，请刷新核对。';if(result.error==='duplicate_names'&&Array.isArray(result.conflicts))message+=' 冲突位置：'+result.conflicts.map(v=>'第'+v.rule+'条规则的'+(v.field?'别名'+v.field:'名称')).join('、');throw new Error(message);}return result;
}
function render(){
  const query=$('rule-search').value.trim().toLowerCase();
  const rows=rules.map((rule,index)=>({rule,index})).filter(({rule})=>{const row=terms(rule);return [row.name,...row.aliases].some(value=>value.toLowerCase().includes(query));});
  $('rule-count').textContent=`${rules.length} 条自定义规则 · ${rules.reduce((sum,row)=>sum+terms(row).aliases.length+1,0)} 个名称及别名`;
  $('rule-rows').replaceChildren(...rows.map(({rule,index})=>{
    const row=terms(rule),tr=el('tr'),name=el('td',row.name),aliases=el('td'),actions=el('td',undefined,'rule-operations');
    if(row.aliases.length)row.aliases.forEach(value=>aliases.append(el('span',value,'rule-alias')));else aliases.append(el('span','未设置别名','no-alias'));
    for(const [label,action]of [['编辑',()=>openEditor(index)],['移除',()=>openRemove(index)]]){
      const button=el('button',label);button.type='button';button.setAttribute('aria-label',label+'规则 '+row.name);button.addEventListener('click',event=>{if(event.isTrusted&&!busy)guard(action);});actions.append(button);
    }
    tr.append(name,aliases,actions);return tr;
  }));
  $('rule-empty').hidden=rows.length>0;$('rule-empty').textContent=rules.length?'没有匹配的名称或别名。':'尚未设置自定义规则，内置识别仍在生效。';
}
async function load(){
  if(busy)return;setBusy(true);
  try{
    const options=await magpie.options.get(),current=options.companies||[];
    readKey=options.receiptReadKey;writeKey=options.authorizationKey;
    if(!/^[a-f0-9]{64}$/.test(readKey||'')||!/^[a-f0-9]{64}$/.test(writeKey||''))throw new Error('本机规则服务尚未就绪，请重新打开插件。');
    const state=await api('rules');nonce=state.nonce;
    const checked=await api('rules/validate',{revision:state.revision,companies:current});
    if(checked.revision!==state.revision)throw new Error('配置已保存，本机服务尚未同步。请稍后刷新。');
    rules=structuredClone(current);baseline=json(current);revision=state.revision;loaded=true;closeEditor();render();notice('已读取当前生效规则。');
  }catch(error){notice(error.message||'无法读取规则，请重新打开插件。',true);}
  finally{setBusy(false);$('refresh-rules').disabled=false;}
}
function closeEditor(){editing=null;removing=null;leaveAction=null;$('rule-editor').hidden=true;$('remove-panel').hidden=true;$('leave-panel').hidden=true;editorNotice('');}
function openEditor(index){
  closeEditor();editing=index;const row=index===-1?{name:'',aliases:[]}:terms(rules[index]);
  $('editor-title').textContent=index===-1?'新增规则':'编辑规则';$('rule-name').value=row.name;$('rule-aliases').replaceChildren();for(const alias of row.aliases.length?row.aliases:[''])addAlias(alias,false);formBaseline=json(draft());
  $('draft-state').textContent=index===-1?'填写后保存生效':'当前生效内容';$('rule-editor').hidden=false;$('rule-name').focus();
}
function openRemove(index){closeEditor();removing=index;$('remove-name').textContent=terms(rules[index]).name;$('remove-panel').hidden=false;$('cancel-remove').focus();}
function guard(action){if(busy){notice('正在保存，请稍候。');return;}if(!dirty()){action();return;}leaveAction=action;$('leave-panel').hidden=false;$('stay-edit').focus();}
async function waitForReload(expected){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){try{const state=await api('rules',undefined,1000);if(state.revision===expected){nonce=state.nonce;return;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}
  throw new Error('规则已提交，尚未确认服务生效。请刷新核对，不要重复保存。');
}
async function save(next){
  if(busy)return;setBusy(true);editorNotice('正在校验并保存…');notice('正在保存…');let submitted=false;
  try{
    const before=await magpie.options.get();if(json(before.companies||[])!==baseline)throw new Error(errors.rules_changed);
    const state=await api('rules');nonce=state.nonce;if(state.revision!==revision)throw new Error(errors.rules_changed);
    const checked=await api('rules/validate',{revision,companies:next});
    const latest=await magpie.options.get();if(json(latest.companies||[])!==baseline)throw new Error(errors.rules_changed);
    if(json(next)===baseline){closeEditor();notice('内容与当前规则一致，无需保存。');return;}
    try{await magpie.options.set({...latest,companies:next});submitted=true;}
    catch(error){const saved=await magpie.options.get();if(json(saved.companies||[])!==json(next))throw error;submitted=true;}
    await waitForReload(checked.revision);
    const saved=await magpie.options.get();if(json(saved.companies||[])!==json(next))throw new Error('保存后规则再次发生变化，请刷新核对。');
    rules=structuredClone(next);baseline=json(next);revision=checked.revision;closeEditor();render();notice('已保存并生效，后续请求使用新规则。');
  }catch(error){const message=error.message||'保存未完成，请刷新核对。';notice(message,true);editorNotice(message,true);if(submitted)$('draft-state').textContent='已提交，待核对';}
  finally{setBusy(false);}
}
function saveEditor(){
  if(editing===null||!$('rule-form').reportValidity())return;
  const name=$('rule-name').value.trim(),aliases=aliasInputs().map(input=>input.value.trim()).filter(Boolean);
  const next=structuredClone(rules),prior=editing===-1?null:next[editing];
  const value=prior&&typeof prior==='object'?{...prior,name,aliases}:{name,aliases};
  if(editing===-1)next.push(value);else next[editing]=value;save(next);
}
function showRuleView(view){
  closeEditor();
  for(const kind of ['builtin','custom']){const selected=kind===view;$(kind+'-view').hidden=!selected;$(kind+'-tab').setAttribute('aria-selected',String(selected));$(kind+'-tab').tabIndex=selected?0:-1;}
  $(view+'-tab').focus();
}
for(const kind of ['builtin','custom']){
  $(kind+'-tab').addEventListener('click',()=>{if($(kind+'-tab').getAttribute('aria-selected')!=='true')guard(()=>showRuleView(kind));});
  $(kind+'-tab').addEventListener('keydown',event=>{
    const next=event.key==='Home'?'builtin':event.key==='End'?'custom':['ArrowLeft','ArrowRight'].includes(event.key)?(kind==='builtin'?'custom':'builtin'):null;
    if(next){event.preventDefault();if(next!==kind)guard(()=>showRuleView(next));}
  });
}
$('add-rule').addEventListener('click',event=>{if(event.isTrusted)guard(()=>openEditor(-1));});
$('refresh-rules').addEventListener('click',()=>guard(load));
$('rule-search').addEventListener('input',render);
$('rule-form').addEventListener('submit',event=>event.preventDefault());
$('rule-form').addEventListener('input',markDraft);
$('add-alias').addEventListener('click',event=>{if(event.isTrusted&&!busy&&addAlias())markDraft();});
$('save-rule').addEventListener('click',event=>{if(event.isTrusted)saveEditor();});
$('cancel-edit').addEventListener('click',()=>guard(closeEditor));
$('cancel-remove').addEventListener('click',closeEditor);
$('confirm-remove').addEventListener('click',event=>{if(event.isTrusted&&removing!==null)save(rules.filter((_,index)=>index!==removing));});
$('stay-edit').addEventListener('click',()=>{$('leave-panel').hidden=true;leaveAction=null;$('rule-name').focus();});
$('discard-edit').addEventListener('click',()=>{const action=leaveAction;closeEditor();action?.();});
document.querySelectorAll('.tabs a').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();guard(()=>{location.href=link.href;});}));
window.addEventListener('beforeunload',event=>{if(dirty()||busy){event.preventDefault();event.returnValue='';}});
async function start(){try{await magpie.ready;base=new URL('.',location.href).href;await load();magpie.onVisibility?.(visible=>{if(visible&&!dirty()&&editing===null&&removing===null&&!busy)load();});}catch{notice('无法连接插件配置，请重新打开此页。',true);$('refresh-rules').disabled=false;}}
start();

$('rule-history').parentElement.addEventListener('toggle',async()=>{
  if(!$('rule-history').parentElement.open)return;
  try{const data=await api('audit');$('rule-history').replaceChildren();
    for(const row of data.rules){const line=el('p',undefined,'history-row'),time=el('time',new Date(row.at).toLocaleString('zh-CN'));time.dateTime=row.at;
      line.append(time,el('span',row.ruleCount+' 条规则 · '+row.nameCount+' 个名称 · 版本 '+row.revision.slice(0,12)));$('rule-history').append(line);}
    if(!data.rules.length)$('rule-history').textContent='暂无可用记录。';
  }catch{$('rule-history').textContent='记录暂时无法读取，请重新展开重试。';}
});
