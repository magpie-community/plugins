// Stamp local static URLs after changing browser files. magpie's page
// entry is revalidated; content-addressed dependencies cannot mix an old
// stylesheet or renderer with a new index after a same-version update.
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
const page=join(import.meta.dir,'../page'),file=join(page,'index.html')
const html=readFileSync(file,'utf8')
const next=html.replace(/(\b(?:src|href)=")([^"?]+\.(?:js|css))(?:\?v=[a-f0-9]+)?(")/g,(all,start,name,end)=>{
 if(name.startsWith('_magpie/'))return all
 const hash=createHash('sha256').update(readFileSync(join(page,name))).digest('hex').slice(0,12)
 return start+name+'?v='+hash+end
})
if(process.argv.includes('--check')) {
 if(next!==html){console.error('Page asset stamps are stale: bun scripts/stamp-page.mjs');process.exit(1)}
} else if(next!==html)writeFileSync(file,next)
