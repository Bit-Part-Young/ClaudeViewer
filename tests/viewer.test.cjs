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
