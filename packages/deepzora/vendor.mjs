import{createRequire as _e}from"node:module";var ke=Object.create;var{getPrototypeOf:De,defineProperty:pe,getOwnPropertyNames:$e}=Object;var de=Object.prototype.hasOwnProperty;function Se(e){return this[e]}var Ie,Ne,qe=(e,r,i)=>{var o=e!=null&&typeof e==="object";if(o){var l=r?Ie??=new WeakMap:Ne??=new WeakMap,n=l.get(e);if(n)return n}i=e!=null?ke(De(e)):{};let t=r||!e||!e.__esModule||!de.call(e,"default")?pe(i,"default",{value:e,enumerable:!0}):i;if(e&&typeof e==="object"||typeof e==="function"){for(let f of $e(e))if(!de.call(t,f))pe(t,f,{get:Se.bind(e,f),enumerable:!0})}if(o)l.set(e,t);return t};var Pe=(e,r)=>()=>(r||e((r={exports:{}}).exports,r),r.exports);var P=_e(import.meta.url);var Oe=Pe(function(kr,Q){var ne=(e,r)=>()=>{try{return r||e((r={exports:{}}).exports,r),r.exports}catch(i){throw r=0,i}},ye=ne((e,r)=>{function i(l){return typeof l=="string"?!["false","0","no","off",""].includes(l.toLowerCase()):!!l}function o(l=process.env){let n={};for(let t of["ENCODING","PATH","QUIET","DEBUG","OVERRIDE","FAST"]){let f=l[`DOTENV_${t}`]!=null?l[`DOTENV_${t}`]:l[`DOTENV_CONFIG_${t}`];f!=null&&(n[t.toLowerCase()]=t==="ENCODING"||t==="PATH"?f:i(f))}return n}r.exports={parseBoolean:i,optionsFromEnv:o}}),Ee=ne((e,r)=>{var i=P("fs"),o=P("path"),l=P("os"),{URL:n,fileURLToPath:t}=P("url"),{parseBoolean:f,optionsFromEnv:v}=ye(),h=/(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg,p=new Uint8Array(256);for(let s=48;s<=57;s++)p[s]=1;for(let s=65;s<=90;s++)p[s]=1;for(let s=97;s<=122;s++)p[s]=1;p[45]=1,p[46]=1,p[95]=1;function c(s){let g={},a=s.toString();a=a.replace(/\r\n?/mg,`
`);let C;for(;(C=h.exec(a))!=null;){let u=C[1],y=C[2]||"";y=y.trim();let E=y[0];y=y.replace(/^(['"`])([\s\S]*)\1$/mg,"$2"),E==='"'&&(y=y.replace(/\\n/g,`
`),y=y.replace(/\\r/g,"\r")),g[u]=y}return g}function m(s){return s<=32?s===32||s>=9&&s<=13:s>=160&&(s===160||s===5760||s>=8192&&s<=8202||s===8232||s===8233||s===8239||s===8287||s===12288||s===65279)}function b(s){return s===10||s===8232||s===8233}function k(s){let g={},a=typeof s=="string"?s:s.toString();a.indexOf("\r")!==-1&&(a=a.replace(/\r\n?/g,`
`));let C=a.length,u=0;for(;u<C;){let y=a.charCodeAt(u);for(;u<C&&m(y);)u++,y=a.charCodeAt(u);if(u>=C)break;if(y===35){for(;u<C&&!b(a.charCodeAt(u));)u++;continue}let E=-1;if(y===101&&u+6<C&&a.charCodeAt(u+1)===120&&a.charCodeAt(u+2)===112&&a.charCodeAt(u+3)===111&&a.charCodeAt(u+4)===114&&a.charCodeAt(u+5)===116){let U=a.charCodeAt(u+6);if(m(U)){let O=u+7;for(;O<C&&m(a.charCodeAt(O));)O++;p[a.charCodeAt(O)]&&(E=u+6,u=O)}else y=a.charCodeAt(u)}let H=u,G=0;for(;u<C&&(G=a.charCodeAt(u),p[G]);)u++;if(u===H){for(;u<C&&!b(a.charCodeAt(u));)u++;continue}let oe=a.slice(H,u),ee=u;if(u>=C&&(G=0),m(G))do u++,G=u<C?a.charCodeAt(u):0;while(m(G));if(G===61)u++;else if(G===58&&u===ee&&u+1<C&&m(a.charCodeAt(u+1)))u+=2;else{for(u=E===-1?ee:E;u<C&&!b(a.charCodeAt(u));)u++;continue}let L=u,N=u;for(;N<C&&m(a.charCodeAt(N));)N++;let z=a.charCodeAt(N),q,le=!1;if(z===39||z===34||z===96){let U=a[N],O=a.indexOf(U,N+1),j=-1,B=-1;for(;O!==-1;){let K=a.charCodeAt(O-1)===92,Z=O+1;for(;Z<C&&!b(a.charCodeAt(Z))&&m(a.charCodeAt(Z));)Z++;if((Z===C||b(a.charCodeAt(Z))||a.charCodeAt(Z)===35)&&(j=O,B=Z),!K)break;O=a.indexOf(U,O+1)}if(j!==-1){if(q=a.slice(N+1,j),u=B,a.charCodeAt(u)===35)for(;u<C&&!b(a.charCodeAt(u));)u++;le=!0}}if(!le){let U=a.indexOf(`
`,L);U===-1&&(U=C);let O;if(C<4096)O=a.indexOf("#",L),(O===-1||O>U)&&(O=U);else for(O=L;O<U&&a.charCodeAt(O)!==35;)O++;let j=L,B=O;for(;j<B&&m(a.charCodeAt(j));)j++;for(;B>j&&m(a.charCodeAt(B-1));)B--;let K=a.charCodeAt(j);if(q=a.slice(j,B),q.includes("\u2028")||q.includes("\u2029")?q=q.replace(/^(['"`])([\s\S]*)\1$/mg,"$2"):B-j>=2&&(K===39||K===34||K===96)&&a.charCodeAt(B-1)===K&&(q=a.slice(j+1,B-1)),u=O,O<U)for(;u<C&&!b(a.charCodeAt(u));)u++}z===34&&(le||N<u)&&q.indexOf("\\")!==-1&&(q=q.replace(/\\n/g,`
`).replace(/\\r/g,"\r")),g[oe]=q}return g}function A(s,g){return g&&f(g.fast)?k(s):c(s)}function T(s){console.log(`┆ ${s}`)}function w(s){console.error(`◇ ${s}`)}function S(s){return s[0]==="~"?o.join(l.homedir(),s.slice(1)):s}function V(s={}){let g={...s};for(let a of Object.keys(g))g[a]===void 0&&delete g[a];return{...v(),...g}}function M(s){s=V(s);let g=o.resolve(process.cwd(),".env"),a="utf8",C=process.env;s&&s.processEnv!=null&&(C=s.processEnv);let u=f(s&&s.debug);s&&s.encoding?a=s.encoding:u&&T("no encoding is specified (UTF-8 is used by default)");let y=[g];if(s&&s.path)if(!Array.isArray(s.path))y=[S(s.path)];else{y=[];for(let L of s.path)y.push(S(L))}let E,H={},G={fast:s.fast};for(let L of y)try{let N=I.parse(i.readFileSync(L,{encoding:a}),G);I.populate(H,N,s)}catch(N){u&&T(`failed to load ${L} ${N.message}`),E=N}let oe=I.populate(C,H,s),ee=f(Object.prototype.hasOwnProperty.call(s,"quiet")?s.quiet:v(C).quiet);if(u||!ee){let L=Object.keys(oe).length,N=[];for(let z of y)try{let q=o.relative(process.cwd(),z instanceof n?t(z):z);N.push(q)}catch(q){u&&T(`failed to load ${z} ${q.message}`),E=q}w(`injected env (${L}) from ${N.join(",")}`)}return E?{parsed:H,error:E}:{parsed:H}}function D(s){return I.configDotenv(s)}function F(s,g,a={}){let C=f(a&&a.debug),u=f(a&&a.override),y={};if(s===null||typeof s!="object"||g===null||typeof g!="object"){let E=Error("OBJECT_REQUIRED: Please check the processEnv argument being passed to populate");throw E.code="OBJECT_REQUIRED",E}for(let E of Object.keys(g))Object.prototype.hasOwnProperty.call(s,E)?(u===!0&&(s[E]=g[E],y[E]=g[E]),C&&T(u===!0?`"${E}" is already defined and WAS overwritten`:`"${E}" is already defined and was NOT overwritten`)):(s[E]=g[E],y[E]=g[E]);return y}var I={configDotenv:M,config:D,parse:A,populate:F};r.exports.configDotenv=I.configDotenv,r.exports.config=I.config,r.exports.parse=I.parse,r.exports.populate=I.populate,r.exports=I}),He=ne((e,r)=>{var i=P("child_process"),o=P("fs"),l=P("path");function n(p){let c=['"'],m=0;for(let b of p){if(b==="\\"){m++;continue}b==='"'?c.push("\\".repeat(m*2+1),'"'):c.push("\\".repeat(m),b),m=0}return c.push("\\".repeat(m*2),'"'),c.join("")}function t(p,c=1){for(let m=0;m<c;m++){let b=[];for(let k of p){let A=k.charCodeAt(0),T=A>=48&&A<=57||A>=65&&A<=90||A>=97&&A<=122,w="\\/:._-".includes(k);!T&&!w&&A<128&&b.push("^"),b.push(k)}p=b.join("")}return p}function f(p,c){let m=Object.keys(p).reverse().find((b)=>b.toUpperCase()===c);return m===void 0?void 0:p[m]}function v(p,c,m){let b=(f(c,"PATHEXT")||".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean),k=b.some((T)=>p.toLowerCase().endsWith(T.toLowerCase()))?["",...b]:[...b,""],A=/[\\/]/.test(p)?[m]:[m,...(f(c,"PATH")||"").split(";")];for(let T of A)for(let w of k){let S=l.resolve(m,T.replace(/^"|"$/g,""),p+w);try{if(o.statSync(S).isFile())return S}catch{}}}function h(p,c,m){if(process.platform!=="win32")return i.spawn(p,c,m);let b=m.env||process.env,k=v(p,b,m.cwd||process.cwd());if(k&&/\.(?:exe|com)$/i.test(k))return i.spawn(k,c,m);let A=/\.(?:bat|cmd)$/i.test(k||p),T=[t(l.normalize(k||p))];for(let S of c)T.push(t(n(S),A?2:1));let w=T.join(" ");return i.spawn(f(b,"COMSPEC")||"cmd.exe",["/d","/v:off","/s","/c",`"${w}"`],{...m,windowsVerbatimArguments:!0})}r.exports=h}),Ke=ne((e,r)=>{var i=P("fs"),o=P("os"),l=P("path"),n=P("child_process"),t=He(),f=Ee(),{optionsFromEnv:v}=ye();function h(){console.log(["Usage: dotenv run [--help] [-q|--quiet] [--debug] [--override] [--fast] [-f|--file <paths>] [--] <command> [args...]","","Run a command with environment variables from a .env file.","Place dotenv options before the command; all following arguments go to the command.","","Options:","  -f, --file <paths>  .env paths, comma-separated or repeated (default: .env)","  -q, --quiet suppress the injected env message","  --debug     enable debug logging","  --override  override existing environment variables","  --fast      use the faster character-scanner parser","","Environment variables (DOTENV_CONFIG_* names remain as fallbacks):","  DOTENV_PATH, DOTENV_ENCODING, DOTENV_QUIET,","  DOTENV_DEBUG, DOTENV_OVERRIDE,","  DOTENV_FAST"].join(`
`))}function p(A){let T=[],w=!1,S,V,M,D,F=-1;for(let s=0;s<A.length;s++){let g=A[s];if(g==="--"){F=s+1;break}if(g==="--help"||g==="-h")return{help:!0};if(g==="--quiet"||g==="-q"){S=!0;continue}if(g==="--debug"){V=!0;continue}if(g==="--override"){M=!0;continue}if(g==="--fast"){D=!0;continue}if(g==="-f"||g==="--file"||g.startsWith("-f=")||g.startsWith("--file=")){let a=g.indexOf("="),C=a===-1?g:g.slice(0,a),u=a===-1?A[++s]:g.slice(a+1);if(!u||u==="--")return{error:`${C} requires a path`};let y=u.split(",").map((E)=>E.trim()).filter(Boolean);if(y.length===0)return{error:`${C} requires a path`};T.push(...y),w=!0;continue}if(g.startsWith("-"))return{error:`unknown option: ${g}`};F=s;break}let I=F===-1?[]:A.slice(F);return{paths:T,pathSet:w,quiet:S,debug:V,override:M,fast:D,command:I}}function c(A){return A[0]==="~"?l.join(o.homedir(),A.slice(1)):A}function m(A){let T=v(),w={encoding:T.encoding||"utf8",quiet:T.quiet,debug:T.debug===!0,override:T.override===!0,fast:T.fast===!0,paths:[".env"],defaultPath:!0};return T.path&&(w.paths=[T.path],w.defaultPath=!1),A.pathSet&&(w.paths=A.paths,w.defaultPath=!1),A.quiet!=null&&(w.quiet=A.quiet),A.debug!=null&&(w.debug=A.debug),A.override!=null&&(w.override=A.override),A.fast!=null&&(w.fast=A.fast),w}function b(A){let T={},w=[],S={override:A.override,debug:A.debug};for(let V of A.paths){let M=l.resolve(process.cwd(),c(V));try{let D=f.parse(i.readFileSync(M,{encoding:A.encoding}),{fast:A.fast});f.populate(T,D,S),w.push(V)}catch(D){if(A.debug&&console.log(`┆ failed to load ${V} ${D.message}`),!(A.defaultPath&&D.code==="ENOENT"))throw D}}return{injected:f.populate(process.env,T,S),loadedPaths:w}}function k(A){let T=A[0];if(T==="--help"||T==="-h"){h();return}if(T!=="run"){h(),process.exitCode=1;return}let w=p(A.slice(1));if(w.help){h();return}if(w.error){console.error(`dotenv: ${w.error}`),h(),process.exitCode=1;return}if(w.command.length===0){h(),process.exitCode=1;return}let S=m(w);try{let a=b(S);if(!(S.quiet==null?v().quiet:S.quiet)){let C=`◇ injected env (${Object.keys(a.injected).length})`;a.loadedPaths.length>0&&(C+=` from ${a.loadedPaths.join(", ")}`),console.error(C)}}catch(a){console.error(`dotenv: ${a.message}`),process.exitCode=1;return}let V=!!process.stdin.isTTY,M=process.platform!=="win32"&&!V,D=t(w.command[0],w.command.slice(1),{stdio:"inherit",detached:M}),F=new Map,I=0;function s(a){if(!(!D.pid||D.exitCode!==null||D.signalCode!==null)){if(process.platform==="win32"){n.spawnSync("taskkill",["/pid",String(D.pid),"/T","/F"],{stdio:"ignore"});return}try{process.kill(M?-D.pid:D.pid,a)}catch(C){if(C.code!=="ESRCH")throw C}}}function g(){for(let[a,C]of F)process.removeListener(a,C)}for(let a of["SIGINT","SIGTERM","SIGHUP","SIGQUIT"]){let C=()=>{if(a==="SIGINT"){if(I++,V&&process.platform!=="win32"&&I===1)return;if(I>1){s(I===2?"SIGTERM":"SIGKILL");return}}s(a)};F.set(a,C),process.on(a,C)}D.on("error",function(a){g(),console.error(`dotenv: ${a.message}`),process.exitCode=1}),D.on("exit",function(a,C){g(),typeof a=="number"?process.exit(a):(setInterval(()=>{},1000),process.kill(process.pid,C))})}r.exports=k,r===P.main&&k(process.argv.slice(2))}),X=Ee(),Or=Ke();Q.exports=X;Q.exports.config=X.config;Q.exports.configDotenv=X.configDotenv;Q.exports.parse=X.parse;Q.exports.populate=X.populate});/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function je(e,r){let i=e.slice(0,r).split(/\r?\n/);return[i.length,i.pop().length+1]}function Ve(e,r,i){let o=e.split(/\r?\n/),l="",n=(Math.log10(r+1)|0)+1;for(let t=r-1;t<=r+1;t++){let f=o[t-1];if(!f)continue;if(l+=t.toString().padEnd(n," "),l+=":  ",l+=f,l+=`
`,t===r)l+=" ".repeat(n+i+2),l+=`^
`}return l}class d extends Error{line;column;codeblock;constructor(e,r){let[i,o]=je(r.toml,r.ptr),l=Ve(r.toml,i,o);super(`Invalid TOML document: ${e}

${l}`,r);this.line=i,this.column=o,this.codeblock=l}static x(e,r,i){throw new d(e,{toml:r.s,ptr:i??r.p})}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function re(e){let r=e.p,i=e.s.charCodeAt(e.p++),o=i,l=i===39,n=i===e.s.charCodeAt(e.p)&&i===e.s.charCodeAt(e.p+1);if(n){if((i=e.s.charCodeAt(e.p+=2))===10)e.p++;else if(i===13&&e.s.charCodeAt(e.p+1)===10)e.p+=2}let t="",f=e.p,v=0;for(;e.p<e.s.length;e.p++)if(i=e.s.charCodeAt(e.p),n&&(i===10||i===13&&e.s.charCodeAt(e.p+1)===10))v=v&&3;else if(i<32&&i!==9||i===127)d.x("control characters are not allowed in strings",e);else if((!v||v===3)&&i===o&&(!n||e.s.charCodeAt(e.p+1)===o&&e.s.charCodeAt(e.p+2)===o)){if(n){if(e.s.charCodeAt(e.p+3)===o)e.p++;if(e.s.charCodeAt(e.p+3)===o)e.p++}if(!v){let h=e.s.slice(f,e.p);t=t?t+h:h}return e.p+=n?3:1,t}else if(!v){if(!l&&i===92)t+=e.s.slice(f,f=e.p),v=1}else if(v===1)if(i===120||i===117||i===85){let h=e.p++-1,p=0,c=i===120?2:i===117?4:8;for(let m=0;m<c;m++,e.p++){let b=e.s.charCodeAt(e.p),k=b>=48&&b<=57?b-48:b>=65&&b<=70?b-65+10:b>=97&&b<=102?b-97+10:-1;if(k<0)d.x("invalid non-hex character in unicode escape",e);p=p<<4|k}if(p<0||p>1114111||p>=55296&&p<=57343)d.x("invalid unicode escape",e,h);t+=String.fromCodePoint(p),f=e.p--,v=0}else if(n&&(i===32||i===9))v=2;else{if(i===98)t+="\b";else if(i===116)t+="\t";else if(i===110)t+=`
`;else if(i===102)t+="\f";else if(i===114)t+="\r";else if(i===101)t+="\x1B";else if(i===34)t+='"';else if(i===92)t+="\\";else d.x("unrecognised escape sequence",e);f=e.p+1,v=0}else if(i!==32&&i!==9){if(v===2)d.x("invalid escape: only line-ending whitespace may be escaped",e,f);v=!l&&i===92?1:0,f=e.p}d.x("unfinished string",e,r)}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var Le=/^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;class W extends Date{#r=!1;#t=!1;#e=null;constructor(e,r,i){let o=!0,l=!0,n="Z",t;if(typeof e==="string")if(r)e:{if(r<3){if(+e.slice(11,13)>23){e="";break e}if(r===2)n=null,e+="Z";else if((t=e.charCodeAt(e.length-1))!==90&&t!==122)n=e.slice(e.length-6);if(i)e=e.slice(0,10)+"T"+e.slice(11)}else if(r===4)e=+e.slice(0,2)>23?"":`0000-01-01T${e}Z`;o=r!==4,l=r!==3}else{let f=e.match(Le);if(f){if(!f[1])o=!1,e=`0000-01-01T${e}`;if(l=!!f[2],l&&e[10]===" "&&(e=e.replace(" ","T")),f[2]&&+f[2]>23)e="";else if(n=f[3]||null,!n&&l)e+="Z"}else e=""}super(e);if(!isNaN(this.getTime()))this.#r=o,this.#t=l,this.#e=n}isDateTime(){return this.#r&&this.#t}isLocal(){return!this.#r||!this.#t||!this.#e}isDate(){return this.#r&&!this.#t}isTime(){return this.#t&&!this.#r}isValid(){return this.#r||this.#t}toISOString(){let e=super.toISOString();if(this.isDate())return e.slice(0,10);if(this.isTime())return e.slice(11,23);if(this.#e===null)return e.slice(0,-1);if(this.#e==="Z"||this.#e==="z")return e;let r=+this.#e.slice(1,3)*60+ +this.#e.slice(4,6);return r=this.#e[0]==="-"?r:-r,new Date(this.getTime()-r*60000).toISOString().slice(0,-1)+this.#e}static wrapAsOffsetDateTime(e,r="Z"){let i=new W(e);return i.#e=r,i}static wrapAsLocalDateTime(e){let r=new W(e);return r.#e=null,r}static wrapAsLocalDate(e){let r=new W(e);return r.#t=!1,r.#e=null,r}static wrapAsLocalTime(e){let r=new W(e);return r.#r=!1,r.#e=null,r}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function _(e,r=10){return r===16?e>47&&e<58||e>64&&e<71||e>96&&e<103:e>47&&e<48+r}function ae(e,r){return e===32||e===9||e===10||e===13||r&&(e===r||e===44)||e===35}function Y(e,r){let i=e.p,o=e.s.charCodeAt(e.p);if(o===91||o===123){e.d--||d.x("document contains excessively nested structures. aborting.",e);let l=o===91?me(e):ce(e);return e.d++,l}if(o===34||o===39)return re(e);if(o===116){if(e.s.charCodeAt(++e.p)!==114||e.s.charCodeAt(++e.p)!==117||e.s.charCodeAt(++e.p)!==101)d.x("invalid value",e,i);return e.p++,!0}if(o===102){if(e.s.charCodeAt(++e.p)!==97||e.s.charCodeAt(++e.p)!==108||e.s.charCodeAt(++e.p)!==115||e.s.charCodeAt(++e.p)!==101)d.x("invalid value",e,i);return e.p++,!1}if(o===43||o===45)return te(e,e.p,e.s.charCodeAt(++e.p),44-o,r);if(e.s.charCodeAt(e.p+4)===45&&e.s.charCodeAt(e.p+7)===45)return Ue(e,o,r);if(e.s.charCodeAt(e.p+2)===58)return Be(e,o,r);return te(e,e.p,o,0,r)}function te(e,r,i,o,l){let n=i,t=0,f=!1;if(n===105){if(e.s.charCodeAt(++e.p)!==110||e.s.charCodeAt(++e.p)!==102)d.x("invalid value",e,r);return e.p++,(o||1)/0}if(n===110){if(e.s.charCodeAt(++e.p)!==97||e.s.charCodeAt(++e.p)!==110)d.x("invalid value",e,r);return e.p++,NaN}if(n===48){if(++e.p>=e.s.length||ae(n=e.s.charCodeAt(e.p),l))return e.bi===!0?0n:0;if(!o){if(n===120)return se(e,r,16,l);else if(n===98)return se(e,r,2,l);else if(n===111)return se(e,r,8,l)}if(n===46)t=2;else if(n===101||n===69)t=4;else d.x("illegal leading zero",e,r)}else if(!_(n))d.x("invalid value",e,r);while(++e.p<e.s.length&&(n=e.s.charCodeAt(e.p),!ae(n,l))){if(!t)t=1;if(n===95){if(!(t&1))d.x("illegal underscore",e);t+=11,f=!0}else if(t===1&&n===46)t=2;else if((t===1||t===3)&&(n===101||n===69))t=4;else if(t===4&&(n===43||n===45))t=6;else if(!_(n))d.x("illegal character in numeric literal",e);else if(t>9)t-=11;else if(!(t&1))t++}if(!t){let h=(i-48)*(o||1);return e.bi===!0?BigInt(h):h}if(!(t&1))d.x("unfinished numeric value",e,r);let v=e.s.slice(r,e.p);if(f)v=v.replaceAll("_","");return t>1?parseFloat(v):he(e,v,10,r)}function se(e,r,i,o){let l,n=1;while(++e.p<e.s.length&&(l=e.s.charCodeAt(e.p),!ae(l,o)))if(l===95){if(n&1)d.x("illegal underscore",e);n=3}else if(!_(l,i))d.x("illegal character in numeric literal",e);else if(n&1)n--;if(n&1)d.x("unfinished numeric value",e);let t=e.s.slice(r+2,e.p);if(n)t=t.replaceAll("_","");return he(e,t,i,r)}function he(e,r,i,o){if(e.bi!==!0)e:{let l=parseInt(r,i);if(!Number.isSafeInteger(l)){if(e.bi)break e;d.x("integer value cannot be represented losslessly",e,o)}return l}return i===10?BigInt(r):BigInt((i===2?"0b":i===8?"0o":"0x")+r)}function Ue(e,r,i){let o=e.p++,l;if(!_(r)||!_(e.s.charCodeAt(e.p++))||!_(e.s.charCodeAt(e.p++))||!_(e.s.charCodeAt(e.p++)))return te(e,e.p=o,r,0,i);if(e.p+=5,!_(e.s.charCodeAt(e.p++)))d.x("invalid date-time: date part is malformed",e,o);if(e.p>=e.s.length||((r=e.s.charCodeAt(e.p))!==32||(l=!0,!_(e.s.charCodeAt(e.p+1))))&&r!==84&&r!==116){let t=e.s.slice(o,e.p);return J(e,t,3,!1,o)}if(e.s.charCodeAt(e.p+=3)!==58)d.x("invalid date-time: time part is malformed",e,o);if(e.s.charCodeAt(e.p+=3)===58)e.p+=3;if(e.s.charCodeAt(e.p)===46)while(_(e.s.charCodeAt(++e.p)));if(r=e.s.charCodeAt(e.p)){if(r===90||r===122){let t=e.s.slice(o,++e.p);return J(e,t,1,l,o,"[+00:00]")}if(r===43||r===45){let t=e.s.slice(o,e.p+=6);return J(e,t,1,l,o,!e.ld&&"["+e.s.slice(e.p-6,e.p)+"]")}}let n=e.s.slice(o,e.p);return J(e,n,2,l,o)}function Be(e,r,i){let o=e.p;if(!_(r)||!_(e.s.charCodeAt(++e.p)))return te(e,--e.p,r,0,i);if(e.s.charCodeAt(e.p+=4)===58)e.p+=3;if(e.s.charCodeAt(e.p)===46)while(_(e.s.charCodeAt(++e.p)));let l=e.s.slice(o,e.p);return J(e,l,4,!1,o)}function J(e,r,i,o,l,n){if(e.ld){let t=new W(r,i,o);if(!t.isValid())d.x("invalid date",e,l);return t}try{if(n)r+=n;switch(i){case 1:return Temporal.ZonedDateTime.from(r);case 2:return Temporal.PlainDateTime.from(r);case 3:return Temporal.PlainDate.from(r);case 4:return Temporal.PlainTime.from(r)}}catch(t){d.x(t instanceof Error?t.message:""+t,e,l)}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function Re(e){for(;e.p<e.s.length;e.p++){let r=e.s.charCodeAt(e.p);if(r===10)break;if(r===13&&e.s.charCodeAt(e.p+1)===10){e.p++;break}if(r<32&&r!==9||r===127)d.x("control characters are not allowed in comments",e)}}function R(e,r,i){let o;while(e.p<e.s.length){while(e.p<e.s.length&&((o=e.s.charCodeAt(e.p))===32||o===9||!r&&(o===10||o===13&&e.s.charCodeAt(e.p+1)===10)))e.p++;if(i||o!==35)break;Re(e)}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function ie(e,r=61){let i,o=0,l=[],n,t=e.s.charCodeAt(i=e.p);do if(t===r){if(!o)d.x("unexpected end of key",e);if(o===1)l.push(e.s.slice(n,e.p));return e.p++,l}else if(t===46){if(!o)d.x("illegal empty bare key",e);if(o===1)l.push(e.s.slice(n,e.p));o=0}else if(!o&&(t===34||t===39)){if(t===e.s.charCodeAt(e.p+1)&&t===e.s.charCodeAt(e.p+2))d.x("illegal quoted key: multiline strings are not allowed",e);l.push(re(e)),o=2,e.p--}else if(t===32||t===9){if(o===1)l.push(e.s.slice(n,e.p)),o=2}else if(o===2||t<48&&t!==45||t>57&&t<65||t>90&&t<97&&t!==95||t>122)d.x("illegal character in key",e);else if(!o)o=1,n=e.p;while(t=e.s.charCodeAt(++e.p));d.x("incomplete key-value: cannot find end of key",e,i)}function ce(e){let r=e.p++,i=Object.create(null),o=new Set,l;while(e.p<e.s.length){if(R(e),(l=e.s.charCodeAt(e.p))===125)return e.p++,i;let n,t=i,f=!1,v=e.p,h=ie(e);for(let c=0;c<h.length;c++){if(c)t=f?t[n]:t[n]=Object.create(null);if(n=h[c],(f=Object.hasOwn(t,n))&&(typeof t[n]!=="object"||o.has(t[n])))d.x("trying to redefine an already defined value",e,v);let m=n==="__proto__";if(e.uk&&(m||n==="constructor")){t=e.uk!==1&&d.x("document contains an unsafe property",e,v);break}if(!f&&m)Object.defineProperty(t,n,{enumerable:!0,configurable:!0,writable:!0})}if(f)d.x("trying to redefine an already defined value",e,v);R(e,!0,!0);let p=Y(e,125);if(t&&typeof(t[n]=p)==="object")o.add(p);if(R(e),(l=e.s.charCodeAt(e.p++))===125)return i;if(l!==44)d.x("expected comma or end of structure",e,e.p-1)}d.x("unfinished table",e,r)}function me(e){let r=e.p++,i=[],o;while(e.p<e.s.length){if(R(e),(o=e.s.charCodeAt(e.p))===93)return e.p++,i;if(i.push(Y(e,93)),R(e),(o=e.s.charCodeAt(e.p++))===93)return i;if(o!==44)d.x("expected comma or end of structure",e,e.p-1)}d.x("unfinished array",e,r)}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function ge(e,r,i,o,l){let n=i,t=o,f,v=!1,h;for(let p=0;p<r.length;p++){if(p){if(n=v?n[f]:n[f]=Object.create(null),t=(h=t[f]).c,l===0&&(h.t===1||h.t===2))return null;if(h.t===2){let c=n.length-1;n=n[c],t=t[c].c}}if(f=r[p],(v=Object.hasOwn(n,f))&&t[f]?.t===0&&t[f]?.d)return null;if(!v){let c=f==="__proto__";if(e.uk&&(c||f==="constructor"))return!1;if(c)Object.defineProperty(n,f,{enumerable:!0,configurable:!0,writable:!0}),Object.defineProperty(t,f,{enumerable:!0,configurable:!0,writable:!0});t[f]={t:p<r.length-1&&l===2?3:l,d:!1,i:0,c:Object.create(null)}}}if(h=t[f],h.t!==l&&!(l===1&&h.t===3))return null;if(l===2){if(!h.d)h.d=!0,n[f]=[];n[f].push(n=Object.create(null)),h.c[h.i++]=h={t:1,d:!1,i:0,c:Object.create(null)}}if(h.d)return null;if(h.d=!0,l===1)n=v?n[f]:n[f]=Object.create(null);else if(l===0&&v)return null;return[f,n,h.c]}function Ce(e,r,i){if(r===null||e.uk===2)d.x(r===null?"trying to redefine an already defined table or value":"document contains an unsafe property",e,i)}function Ae(e,r={}){let i={s:e,p:0,d:r.maxDepth??1000,bi:r.integersAsBigInt??!1,ld:r.useLegacyDate??!0,uk:r.unsafeKeyBehaviour==="throw"?2:r.unsafeKeyBehaviour==="drop"?1:0},o=Object.create(null),l=Object.create(null),n,t=!1,f=o,v=l;if(e.charCodeAt(0)===65279)i.p++;R(i);while(i.p<e.length){if(e.charCodeAt(i.p)===91){let h=e.charCodeAt(++i.p)===91;n=i.p+=+h,t=!1;let p=ie(i,93);if(h){if(e.charCodeAt(i.p)!==93)d.x("expected end of table array declaration",i);i.p++}let c=ge(i,p,o,l,h?2:1);if(!c)Ce(i,c,n),t=!0;else v=c[2],f=c[1]}else{n=i.p;let h=ie(i),p=ge(i,h,f,v,0);if(!p&&!t)Ce(i,p,n);R(i,!0,!0);let c=Y(i,void 0);if(p&&!t)p[1][p[0]]=c}if(R(i,!0),i.p<e.length&&(n=e.charCodeAt(i.p))!==10&&(n!==13||e.charCodeAt(i.p+1)!==10))d.x("each key-value declaration must be followed by an end-of-line",i);R(i)}return o}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var Ge=/^[a-z0-9-_]+$/i,ve=!!"".isWellFormed;function x(e){let r=typeof e;if(r==="object"){if(Array.isArray(e))return"array";if(typeof e.getUTCDate==="function"&&e instanceof Date)return"date";if(globalThis.Temporal){if(e.until){if(e instanceof Temporal.ZonedDateTime)return"temporal/tz+uc";if(e instanceof Temporal.PlainDateTime||e instanceof Temporal.PlainDate)return"temporal/uc";if(e instanceof Temporal.PlainTime||e instanceof Temporal.Instant)return"temporal";if(e instanceof Temporal.PlainYearMonth)return"temporal/x"}else if(e.toPlainDate&&e instanceof Temporal.PlainMonthDay||e.negated&&e instanceof Temporal.Duration)return"temporal/x"}}return r}function Me(e){for(let r=0;r<e.length;r++)if(x(e[r])!=="object")return!1;return e.length!=0}function be(e){return JSON.stringify(e).replaceAll("","\\u007f")}function Fe(e){return be(ve?e.toWellFormed():e)}function Te(e){if(Ge.test(e))return e;if(ve&&!e.isWellFormed())throw RangeError("key contains illegal lone surrogates");return be(e)}function fe(e,r,i,o,l){if(i===0)throw Error("Could not stringify the object: maximum object depth exceeded");switch(r){case"number":if(isNaN(e))return"nan";if(e===1/0)return"inf";if(e===-1/0)return"-inf";if(Number.isInteger(e)&&(o||!Number.isSafeInteger(e)))return e.toFixed(1);case"bigint":case"boolean":case"temporal":return e.toString();case"string":return Fe(e);case"date":if(isNaN(e.getTime()))throw TypeError("cannot serialize invalid date");return e.toISOString();case"object":return ze(e,i,o,l);case"array":return Ze(e,i,o,l);case"temporal/tz+uc":if(l){let n=e.timeZoneId,t=n.charCodeAt(0);if(t!==43&&t!==45&&(t!==85&&t!==71&&t!==90&&t!==69||n!=="UTC"&&n!=="UCT"&&n!=="Universal"&&n!=="Zulu"&&!n.startsWith("GMT")&&n!=="Greenwich"&&!n.startsWith("Etc/")))throw TypeError("Temporal objects with an IANA timezone are not allowed in Temporal strict mode")}case"temporal/uc":if(l&&e.calendarId!=="iso8601")throw TypeError("Temporal objects with a non-default calendar are not allowed in Temporal strict mode");return e.toString({calendarName:"never",timeZoneName:"never"});case"temporal/x":throw TypeError("Unsupported "+e[Symbol.toStringTag])}}function ze(e,r,i,o){let l=Object.keys(e);if(l.length===0)return"{}";let n="{ ";for(let t=0;t<l.length;t++){let f=l[t];if(t)n+=", ";n+=Te(f)+" = "+fe(e[f],x(e[f]),r-1,i,o)}return n+" }"}function Ze(e,r,i,o){if(e.length===0)return"[]";let l="[ ";for(let n=0;n<e.length;n++){if(n)l+=", ";if(e[n]===null||e[n]===void 0)throw TypeError("arrays cannot contain null or undefined values");l+=fe(e[n],x(e[n]),r-1,i,o)}return l+" ]"}function We(e,r,i,o,l){if(i===0)throw Error("Could not stringify the object: maximum object depth exceeded");let n="";for(let t=0;t<e.length;t++)n+=`${n&&`
`}[[${r}]]
`,n+=ue(0,e[t],r,i,o,l);return n}function ue(e,r,i,o,l,n){if(o===0)throw Error("Could not stringify the object: maximum object depth exceeded");let t="",f="",v=Object.keys(r);for(let h=0;h<v.length;h++){let p=v[h];if(r[p]!==null&&r[p]!==void 0){let c=x(r[p]);if(c==="symbol"||c==="function")throw TypeError(`cannot serialize values of type '${c}'`);let m=Te(p);if(c==="array"&&Me(r[p]))f+=(f&&`
`)+We(r[p],i?`${i}.${m}`:m,o-1,l,n);else if(c==="object"){let b=i?`${i}.${m}`:m;f+=(f&&`
`)+ue(b,r[p],b,o-1,l,n)}else t+=m,t+=" = ",t+=fe(r[p],c,o,l,n),t+=`
`}}if(e&&(t||!f))t=t?`[${e}]
${t}`:`[${e}]`;return t&&f?`${t}
${f}`:t||f}function we(e,{maxDepth:r=1000,numbersAsFloat:i=!1,strictTemporal:o=!1}={}){if(x(e)!=="object")throw TypeError("stringify can only be called with an object");let l=ue(0,e,"",r,i,o);if(l[l.length-1]!==`
`)return l+`
`;return l}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var Qe=qe(Oe(),1);var Ir=Qe.parse;export{Ir as parseEnv,Ae as parseTOML,we as stringify};
