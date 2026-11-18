import {build} from 'esbuild';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({absWorkingDir:root,entryPoints:['src/company-guard.js'],bundle:true,format:'esm',platform:'neutral',target:'es2020',write:false,legalComments:'none'});
const file=new URL('../dist/company-guard.middleware.js',import.meta.url),output=result.outputFiles[0].text;
if(process.argv.includes('--check')){
  if(await fs.readFile(file,'utf8')!==output)throw Error('发布中间件与源码不一致，请先运行 npm run build');
}else await fs.writeFile(file,output);
