import { runCredential } from './credentials.mjs';
const publicChannels = new Set(['you','github','arxiv','crossref']);
export const standaloneBackend = {
  async capabilities() {
    return {channels:Object.fromEntries([...publicChannels].map(id=>[id,{configured:true}])),grok:{}};
  },
  async search(args, context={}) {
    const id=args.channels?.[0];
    if (!publicChannels.has(id)) throw new Error('Configure this channel in Search Center first');
    return runCredential(id,null,args,'',context.abort || AbortSignal.timeout(45000));
  },
};
