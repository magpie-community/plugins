import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const errors=[];
const roots=['backend','page','ui','licenses'];
const files=fs.readdirSync(root).filter(n=>/\.(mjs|py)$/.test(n)||['README.md','LICENSE','THIRD_PARTY_NOTICES.md','requirements.txt','package.json'].includes(n));
function walk(d){for(const e of fs.readdirSync(path.join(root,d),{withFileTypes:true})){const p=path.join(d,e.name);if(e.name==='__pycache__')continue;if(e.isDirectory())walk(p);else files.push(p);}}
roots.forEach(walk);
files.push('scripts/setup.ps1','scripts/doctor.mjs');
for(const file of files){
 if(!/\.(mjs|py|js|json|md|txt|html|css|ps1|svg)$/.test(file)&&!file.endsWith('LICENSE'))continue;
 const text=fs.readFileSync(path.join(root,file),'utf8');
 if(/C:\/Users\/Lenovo|D:\/AG-tools|D:\/tools|wkksk\.site|mcp\/run\/grok-search|\.\.\/magpie-grok-search\.mjs/.test(text))errors.push(file+': local dependency');
 if(text.includes('\uFFFD'))errors.push(file+': invalid text');
}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
if(pkg.license!=='MIT'||!pkg.files?.length)errors.push('missing license/file allowlist');
if(errors.length)throw Error(errors.join('\n'));
console.log(JSON.stringify({sourceAudit:'passed',checkedFiles:files.length}));
