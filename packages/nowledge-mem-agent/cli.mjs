#!/usr/bin/env node
import { settings, runOnce, status } from './lib/runtime.mjs';

const command=process.argv[2] || 'status';
if(!['status','sync','restore'].includes(command)) {
  console.error('Usage: node cli.mjs [status|sync|restore]');process.exitCode=2;
} else {
  try {
    const config=await settings();
    const result=command==='status'?await status(config):await runOnce(config,{restore:command==='restore',resume:command==='sync'});
    console.log(JSON.stringify(result,null,2));
  } catch(error) {
    console.error(error instanceof SyntaxError?'Invalid JSON configuration or selection.':error.message);process.exitCode=1;
  }
}
