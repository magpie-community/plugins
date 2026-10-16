// Local OAuth pages use self-contained assets: no external fonts, scripts or
// images, and no account credentials in the DOM. All server values are escaped.
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const styles = `
:root{
  color-scheme:light;
  --ink:#0f172b;--muted:#59677c;--line:#e2e7f0;
  --accent:#4f3cd8;--accent-text:#fff;--accent-hover:#4230c0;
  --accent-end:#666dee;--wash:#eef0ff;--paper:#fff;--bg:#f7f9fd;
  --input:#fff;--footer:#f9faff;--error-bg:#fff2f0;--error-ink:#a4322c;
  --notice-ink:#3d4780;--focus:#766ae6;--placeholder:#748095;
  --glow-blue:#eaf0ff;--glow-purple:#eeebff;
  --shadow:0 12px 40px rgba(46,49,109,.06);
}
@media(prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --ink:#edf0fa;--muted:#a7b1c6;--line:#343c53;
    --accent:#b8afff;--accent-text:#fff;--accent-hover:#5945d7;
    --accent-end:#666dee;--wash:#292d4c;--paper:#1c2335;--bg:#121827;
    --input:#171e2f;--footer:#192031;--error-bg:#3d252e;--error-ink:#ffb4ae;
    --notice-ink:#c9ceff;--focus:#b8afff;--placeholder:#97a2b8;
    --glow-blue:#1c2845;--glow-purple:#26223d;
    --shadow:0 12px 40px rgba(0,0,0,.18);
  }
}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{
  margin:0;min-height:100dvh;color:var(--ink);background-color:var(--bg);
  background-image:radial-gradient(ellipse at 12% 0%,var(--glow-blue),transparent 55%),radial-gradient(ellipse at 95% 15%,var(--glow-purple),transparent 50%);
  font-family:"PingFang SC","PingFang TC",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;
  font-size:14px;line-height:1.6;display:flex;
}
a{color:var(--accent)}
button,input,select{font:inherit}
button,input,select,summary{outline-offset:2px}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--focus)}
input:focus-visible,.picker-trigger:focus-visible{outline:0;border-color:var(--focus);box-shadow:0 0 0 3px var(--wash)}
button{cursor:pointer;transition:background .16s,box-shadow .16s}
button:disabled{cursor:wait;opacity:.65}
.shell{width:100%;max-width:520px;margin:auto;padding:40px 20px}
.brand{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 4px 20px}
.brand strong{display:block;font-size:21px;font-weight:650;letter-spacing:-.6px}
.brand strong span{color:var(--accent);font-size:14px;font-weight:500;letter-spacing:0;margin-left:6px}
.brand small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.brand-label{color:var(--muted);font-size:12px;white-space:nowrap}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
.content{padding:32px}
.steps{display:flex;align-items:center;gap:12px;list-style:none;margin:0 0 24px;padding:0;color:var(--muted);font-size:12px}
.steps li{display:flex;align-items:center;gap:8px}
.steps li+li::before{content:"";width:24px;height:1px;background:var(--line);margin-right:4px}
.steps span{width:20px;height:20px;display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;font-size:11px}
.steps [aria-current=step]{color:var(--accent);font-weight:600}
.steps [aria-current=step] span{background:#4f3cd8;border-color:#4f3cd8;color:#fff}
.eyebrow{display:inline-block;font-size:11px;color:var(--accent);background:var(--wash);border-radius:4px;padding:3px 8px;margin:0 0 12px;font-weight:500}
h1{margin:0;font-size:24px;line-height:1.4;letter-spacing:-.4px;font-weight:600;text-wrap:balance}
.intro{color:var(--muted);margin:8px 0 24px;text-wrap:balance}
.field{margin:0 0 16px}
label{display:block;font-size:13px;font-weight:500;margin-bottom:8px}
.hint{font-size:12px;color:var(--muted);margin:8px 0 0;line-height:1.6}
input,select{display:block;width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:4px;background:var(--input);color:var(--ink);font-size:14px;line-height:22px}
input:hover,select:hover{border-color:var(--focus)}
input::placeholder{color:var(--placeholder)}
select{padding-right:32px}
.picker{position:relative}
.picker-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:4px;background:var(--input);color:var(--ink);text-align:left;font-size:14px;line-height:22px}
.picker-trigger:hover,.picker-trigger[aria-expanded=true]{border-color:var(--focus)}
.picker-trigger[aria-invalid=true]{border-color:var(--error-ink)}
.picker-value{min-width:0;flex:1;display:flex;align-items:center;gap:12px}
.picker-value strong{min-width:0;flex:1;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.picker-value small{max-width:40%;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.picker-option strong{display:block;font-weight:500;overflow-wrap:anywhere;line-height:20px}
.picker-option small{display:block;color:var(--muted);font-size:11px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;line-height:16px}
.picker-placeholder{color:var(--placeholder)}
.picker-arrow{width:7px;height:7px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(45deg);margin:0 3px 4px 0;flex-shrink:0}
.picker-trigger[aria-expanded=true] .picker-arrow{transform:rotate(225deg);margin-top:6px}
.picker-popup{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:2;background:var(--paper);border:1px solid var(--line);border-radius:6px;box-shadow:0 8px 24px rgba(46,49,109,.16);padding:6px}
.picker-up .picker-popup{top:auto;bottom:calc(100% + 6px)}
.picker-popup .field{margin:4px 4px 8px}.picker-popup label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.picker-popup input{min-height:36px;padding:6px 10px;font-size:13px}.picker-popup .hint{font-size:11px}.picker-popup .hint:empty{display:none}
.picker-options{max-height:min(240px,30dvh);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;list-style:none;margin:0;padding:0}
.picker-option{position:relative;padding:6px 32px 6px 10px;border-radius:4px;cursor:pointer;font-size:13px}
.picker-option:hover,.picker-option.is-active{background:var(--wash)}
.picker-option[aria-selected=true]{color:var(--accent);background:var(--wash)}
.picker-option[aria-selected=true]::after{content:"✓";position:absolute;right:12px;top:12px;color:var(--accent)}
.picker-empty{padding:16px 11px;color:var(--muted);font-size:13px;text-align:center}
.picker-error{color:var(--error-ink);font-size:13px;margin:8px 0 0}
.actions{display:flex;align-items:center;gap:12px;margin-top:20px}
.primary{width:100%;border:0;border-radius:4px;background:linear-gradient(180deg,#482dd1,var(--accent-end));box-shadow:0 4px 6px -2px rgba(76,52,212,.2);color:var(--accent-text);padding:10px 16px;font-weight:500;min-height:44px;line-height:24px}
.primary:hover{background:linear-gradient(180deg,var(--accent-hover),#5961dc);box-shadow:0 4px 10px -2px rgba(76,52,212,.3)}
.secondary{border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:4px;padding:9px 14px;min-height:42px}
.secondary:hover{background:var(--wash);border-color:var(--focus)}
.text-button{padding:0;border:0;background:transparent;color:var(--accent);font-size:13px}
.text-button:hover{text-decoration:underline}
.context{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--footer);border-radius:4px;padding:10px 12px;margin-bottom:20px}
.context strong{display:block;font-size:13px;font-weight:500;overflow-wrap:anywhere}
.context small{display:block;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.context form{flex-shrink:0}
details{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
summary{display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--muted);font-weight:500;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);flex-shrink:0}
details[open] summary::before{transform:rotate(45deg)}
details[open] summary{margin-bottom:16px;color:var(--ink)}
details form{margin-top:16px}
.notice{padding:16px 18px;border:1px solid var(--line);border-radius:6px;background:var(--wash);font-size:14px;margin:18px 0;color:var(--notice-ink);overflow-wrap:anywhere}
.notice p{margin:0}.notice p+p{margin-top:8px}
.error{background:var(--error-bg);color:var(--error-ink);border-color:currentColor}
.footer{padding:12px 32px;border-top:1px solid var(--line);border-radius:0 0 12px 12px;color:var(--muted);font-size:11px;line-height:1.6;background:var(--footer)}
.caption{margin:16px 0 0;text-align:center;font-size:11px;color:var(--muted)}
.result-symbol{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:var(--wash);color:var(--accent);font-size:24px;margin-bottom:22px}
.error-symbol{background:var(--error-bg);color:var(--error-ink)}
.status{font-size:13px;color:var(--muted);margin:12px 0 0;min-height:1.65em}.status:empty{display:none}
.skip{position:absolute;top:-100px;left:20px}.skip:focus{top:12px;padding:6px 12px;background:var(--paper);z-index:1}
@media(max-width:480px){
  .shell{padding:24px 16px}.brand{margin-bottom:16px}.brand strong{font-size:20px}.brand-label{font-size:11px}
  .steps{gap:10px;font-size:12px}.steps li{gap:6px}.steps li+li::before{width:18px;margin-right:4px}
  h1{font-size:22px}.context{gap:10px}.content{padding:24px}.footer{padding:12px 24px}
  input,.picker-popup input{font-size:16px}
}
@media(prefers-reduced-motion:reduce){button{transition:none}}
`
const script = `
// Keep the native select as the submitted field and a no-script fallback.
document.querySelectorAll('select').forEach(select=>{
  const make=(tag,className)=>{const node=document.createElement(tag);if(className)node.className=className;return node;};
  const root=make('div','picker'),trigger=make('button','picker-trigger'),value=make('span','picker-value'),arrow=make('span','picker-arrow');
  const popup=make('div','picker-popup'),list=make('ul','picker-options'),error=make('p','picker-error');
  const label=document.querySelector('label[for="'+select.id+'"]');
  label.id=select.id+'-label';trigger.id=select.id+'-control';label.htmlFor=trigger.id;
  trigger.type='button';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-labelledby',label.id);
  trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-required',String(select.required));
  list.id=select.id+'-options';list.setAttribute('role','listbox');list.setAttribute('aria-labelledby',label.id);trigger.setAttribute('aria-controls',list.id);
  arrow.setAttribute('aria-hidden','true');trigger.append(value,arrow);popup.hidden=true;error.hidden=true;
  error.id=select.id+'-error';error.setAttribute('role','alert');trigger.setAttribute('aria-describedby',error.id);
  select.before(root);root.append(trigger,popup,select,error);select.hidden=true;
  let search=select.name==='project'?document.querySelector('[data-project-search]'):null;
  let searchField=search?.closest('.field');
  if(!search){
    searchField=make('div','field');const searchLabel=make('label');search=make('input');search.type='search';search.id=select.id+'-search';
    searchLabel.htmlFor=search.id;searchLabel.textContent=select.name==='project'?'搜索项目':'搜索 API Key';
    search.placeholder='按名称或 ID 搜索';search.autocomplete='off';searchField.append(searchLabel,search);
  }
  search.setAttribute('role','combobox');search.setAttribute('aria-controls',list.id);search.setAttribute('aria-expanded','false');search.setAttribute('aria-autocomplete','list');
  const status=searchField.querySelector('[data-search-status]')||make('p','hint');status.setAttribute('aria-live','polite');searchField.append(status);
  popup.append(searchField,list);
  const options=Array.from(select.options).filter(o=>o.value);
  let shown=[],active=-1;
  function describe(node,option){
    const text=option.textContent,split=text.lastIndexOf(' · ');node.replaceChildren();node.title=text;
    const name=make('strong');name.textContent=split<0?text:text.slice(0,split);node.append(name);
    if(split>=0){const id=make('small');id.textContent=text.slice(split+3);node.append(id);}
  }
  function sync(){
    const option=select.selectedOptions[0];value.classList.toggle('picker-placeholder',!select.value);
    if(select.value)describe(value,option);else value.textContent=option.textContent;
    error.hidden=true;trigger.removeAttribute('aria-invalid');
  }
  function highlight(index){
    active=index;Array.from(list.children).forEach((node,i)=>node.classList.toggle('is-active',i===active));
    [trigger,search].forEach(node=>active>=0?node.setAttribute('aria-activedescendant',list.children[active].id):node.removeAttribute('aria-activedescendant'));
    if(active>=0){const row=list.children[active].getBoundingClientRect(),box=list.getBoundingClientRect();if(row.top<box.top)list.scrollTop+=row.top-box.top;else if(row.bottom>box.bottom)list.scrollTop+=row.bottom-box.bottom;}
  }
  function render(){
    const term=search.value.trim().toLocaleLowerCase();shown=options.filter(o=>o.textContent.toLocaleLowerCase().includes(term));list.replaceChildren();
    shown.forEach((option,index)=>{
      const row=make('li','picker-option');row.id=select.id+'-option-'+options.indexOf(option);row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.value===select.value));describe(row,option);
      row.addEventListener('pointerdown',event=>event.preventDefault());
      row.addEventListener('click',()=>choose(index));list.append(row);
    });
    if(!shown.length){const empty=make('li','picker-empty');empty.setAttribute('role','presentation');empty.textContent='没有匹配结果，请换一个关键词。';list.append(empty);}
    status.textContent=term?'找到 '+shown.length+' 个结果':'';highlight(shown.length?Math.max(0,shown.findIndex(o=>o.value===select.value)):-1);
  }
  function close(restore=false){popup.hidden=true;trigger.setAttribute('aria-expanded','false');search.setAttribute('aria-expanded','false');[trigger,search].forEach(node=>node.removeAttribute('aria-activedescendant'));if(restore)trigger.focus();}
  function open(){
    popup.hidden=false;trigger.setAttribute('aria-expanded','true');search.setAttribute('aria-expanded','true');search.value='';render();
    const rect=trigger.getBoundingClientRect(),space=innerHeight-rect.bottom;
    root.classList.toggle('picker-up',space<popup.offsetHeight&&rect.top>space);search.focus();
  }
  function choose(index){if(!shown[index])return;select.value=shown[index].value;select.dispatchEvent(new Event('change',{bubbles:true}));close(true);}
  trigger.addEventListener('click',()=>popup.hidden?open():close());
  search.addEventListener('input',render);select.addEventListener('change',sync);
  root.addEventListener('keydown',event=>{
    const key=event.key;
    if(key==='Escape'&&!popup.hidden){event.preventDefault();close(true);}
    else if(key==='ArrowDown'||key==='ArrowUp'){
      event.preventDefault();if(popup.hidden)open();else if(shown.length)highlight((active+(key==='ArrowDown'?1:-1)+shown.length)%shown.length);
    }else if(key==='Enter'&&!popup.hidden){event.preventDefault();choose(active);}
    else if((key==='Home'||key==='End')&&event.target===trigger&&!popup.hidden&&shown.length){event.preventDefault();highlight(key==='Home'?0:shown.length-1);}
  });
  root.addEventListener('focusout',event=>{if(!root.contains(event.relatedTarget))close();});
  document.addEventListener('pointerdown',event=>{if(!root.contains(event.target))close();});
  select.addEventListener('invalid',event=>{event.preventDefault();error.textContent='请先选择'+label.textContent+'。';error.hidden=false;trigger.setAttribute('aria-invalid','true');open();});
  sync();
});
document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',event=>{const button=event.submitter;form.setAttribute('aria-busy','true');if(button)button.textContent=button.value==='back'?'返回中…':button.value==='create'?'正在创建并登录…':form.querySelector('[name="project"]')?'正在加载 API Key…':'正在完成登录…';setTimeout(()=>form.querySelectorAll('button').forEach(b=>b.disabled=true),0);}));
`

