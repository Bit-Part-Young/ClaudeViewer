const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../claude_viewer.html'),'utf8');
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const app=scripts.find(s=>s.includes('const APP_VERSION='));
const section=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end));
const c={console,Date,Map,Set,JSON,esc:s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),replaceUnsupportedBlocks:s=>s};
vm.createContext(c);
for(const marker of ['/* marked 9.1.6 */','/* KaTeX 0.16.9 */']){
  const src=scripts.find(s=>s.includes(marker));assert.ok(src,marker);vm.runInContext(src,c);
}
vm.runInContext(section('// ── SHARED TRANSCRIPT RENDERING','// ── END SHARED TRANSCRIPT RENDERING'),c);
vm.runInContext(section('function toolInputText(b){','// ── ATTACHMENTS ──'),c);
vm.runInContext(section('function ccExtractText(content){','// ── 文件访问抽象'),c);
vm.runInContext(section('// ── CC NORMALIZATION:','// ── END CC NORMALIZATION'),c);
c.cvConfigureMarkdown();
const jsonl=records=>records.map(r=>JSON.stringify(r)).join('\n');
const user=(content,uuid='u')=>({type:'user',uuid,timestamp:'2026-10-01T01:00:00Z',message:{content}});
const assistant=(content,id='a',stop='tool_use',uuid=id+content[0].type)=>({type:'assistant',uuid,timestamp:'2026-10-01T01:01:00Z',message:{id,content,stop_reason:stop,usage:{input_tokens:10,output_tokens:4}}});
const meta={dirName:'project',s:{fileName:'session.jsonl',displayTitle:'fallback'}};

