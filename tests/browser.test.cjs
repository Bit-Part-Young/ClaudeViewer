// Optional real-browser regression: npm install playwright outside the viewer.
// Uses synthetic data and an intercepted test origin; no user profiles or network.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {chromium}=require('playwright');
const original=fs.readFileSync(path.join(__dirname,'../claude_viewer.html'),'utf8');
const html=original.replace(/\n\}\)\(\);\s*<\/script>\s*<\/body>/,'\nwindow.cvTest={ccToConv,buildMsg,convToHtml,convToMd,ccIndexWebFiles,CCStore,loadDemo,cvRoleMessages,renderMarkdownHTML,reflowMsgHeight,openConv,initVS,setData(c){appData.convs=[c];curConv=c;curMsgs=c.chat_messages;},virtual(){return{fullRenderMode,height:totalH,heights:[...heights]};}};\n})();\n</script>\n</body>');
assert.notEqual(html,original,'Test hook inserted only in the in-memory copy');

test('real DOM: ordered activity, offline exports, Markdown, math, search and mobile',async t=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1280,height:1000},timezoneId:'Asia/Taipei'});
  const page=await context.newPage();const errors=[];const remote=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url()==='http://viewer.test/'?route.fulfill({contentType:'text/html',body:html}):(remote.push(route.request().url()),route.abort()));
  await page.goto('http://viewer.test/');await page.waitForFunction(()=>!!window.cvTest);
  const fixture=[
    {type:'user',uuid:'u',timestamp:'2026-10-08T13:46:13Z',message:{content:'**用户问题** a/2[111](11̄2)'}},
    {type:'assistant',uuid:'a1',timestamp:'2026-10-08T13:46:20Z',message:{id:'a',content:[{type:'thinking',thinking:'Saved thinking body.'}]}},
    {type:'assistant',uuid:'a2',message:{id:'a',content:[{type:'tool_use',id:'t',name:'Bash',input:{command:'printf test',timeout:1200}}]}},
    {type:'user',uuid:'r',message:{content:[{type:'tool_result',tool_use_id:'t',content:'x'.repeat(6000),is_error:true}]}},
    {type:'assistant',uuid:'w',message:{id:'w',content:[{type:'tool_use',id:'write',name:'Write',input:{file_path:'/sample/README.md',content:'ok'}}]}},
    {type:'user',uuid:'wr',message:{content:[{type:'tool_result',tool_use_id:'write',content:'saved'}]}},
    {type:'assistant',uuid:'img',message:{id:'img',content:[{type:'tool_use',id:'read',name:'Read',input:{file_path:'/sample/snap.png'}}]}},
    {type:'user',uuid:'img-r',message:{content:[{type:'tool_result',tool_use_id:'read',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII='}}]}]}},
    {type:'assistant',uuid:'f',message:{id:'f',stop_reason:'end_turn',content:[{type:'text',text:'# Answer\n\n\\(K_{Ic}=\\sqrt{2\\gamma/B}\\)\n\na/2[111](11̄2)\n\n|A|B|\n|-|-|\n|1|2|\n\n```python\nprint(1)\n```'}]}},
    {type:'custom-title',customTitle:'Final session title'}
  ];
  const result=await page.evaluate(records=>{
    const t=cvTest,c=t.ccToConv(records.map(r=>JSON.stringify(r)).join('\n'),{dirName:'p',s:{fileName:'s.jsonl'}});
    c.chat_messages[0].attachments=[{file_name:'fixture.txt',extracted_content:'attached'.repeat(200)}];
    t.setData(c);t.loadDemo();t.setData(c);t.openConv(c.uuid);
    const main=document.getElementById('virtual-content');
    return{title:c.name,count:c.chat_messages.length,html:t.convToHtml(c,c.chat_messages,{dark:true}),md:t.convToMd(c,c.chat_messages),roles:[t.cvRoleMessages(c.chat_messages,'user').length,t.cvRoleMessages(c.chat_messages,'assistant').length],virtualExists:!!main};
  },fixture);
  assert.equal(result.title,'Final session title');assert.equal(result.count,2);assert.deepEqual(result.roles,[1,1]);
  assert.match(result.md,/x{6000}/);assert.doesNotMatch(result.html,/<script[ >]/i);assert.match(result.html,/script-src &#39;none&#39;/);
  assert.match(result.md,/a\/2\\\[111\\\]\\\(11̄2\\\)/);assert.match(result.html,/attached(?:attached){199}/);
  assert.equal(await page.locator('.bubble.human strong').count(),1);
  assert.equal(await page.locator('.bubble.assistant .katex').count(),1);
  assert.equal(await page.locator('.bubble.assistant table').count(),1);
  assert.equal(await page.locator('.bubble.assistant a').count(),0);
  const [htmlDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#exp-html').click()]);
  assert.match(htmlDownload.suggestedFilename(),/Final session title.*\.html$/);
  assert.match(fs.readFileSync(await htmlDownload.path(),'utf8'),/<title>Final session title<\/title>/);
  const [rolesDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#exp-roles').click()]);
  const rolesBytes=[...fs.readFileSync(await rolesDownload.path())];
  const roleFiles=await page.evaluate(async bytes=>{const zip=await JSZip.loadAsync(new Uint8Array(bytes));const files={};for(const [name,entry]of Object.entries(zip.files))files[name]=await entry.async('string');return files;},rolesBytes);
  const userFile=Object.keys(roleFiles).find(n=>n.endsWith('_用户输入.md')),assistantFile=Object.keys(roleFiles).find(n=>n.endsWith('_Claude输出.md'));
  assert.ok(userFile&&assistantFile);assert.match(roleFiles[userFile],/用户问题/);assert.doesNotMatch(roleFiles[userFile],/Saved thinking body/);assert.match(roleFiles[assistantFile],/Saved thinking body/);assert.doesNotMatch(roleFiles[assistantFile],/用户问题/);
  const group=page.locator('.msg-wrap.assistant .activity-group').first();
  assert.equal(await group.getAttribute('open'),null);await group.locator(':scope > summary').click();
  await group.locator('.activity-entry').first().locator('summary').click();
  assert.equal(await group.locator('.activity-entry').first().locator('.activity-content').innerText(),'Saved thinking body.');
  assert.match(await group.locator(':scope > summary').innerText(),/1 条命令.*读取 snap.png.*1 次失败/);
  await group.locator('summary').filter({hasText:/^读取 snap.png$/}).click();
  await page.waitForFunction(()=>document.querySelector('.activity-content img')?.naturalWidth===1);
  await page.locator('#cc-output-index summary').click();await page.getByRole('link',{name:'/sample/README.md'}).click();
  assert.equal(await page.locator('.activity-entry[open]').filter({hasText:'写入 README.md'}).count(),1);
  await page.locator('#search-input').fill('Answer');await page.locator('#search-btn').click();assert.match(await page.locator('#search-count').innerText(),/1/);
  await page.locator('#srch-toggle').click();await page.waitForFunction(()=>document.getElementById('srch-sidebar').getBoundingClientRect().width<2);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),true);
  assert.equal(await page.locator('#exp-pdf').evaluate(el=>el.getBoundingClientRect().right<=innerWidth),true);
  if(process.env.VIEWER_SCREENSHOT)await page.screenshot({path:process.env.VIEWER_SCREENSHOT,fullPage:true});
  // The download is self-contained: restore it into a second isolated test page.
  const exported=await context.newPage();await exported.route('**/*',route=>route.request().url()==='http://export.test/'?route.fulfill({contentType:'text/html',body:result.html}):(remote.push(route.request().url()),route.abort()));
  await exported.goto('http://export.test/');
  assert.equal(await exported.title(),'Final session title');assert.equal(await exported.locator('.activity-entry').count(),4);
  await exported.locator('.msg-wrap.assistant .activity-group > summary').first().click();
  await exported.locator('.activity-entry > summary').first().click();
  assert.equal(await exported.locator('.activity-entry .activity-content').first().isVisible(),true);
  assert.equal(await exported.locator('.katex').count(),1);assert.equal(await exported.locator('html').getAttribute('data-theme'),null);
  assert.equal(await exported.locator('body').getAttribute('data-theme'),'dark');
  await exported.locator('.cv-output-list summary').click();
  await exported.getByRole('link',{name:'/sample/README.md'}).click();
  await exported.locator('.activity-entry[open]').filter({hasText:'写入 README.md'}).waitFor();
  // Presets affect just the activity disclosures, including lazily built parameter rows.
  const levels=page.locator('#activity-controls');
  for(const [label, expected] of [['全部收起',[0,0,0]],['只看列表',[1,0,0]],['只展开思考',[1,1,0]],['全部展开',[1,4,1]]]){
    await levels.getByRole('button',{name:label}).click();
    const counts=await page.locator('#vc').evaluate(root=>['.cv-activity[open]','.activity-entry[open]','.cv-params[open]'].map(sel=>root.querySelectorAll(sel).length));
    assert.deepEqual(counts,expected);
  }
  // Capture Chrome's generated PDF and inspect its text when Poppler is available.
  const verifyPdf=async target=>{
    const pdf=await target.pdf({format:'A4'});
    if(process.env.CV_PDFTOTEXT){
      const content=require('node:child_process').execFileSync(process.env.CV_PDFTOTEXT,['-','-'],{input:pdf,encoding:'utf8'});
      assert.match(content,/Final\s+session\s+title/);assert.match(content,/Answer/);assert.match(content,/\/sample\/README\.md/);
      assert.doesNotMatch(content,/Saved thinking body|printf test|x{20}|attachedattached/);
    }
  };
  await verifyPdf(page);
  assert.equal(await page.locator('#vc .cv-params[open]').count(),1);
  // Print an exported file with its index closed and nested details manually opened.
  await exported.locator('.cv-output-list').evaluate(el=>el.open=false);
  await verifyPdf(exported);
  assert.equal(await exported.locator('.cv-output-list[open]').count(),0);
  await page.evaluate(()=>{
    const original=window.open.bind(window);
    window.open=(...args)=>{const w=original(...args);w.print=()=>{w.document.body.dataset.printCalled='yes';};return w;};
  });
  const [popup]=await Promise.all([page.waitForEvent('popup'),page.locator('#exp-pdf').click()]);
  await popup.waitForFunction(()=>document.body?.dataset.printCalled==='yes');
  assert.equal(await popup.locator('details[open]:not(.cv-output-list)').count(),0);
  assert.equal(await popup.locator('.cv-output-list[open]').count(),1);await verifyPdf(popup);await popup.close();
  // Offline HTML preserves the displayed image before the mid-turn supplement text.
  const followUp=await page.evaluate(()=>{
    const records=[{type:'attachment',attachment:{type:'queued_command',origin:{kind:'human'},prompt:[
      {type:'image',source:{type:'base64',media_type:'image/png',data:'AA=='}},{type:'text',text:'Use EAM only'}]}}];
    const c=cvTest.ccToConv(JSON.stringify(records[0]),{dirName:'sample',s:{fileName:'mid.jsonl'}});
    const doc=new DOMParser().parseFromString(cvTest.convToHtml(c,c.chat_messages),'text/html');
    const m=doc.querySelector('.msg-wrap.human'),img=m.querySelector('img'),p=m.querySelector('p');
    return [m.querySelector('.sender-label').textContent,img.getAttribute('src'),p.textContent,Boolean(img.compareDocumentPosition(p)&Node.DOCUMENT_POSITION_FOLLOWING)];
  });
  assert.deepEqual(followUp,['You · 运行中补充','data:image/png;base64,AA==','Use EAM only',true]);
  // Parallel calls return out of order; no command text is evaluated or parsed as markup.
  const terminal=await page.evaluate(()=>{
    const cmd="cd 'two words' && printf '<strong>literal</strong>'";
    const m={sender:'assistant',content:[
      {type:'tool_use',name:'Bash',id:'one',input:{description:'First',command:cmd}},
      {type:'tool_use',name:'Bash',id:'two',input:{description:'Second',command:'pwd'}},
      {type:'tool_result',tool_use_id:'two',content:'/other'},
      {type:'tool_result',tool_use_id:'one',content:'a   b\n  c'}
    ]};
    const html=cvTest.convToHtml({name:'shell'},[m]);
    const doc=new DOMParser().parseFromString(html,'text/html');
    return [...doc.querySelectorAll('.activity-entry')].map(row=>[
      row.querySelector('.cv-shell code').textContent,row.querySelector('.activity-content > pre:last-child').textContent,
      row.querySelectorAll('.cv-shell strong').length]);
  });
  assert.deepEqual(terminal,[["cd 'two words' && printf '<strong>literal</strong>'",'a   b\n  c',0],['pwd','/other',0]]);
  // Metadata and nested subagents work through both directory-reader backends.
  const directory=await page.evaluate(async()=>{
    const t=cvTest;const rows=[{type:'queue-operation'},{type:'user',cwd:'/demo/root',message:{content:'first'}},{type:'custom-title',customTitle:'named'}];
    const f=new File([rows.map(r=>JSON.stringify(r)).join('\n')],'s.jsonl');
    Object.defineProperty(f,'webkitRelativePath',{value:'.claude/projects/project/session/subagents/agent-1.jsonl'});
    const index=t.ccIndexWebFiles([f]);const store=Object.create(t.CCStore);store.mode='web';store.web=index;await store.listProjects();
    const sessions=await store.listSessions('project');
    const dir=entries=>({kind:'directory',async* entries(){for(const item of entries)yield item;}});
    const nested=dir([['project',dir([['session',dir([['subagents',dir([['agent-1.jsonl',{kind:'file',getFile:async()=>f}]])]])]])]]);
    const fsa=Object.create(t.CCStore);fsa.mode='fsa';fsa.root={};fsa.projRoot=nested;const projs=await fsa.listProjects();const fsas=await fsa.listSessions('project');
    return{cwd:await store._readHead({file:f}),name:sessions[0].fileName,title:sessions[0].displayTitle,agent:sessions[0].isAgent,fsa:fsas[0].fileName,count:projs[0].count};
  });
  assert.equal(directory.cwd.cwd,'/demo/root');assert.equal(directory.title,'named');assert.equal(directory.agent,true);assert.equal(directory.name,'session/subagents/agent-1.jsonl');
  assert.equal(directory.fsa,directory.name);assert.equal(directory.count,0);
  // Expand an initially virtualized message and verify following offsets update.
  await page.setViewportSize({width:1280,height:1000});
  const before=await page.evaluate(()=>{
    const c={uuid:'virtual',name:'virtual',chat_messages:Array.from({length:520},(_,i)=>({uuid:'m'+i,sender:i%2?'assistant':'human',content:i===1||i===519?[{type:'thinking',thinking:'line\n'.repeat(80)},{type:'text',text:'answer'}]:[{type:'text',text:'message '+i}]}))};
    cvTest.setData(c);cvTest.openConv(c.uuid);return cvTest.virtual();
  });
  assert.equal(before.fullRenderMode,false);
  const vGroup=page.locator('.msg-wrap.assistant .activity-group').first();await vGroup.locator(':scope > summary').click();await vGroup.locator('.activity-entry > summary').click();
  await page.waitForFunction(old=>cvTest.virtual().heights[1]>old,before.heights[1]);
  await page.getByRole('button',{name:'全部展开',exact:true}).click();
  await page.locator('#vp').evaluate(el=>el.scrollTop=el.scrollHeight);
  await page.locator('.msg-wrap[data-idx="519"] .activity-entry[open]').waitFor();
  // file:// smoke check of the new viewer, in an isolated temporary profile.
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'claudeviewer-test-'));
  try{const localPath=path.join(temp,'viewer.html');fs.writeFileSync(localPath,html);const local=await context.newPage();await local.goto(pathToFileURL(localPath).href);await local.waitForFunction(()=>!!window.cvTest);assert.equal(await local.locator('#exp-html').count(),1);await local.close();}finally{fs.rmSync(temp,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
});

test('directory picker, fork disclosure, title filter, parent/child switching and search jump',async t=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1100,height:800}});
  await page.route('**/*',route=>route.request().url()==='http://viewer.test/'?route.fulfill({contentType:'text/html',body:original}):route.abort());
  await page.goto('http://viewer.test/');
  await page.evaluate(()=>{
    const parent='00000000-0000-4000-8000-000000000001',child='00000000-0000-4000-8000-000000000002';
    const turn=(sessionId,uuid,text)=>({type:'user',sessionId,uuid,cwd:'/tmp/example',message:{content:text}});
    const title=(sessionId,customTitle)=>({type:'custom-title',sessionId,customTitle});
    const shared=turn(parent,'shared','Earlier message');
    const file=(id,rows)=>[id+'.jsonl',{kind:'file',getFile:async()=>new File([rows.map(r=>JSON.stringify(r)).join('\n')],id+'.jsonl')}];
    const dir=entries=>({kind:'directory',async* entries(){yield* entries;}});
    const call={type:'assistant',sessionId:parent,message:{content:[{type:'tool_use',id:'tool',name:'Agent',input:{description:'Map project scripts',subagent_type:'Explore'}}]}};
    const result={type:'user',sessionId:parent,message:{content:[{type:'tool_result',tool_use_id:'tool',content:'done'}]},toolUseResult:{agentId:'a1'}};
    const task=turn(parent,'task','Unique delegated instruction');task.isSidechain=true;
    const project=dir([file(parent,[shared,call,result,title(parent,'Original')]),file(child,[shared,turn(child,'after','Fork-only (text'),title(child,'Renamed branch')]),
      [parent,dir([['subagents',dir([file('agent-a1',[task])])]])]]);

    window.showDirectoryPicker=async()=>dir([['project',project]]);
  });
  await page.locator('#cc-btn').click();
  await page.locator('.cc-proj-head').click();
  assert.match(await page.locator('.cc-proj-count').innerText(),/2 会话 · 1 子代理/);
  const group=page.locator('.cc-agent-group');
  assert.equal(await group.getAttribute('open'),null);
  await group.locator('summary').click();
  await page.getByRole('button',{name:'Map project scripts'}).click();
  await page.waitForFunction(()=>document.querySelector('.cc-owner')?.textContent==='子代理任务 · Original');
  assert.equal(await page.locator('.cc-agent-group .badge.amber').innerText(),'Explore');
  assert.equal(await page.locator('.sender-label.human').innerText(),'任务输入');
  await group.locator('summary').click();
  await page.locator('#sb-search').fill('map project');
  assert.equal(await page.getByRole('button',{name:'Map project scripts'}).isVisible(),true);
  await page.locator('#sb-search').fill('');
  await page.locator('[data-cctab="search"]').click();
  await page.locator('#cc-gs-input').fill('Unique delegated');await page.locator('#cc-gs-btn').click();
  await page.locator('.gr-item').click();await page.locator('.cc-agent-group .active').waitFor();
  const toggle=page.locator('.cc-fork-toggle'),child=page.getByRole('button',{name:'Renamed branch',exact:true});
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  const waitForTitle=text=>page.waitForFunction(value=>document.querySelector('#detail-title')?.firstChild?.textContent.trim()===value,text);
  await child.click();await waitForTitle('Renamed branch');
  assert.equal(await page.locator('.cc-fork-children .active .cc-open').count(),1);
  await toggle.click();assert.equal(await child.isVisible(),false);
  await waitForTitle('Renamed branch');
  await page.getByRole('button',{name:'Original',exact:true}).click();await waitForTitle('Original');
  await page.locator('#sb-search').fill('renamed');assert.equal(await child.isVisible(),true);
  await page.locator('#sb-search').fill('');assert.equal(await child.isVisible(),false);
  await page.locator('[data-cctab="search"]').click();
  await page.locator('#cc-gs-input').fill('Fork-only (');await page.locator('#cc-gs-btn').click();
  await page.locator('.gr-item').click();await child.waitFor({state:'visible'});
  await waitForTitle('Renamed branch');
});
