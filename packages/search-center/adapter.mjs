export const CHANNEL_NAMES = {
  grok:'Grok Search · 模型搜索',tavily:'Tavily · 搜索',exa:'Exa · 搜索',firecrawl:'Firecrawl · 搜索',
  you:'You.com · 网页与新闻',brave:'Brave · 搜索',parallel:'Parallel · 搜索',perplexity:'Perplexity · 搜索',
  bocha:'博查 · 中文搜索',serper:'Serper · Google',searxng:'SearXNG · 聚合搜索',
  github:'GitHub · 代码仓库',arxiv:'arXiv · 论文',crossref:'Crossref · 文献',
};
export function sourcePages(sources,count) {
  const pages=[],seen=new Set();
  for(const source of sources||[]) {
    let url;try{url=new URL(source.url);}catch{continue;}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||seen.has(url.href))continue;
    seen.add(url.href);
    pages.push({title:String(source.title||url.hostname),url:url.href,
      text:String(source.text??source.content??source.snippet??source.description??''),
      age:String(source.age??source.date??source.published_date??'')});
    if(pages.length>=count)break;
  }
  return pages;
}
const unbound=()=>{throw new Error('Search Center is not initialized');};
export function hooks() {
  return {
    search:Object.fromEntries(Object.entries(CHANNEL_NAMES).map(([id,name])=>[id,{name,keyOptional:true,execute:unbound}])),
    tool:{
      search:{
        description:'Search selected channels on demand. Call capabilities to check configured sources. Quick uses one web source; balanced/deep add Grok if configured. Explicit channels run only those channels. Grok enables web and X search by default. Results include citations and routing evidence.',
        args:{type:'object',properties:{
          query:{type:'string',minLength:1},channels:{type:'array',minItems:1,uniqueItems:true,items:{enum:Object.keys(CHANNEL_NAMES)}},
          profile:{type:'string',enum:['quick','balanced','deep'],default:'quick'},model:{type:'string',description:'Exact Grok model; requires grok channel.'},
          grok_search_mode:{type:'string',enum:['both','web','x'],default:'both'},count:{type:'integer',minimum:1,maximum:20},
        },required:['query'],additionalProperties:false},execute:unbound,
      },
      capabilities:{description:'Configured search channels, model candidates and modes; no search request.',args:{type:'object',properties:{},additionalProperties:false},execute:unbound},
    },
  };
}