function documentPage(content, nonce, step) {
  const steps = step ? `<ol class="steps" aria-label="登录步骤"><li${step === 1 ? ' aria-current="step"' : ""}><span>1</span>选择项目</li><li${step === 2 ? ' aria-current="step"' : ""}><span>2</span>连接 API Key</li></ol>` : ""
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="在 Magpie 中连接 AstraFlow 的项目和 ModelVerse API Key"><title>AstraFlow · 连接 Magpie</title><style nonce="${escape(nonce)}">${styles}</style></head><body><a class="skip" href="#main">跳到主要内容</a><div class="shell"><header class="brand"><div><strong>AstraFlow<span>星图</span></strong><small>连接到 Magpie</small></div><span class="brand-label">账号连接</span></header><main id="main" class="panel"><div class="content">${steps}${content}</div><footer class="footer">此页面由本地 Magpie 插件提供。选择完成后，返回 Magpie 即可使用。</footer></main><p class="caption">AstraFlow / UCloud ModelVerse</p></div><script nonce="${escape(nonce)}">${script}</script></body></html>`
}
const hidden = (state) => `<input type="hidden" name="state" value="${escape(state)}">`
const form = (content, state) => `<form method="post" action="/select">${hidden(state)}${content}</form>`

export function projectPage(projects, state, nonce, selected) {
  const active = selected || projects.find((p) => p.default)?.id
  const search = projects.length > 8 ? `<div class="field"><label for="search">搜索项目</label><input id="search" type="search" data-project-search placeholder="按项目名称或 ID 搜索" autocomplete="off"><p class="hint" data-search-status aria-live="polite"></p></div>` : ""
  return documentPage(`<p class="eyebrow">UCloud 账号已授权</p><h1>选择要连接的项目</h1><p class="intro">API Key 属于具体项目。请选择你要在 Magpie 中使用的项目。</p>${form(`${search}<div class="field"><label for="project">项目</label><select id="project" name="project" required><option value="">请选择一个项目</option>${projects.map((p) => `<option value="${escape(p.id)}"${p.id === active ? " selected" : ""}>${escape(p.name)} · ${escape(p.id)}</option>`).join("")}</select><p class="hint">共 ${projects.length} 个可访问项目</p></div><div class="actions"><button class="primary" type="submit">继续，选择 API Key</button></div>`, state)}`, nonce, 1)
}

export function keyPage(project, keys, state, nonce) {
  const existing = keys.length ? form(`<div class="field"><label for="key">已有 API Key</label><select id="key" name="key" required><option value="">请选择一个可用的 Key</option>${keys.map((k) => `<option value="${escape(k.id)}">${escape(k.name)} · ${escape(k.id)}</option>`).join("")}</select><p class="hint">列表仅显示可用的 ModelVerse Key，密钥内容不会显示在页面中。</p></div><div class="actions"><button class="primary" name="mode" value="existing">使用此 Key 登录</button></div>`, state) : `<div class="notice" role="status"><p>这个项目中没有可用的 ModelVerse API Key。</p><p>可以切换项目，或在下方创建一个新的 Key。</p></div>`
  return documentPage(`<h1>连接你的 API Key</h1><p class="intro">${keys.length ? "选择已有 API Key，在 Magpie 中使用 AstraFlow 模型。" : "为这个项目创建 API Key，或返回选择其他项目。"}</p><div class="context"><div><strong>${escape(project.name)}</strong><small>${escape(project.id)}</small></div>${form('<button class="text-button" name="mode" value="back">更换项目</button>', state)}</div>${existing}<details${keys.length ? "" : " open"}><summary>创建新的 API Key</summary><p class="hint">新 Key 将获得全部 ModelVerse 模型的访问权限。Sandbox 权限请在 UCloud 控制台确认。仅在需要新 Key 时使用。</p>${form('<div class="field"><label for="name">新 Key 名称</label><input id="name" name="name" maxlength="64" required value="Magpie AstraFlow" autocomplete="off"></div><div class="actions"><button class="secondary" name="mode" value="create">创建并登录</button></div>', state)}</details>`, nonce, 2)
}

export function noticePage(kind, message, nonce) {
  const title = { success: "AstraFlow 已连接", error: "暂时无法完成登录", busy: "登录正在处理中", missing: "请从 Magpie 开始登录", manual: "复制回调地址，完成登录" }[kind] || "AstraFlow 登录"
  return documentPage(`<div class="result-symbol${kind === "error" ? " error-symbol" : ""}" aria-hidden="true">${kind === "success" ? "✓" : kind === "error" ? "!" : "→"}</div><h1>${title}</h1><div class="notice${kind === "error" ? " error" : ""}" role="${kind === "error" ? "alert" : "status"}"><p>${escape(message)}</p></div><p class="hint">${kind === "success" ? "可以关闭此标签页，返回 Magpie 选择模型并开始使用。" : kind === "manual" ? "复制浏览器地址栏中的完整 URL，然后粘贴到 Magpie 的回调输入框。" : kind === "error" ? "返回 Magpie 重新发起登录。" : "请返回 Magpie 查看登录状态。"}</p>`, nonce)
}