test('last explicit title wins over later automatic names; usage is counted once per API message',()=>{
  const rows=[user('question'),assistant([{type:'thinking',thinking:'archived reasoning'}]),assistant([{type:'tool_use',id:'t',name:'Bash',input:{command:'pwd'}}]),{type:'custom-title',customTitle:'old'},{type:'custom-title',customTitle:'final title'},{type:'ai-title',aiTitle:'automatic'},{type:'agent-name',agentName:'automatic agent'}];
  const info=c.ccSessionInfo(rows);assert.equal(info.displayTitle,'final title');assert.equal(info.userCount,1);assert.equal(info.assistantCount,1);assert.equal(info.inTokens,10);assert.equal(info.outTokens,4);
  const conv=c.ccToConv(jsonl(rows),meta);assert.equal(conv.name,'final title');
});
test('tool result messages belong to Claude and preserve original block order',()=>{
  const rows=[user('question'),assistant([{type:'thinking',thinking:'thinking',signature:'must not display'}]),assistant([{type:'tool_use',id:'t',name:'Bash',input:{command:'pwd'}}]),user([{type:'tool_result',tool_use_id:'t',content:'result'}],'result'),assistant([{type:'text',text:'answer'}],'b','end_turn')];
  const conv=c.ccToConv(jsonl(rows),meta);assert.equal(conv.chat_messages.length,2);
  assert.deepEqual(Array.from(conv.chat_messages[1].content,b=>b.type),['thinking','tool_use','tool_result','text']);
  assert.equal(conv.chat_messages[1].content[0].signature,undefined);assert.equal(conv.chat_messages[1].content[2].name,'Bash');
  assert.equal(conv._cc.userCount,1);
});
test('mixed tool results and a new user prompt split correctly; meta prompts are not human turns',()=>{
  const rows=[user('question'),assistant([{type:'tool_use',id:'t',name:'Read',input:{}}]),user([{type:'tool_result',tool_use_id:'t',content:'ok'},{type:'text',text:'new request'}],'mixed'),{...user('Base directory for this skill: /demo','meta'),isMeta:true}];
  const conv=c.ccToConv(jsonl(rows),meta);assert.deepEqual(Array.from(conv.chat_messages,m=>m.sender),['human','assistant','human','assistant']);assert.equal(conv._cc.userCount,2);
});
test('complete SDK envelopes replace streamed deltas; streams alone are reconstructed',()=>{
  const events=[{type:'message_start',message:{id:'a'}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hello'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}},{type:'message_stop'}].map((event,i)=>({type:'stream_event',event,uuid:'s'+i}));
  const conv=c.ccToConv(jsonl([user('hi'),...events]),meta);assert.equal(conv.chat_messages[1].content[0].text,'hello');
  const full=assistant([{type:'text',text:'hello'}],'a','end_turn');const parsed=c.ccParseRecords(jsonl([...events,full,full]));assert.equal(parsed.records.length,1);assert.equal(parsed.records[0].type,'assistant');
  const partial=c.ccToConv(jsonl(events.slice(0,3)),meta);assert.equal(partial.chat_messages[0].content[0].type,'notice');assert.equal(partial.chat_messages[0].content[1].text,'hello');
  assert.equal(c.ccParseRecords('{bad\n'+JSON.stringify(user('ok'))).malformed,1);
});
test('Markdown renders TeX before underscores and backslashes are consumed',()=>{
  for(const text of [String.raw`\(K_{Ic}=\sqrt{2\gamma/B}\)`,String.raw`$K_{Ic}$`,String.raw`\[x^2+y^2\]`,'```math\n\\frac{1}{2}\n```']){
    const out=c.renderMarkdownHTML(text);assert.match(out,/class="katex/);assert.doesNotMatch(out,/katex-error/);
  }
  const code=c.renderMarkdownHTML('```sh\necho "$HOME"\n```');assert.doesNotMatch(code,/class="katex/);assert.match(code,/\$HOME/);
});
test('crystallographic notation remains literal, including explicitly escaped input',()=>{
  for(const text of ['a/2[111](11̄2)',String.raw`a/2\[111\]\(11̄2\)`]){
    const out=c.renderMarkdownHTML(text);assert.match(out,/a\/2\[111\]\(11̄2\)/);assert.doesNotMatch(out,/<a |class="katex/);
  }
  assert.match(c.renderMarkdownHTML('[script](cracks/input.lmp)'),/<a href="cracks\/input.lmp"/);
});
test('imported Markdown cannot execute raw HTML or javascript links, or request remote images',()=>{
  const out=c.renderMarkdownHTML('<img src=x onerror=alert(1)>\n\n[x](javascript:alert%281%29) ![remote](https://example.invalid/pixel.png)');
  assert.doesNotMatch(out,/<img|href="javascript:/);assert.match(out,/&lt;img/);assert.match(out,/图片/);
});
test('redacted thoughts remain placeholders and image results do not stringify megabytes of base64',()=>{
  const conv=c.ccToConv(jsonl([assistant([{type:'redacted_thinking',data:'opaque'},{type:'text',text:'answer'}],'a','end_turn')]),meta);
  assert.equal(conv.chat_messages[0].content[0].type,'redacted_thinking');
  assert.equal(c.toolResultText({content:[{type:'image',source:{data:'sensitive-large-image'}}]}),'[图像工具结果]');
});
test('SDK result finalizes an existing identical reply instead of duplicating it; errors are visible',()=>{
  const conv=c.ccToConv(jsonl([assistant([{type:'text',text:'answer'}]),{type:'result',result:'answer'}]),meta);
  assert.equal(conv.chat_messages.length,1);assert.equal(conv.chat_messages[0]._final,true);
  const error=c.ccToConv(jsonl([{type:'result',is_error:true,subtype:'error_max_turns',errors:['limit reached']}]),meta);
  assert.match(error.chat_messages[0].content[0].text,/limit reached/);
});

test('forks use the owning file, immediate inherited owner and matching message UUID',()=>{
  const ids=Array.from({length:8},(_,i)=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0'));
  const turn=(id,uuid)=>({...user('prompt '+uuid,uuid),sessionId:id});
  const title=(id,name)=>({type:'custom-title',sessionId:id,customTitle:name});
  const row=(id,records,fileName=id+'.jsonl')=>{
    const info=c.ccSessionInfo(records,fileName);
    return {...info,fileName,lineage:c.ccTranscriptLineage(records,info.sessionId)};
  };
  const first=turn(ids[0],'u0'),second=turn(ids[1],'u1');
  const history=[first,title(ids[0],'original')];
  const fork=[...history,second,{type:'ai-title',sessionId:ids[1],aiTitle:'renamed'}];
  const copied=[first,second,turn(ids[2],'u2')];
  const root=row(ids[0],history),child=row(ids[1],fork),grandchild=row(ids[2],copied);
  const missing=row(ids[3],[turn(ids[7],'missing'),turn(ids[3],'own')]);
  const lookalike=row(ids[4],[turn(ids[0],'different-uuid'),turn(ids[4],'u4'),title(ids[4],'original (fork)')]);
  const agent=row(ids[0],history,'agents/agent-x.jsonl');agent.isAgent=true;
  const ambiguous=row(ids[5],[first,turn(ids[5],'u5'),second]);
  const copy=row(ids[6],history);
  c.ccLinkForks([grandchild,lookalike,agent,missing,root,child,ambiguous,copy]);
  assert.equal(child.sessionId,ids[1]);assert.equal(child.displayTitle,'renamed');
  assert.equal(child.parentFileName,root.fileName);assert.equal(grandchild.parentFileName,child.fileName);
  for(const s of [root,agent,missing,lookalike,ambiguous,copy])assert.equal(s.parentFileName,'');
  const conv=c.ccToConv(jsonl(fork),{dirName:'p',s:child});
  assert.equal(conv._cc.sessionId,ids[1]);assert.equal(conv.name,'renamed');assert.equal(conv.chat_messages.length,2);
  const cycleA=row(ids[0],[second,first]),cycleB=row(ids[1],[first,second]);
  c.ccLinkForks([cycleA,cycleB]);assert.equal(cycleA.parentFileName,'');assert.equal(cycleB.parentFileName,'');
});

test('agents resolve to their own main session, use verified task labels or sidecar, and reject conflicting owners',()=>{
  const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
  const parent={fileName:id+'.jsonl',sessionId:id,displayTitle:'Parent'};
  const task=(n,sessionId=id)=>({isAgent:true,sessionId,fileName:id+'/subagents/agent-'+n+'.jsonl',agentId:n,displayTitle:'Long prompt'});
  const one=task('a'),two=task('b'),wrong=task('c',other);
  two.meta={description:'Sidecar title',agentType:'Explore'};
  const calls=c.ccAgentCalls([
    {type:'assistant',sessionId:id,message:{content:[{type:'tool_use',id:'call',name:'Agent',input:{description:'Real title',subagent_type:'general-purpose'}}]}},
    {type:'user',sessionId:id,toolUseResult:{agentId:'a'},message:{content:[{type:'tool_result',tool_use_id:'call'}]}},
    {type:'assistant',sessionId:other,message:{content:[{type:'tool_use',id:'call',name:'Agent',input:{description:'Inherited'}}]}}
  ],id);
  c.ccLinkAgents([parent,one,two,wrong],new Map([[parent.fileName,calls]]));
  assert.equal(one.displayTitle,'Real title');assert.equal(one.ownerTitle,'Parent');assert.equal(one.parentFileName,parent.fileName);
  assert.equal(two.displayTitle,'Sidecar title');assert.equal(two.agentType,'Explore');assert.equal(wrong.parentFileName,undefined);
});

test('output files use matched successful results and retain distinct paths and latest successful call',()=>{
  const call=(id,path,name='Edit')=>({type:'tool_use',id,name,input:{file_path:path}});
  const result=(id,error=false)=>({type:'tool_result',tool_use_id:id,is_error:error});
  const files=c.cvOutputFiles([{content:[call('a','x/README.md'),call('b','y/README.md'),result('b'),result('a')]},
    {content:[call('c','x/README.md'),result('c'),call('d','x/README.md'),result('d',true),call('e','unfinished'),call('f','input','Read'),result('f')]}]);
  assert.deepEqual(Array.from(files,item=>[item.path,item.index,item.step]),[['y/README.md',0,1],['x/README.md',1,0]]);
});

test('delivered mid-turn prompts split the original timeline and retain pictures only once',()=>{
  const prompt=[{type:'image',source:{type:'base64',media_type:'image/png',data:'AA=='}},{type:'text',text:'update'}];
  const queued={type:'attachment',uuid:'attachment',attachment:{type:'queued_command',commandMode:'prompt',humanTurn:true,origin:{kind:'human'},prompt,source_uuid:'source',delivery_id:'deliver',timestamp:'2026-11-11T01:00:00Z'}};
  const rows=[assistant([{type:'text',text:'working'}],'a'),{type:'queue-operation',operation:'enqueue',content:'update'},queued,
    {...queued,uuid:'replay'},user('update','source'),{type:'api-request-blob',message:{content:prompt}},
    {...queued,uuid:'peer',attachment:{...queued.attachment,origin:{kind:'peer'},source_uuid:'p',delivery_id:'p'}},
    assistant([{type:'text',text:'continued'}],'b','end_turn')];
  const conv=c.ccToConv(jsonl(rows),meta);
  assert.deepEqual(Array.from(conv.chat_messages,m=>m.sender),['assistant','human','assistant']);
  assert.equal(conv._cc.userCount,1);
  const m=conv.chat_messages[1];assert.equal(m._midTurn,true);assert.equal(m.created_at,queued.attachment.timestamp);
  assert.deepEqual(Array.from(m.content,b=>b.type),['image','text']);assert.equal(m.content[1].text,'update');
});
