(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const safe = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n, digits = 0) => safe(n).toLocaleString('en-US', {minimumFractionDigits:digits, maximumFractionDigits:digits});
  const timeFmt = (ts) => new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(safe(ts) * 1000));
  const soundKey = 'reactor_v3_sound_mode';
  const url = new URLSearchParams(location.search);
  const state = {
    ok:true,error:null,ts:Date.now()/1000,mode:'curve',temp_c:58,cpu_c:57,gpu_c:54,cpu_w:12,chip_w:18,cpu_load:.22,
    interlock:false,system_control:false,fans:[{id:0,name:'Pump A',rpm:2200,min:1200,max:5779,target:2400},{id:1,name:'Pump B',rpm:2300,min:1200,max:6241,target:2500}],
    curve:{start_c:50,full_c:80},manual_pct:60,alarms:[],history:[],events:[],procs:[],cores:8
  };
  const ui = {sim:url.get('demo')==='1',fails:0,window:600,hover:null,dragging:false,cover:false,sound:localStorage.getItem(soundKey)==='1'?1:0,previousAlarms:new Set(),simPhase:0,curveDrag:false};
  $('#soundMode').value=String(ui.sound);
  let audioCtx=null, lastChartKey='', raf=0;

  function normalize(d) {
    const n = {...d};
    for (const key of ['ts','temp_c','cpu_c','gpu_c','cpu_w','chip_w','cpu_load','manual_pct']) n[key]=safe(n[key], state[key] ?? 0);
    n.mode=['auto','curve','manual','scram'].includes(n.mode)?n.mode:'auto';
    n.cores=Math.max(1,Math.round(safe(n.cores,8)));
    n.curve={start_c:clamp(safe(n.curve?.start_c,50),40,85),full_c:clamp(safe(n.curve?.full_c,80),45,95)};
    if(n.curve.full_c<n.curve.start_c+5)n.curve.full_c=Math.min(95,n.curve.start_c+5);
    n.fans=(Array.isArray(n.fans)?n.fans:[]).slice(0,2).map((f,i)=>({id:i,name:String(f.name||`Fan ${i?'B':'A'}`),rpm:safe(f.rpm),min:safe(f.min,1200),max:safe(f.max,i?6241:5779),target:safe(f.target)}));
    while(n.fans.length<2){const i=n.fans.length;n.fans.push({id:i,name:`Fan ${i?'B':'A'}`,rpm:0,min:1200,max:i?6241:5779,target:0});}
    n.alarms=(Array.isArray(n.alarms)?n.alarms:[]).map(a=>({...a,code:String(a.code||''),active:!!a.active,acked:!!a.acked}));
    n.history=(Array.isArray(n.history)?n.history:[]).filter(r=>Array.isArray(r)&&r.length>=5&&r.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(r[1])>0).slice(-600).map(r=>r.slice(0,5).map(Number));
    n.events=(Array.isArray(n.events)?n.events:[]).filter(e=>e&&Number.isFinite(Number(e.ts))).map(e=>({ts:safe(e.ts),level:String(e.level||'info'),msg:String(e.msg||'')}));
    n.procs=(Array.isArray(n.procs)?n.procs:[]).filter(p=>p&&Number.isFinite(Number(p.cpu_pct))).slice(0,6).map(p=>({name:String(p.name||'Process'),cpu_pct:Math.max(0,safe(p.cpu_pct)),count:Math.max(1,Math.round(safe(p.count,1)))}));
    return n;
  }
  function pushEvent(level,msg){state.events.unshift({ts:Date.now()/1000,level,msg});state.events=state.events.slice(0,80);}
  function simEvent(msg,level='info'){pushEvent(level,msg);}
  function seedSimulator(){
    const now=Math.floor(Date.now()/1000);state.history=[];
    for(let i=599;i>=0;i--){const t=now-i,phase=i/29;const temp=56+4.2*Math.sin(phase)+1.5*Math.sin(i/8);const a=2250+650*Math.sin(i/34)+Math.max(0,temp-50)*70;const b=2360+570*Math.cos(i/38)+Math.max(0,temp-50)*76;const watts=16+7*Math.sin(i/26)+Math.max(0,temp-60)*.4;state.history.push([t,temp,a,b,watts]);}
    state.events=[{ts:now-22,level:'info',msg:'Curve control active'},{ts:now-71,level:'info',msg:'Sensor data is back'},{ts:now-108,level:'warn',msg:'Core warm: 80 °C'}];
  }
  if(ui.sim){seedSimulator();}
  function simTick(){
    ui.simPhase+=1;const now=Math.floor(Date.now()/1000);const wave=Math.sin(ui.simPhase/13)+.45*Math.sin(ui.simPhase/4.8);let temp=56+wave*5;
    if(ui.simPhase%145>110)temp+=13;if(state.mode==='scram')temp-=4;if(state.mode==='manual')temp+=Math.max(0,60-state.manual_pct)*.08;
    state.temp_c=clamp(temp,43,94);state.cpu_c=state.temp_c-.7;state.gpu_c=state.temp_c-2.8;state.cpu_load=clamp(.22+.18*Math.sin(ui.simPhase/9),.03,.88);state.cpu_w=8+state.cpu_load*24;state.chip_w=12+state.cpu_load*38;
    const curvePct=clamp((state.temp_c-state.curve.start_c)/(state.curve.full_c-state.curve.start_c),0,1);let pct=state.mode==='scram'?1:state.mode==='manual'?state.manual_pct/100:state.mode==='curve'?curvePct:.34;
    state.fans.forEach((f,i)=>{f.rpm=Math.round(f.min+pct*(f.max-f.min)+(i?35:-25));f.target=Math.round(f.min+pct*(f.max-f.min));});
    const raw=[['Arc',37+18*Math.max(0,Math.sin(ui.simPhase/9))],['Claude',16+9*Math.max(0,Math.sin(ui.simPhase/12+1))],['WindowServer',10],['Spotlight',6+7*(ui.simPhase%73<8)],['Photos',4+5*Math.max(0,Math.sin(ui.simPhase/16+2))],['kernel_task',3]];
    state.procs=raw.map(([name,cpu_pct])=>({name,cpu_pct:Number(cpu_pct.toFixed(1)),count:name==='Arc'?14:name==='WindowServer'?7:3})).sort((a,b)=>b.cpu_pct-a.cpu_pct).slice(0,6);
    state.ts=now;state.history.push([now,state.temp_c,state.fans[0].rpm,state.fans[1].rpm,state.chip_w]);state.history=state.history.slice(-600);
    const previous=state.alarms,wasHot=previous.some(a=>a.code==='CORE_HOT'&&a.active),hot=state.temp_c>=92;
    const alarmState=(code,active)=>{const old=previous.find(a=>a.code===code);return {code,active,since:active?(old?.active?old.since:now):null,acked:active?(old?.active?!!old.acked:false):true};};
    state.alarms=[alarmState('CORE_WARM',state.temp_c>=80),alarmState('CORE_HOT',hot),alarmState('INTERLOCK',false),alarmState('SCRAM',state.mode==='scram')];
    checkNewAlarms();
    if(hot&&!wasHot)simEvent('Core HOT: temperature reached 92 °C','alarm');
    if(!hot&&wasHot)simEvent('Core back below 92 °C','info');
  }
  function applyIncoming(d){
    const oldMode=state.mode;Object.assign(state,normalize(d));
    if(oldMode!==state.mode && state.mode==='scram') playAlarm(true);
    checkNewAlarms();render();
  }
  async function poll(){
    if(ui.sim){simTick();render();return;}
    try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);const d=await r.json();if(!d||!d.ok)throw new Error('Bad state');ui.fails=0;applyIncoming(d);}
    catch(_){ui.fails++;if(ui.fails>=3){ui.sim=true;seedSimulator();simEvent('Reactor connection lost · simulator active','warn');simTick();render();}}
  }
  async function post(path,body){if(ui.sim)return;try{const r=await fetch(`/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Reactor':'1'},body:JSON.stringify(body||{})});if(!r.ok)throw new Error('Request rejected');}catch(_){pushEvent('warn','Control request did not reach the reactor');renderEvents();}}
  function checkNewAlarms(){
    const active=new Set(state.alarms.filter(a=>a.active).map(a=>a.code));
    for(const code of active){if(!ui.previousAlarms.has(code)){const severe=['CORE_HOT','INTERLOCK','SCRAM'].includes(code);playAlarm(severe);}}
    ui.previousAlarms=active;
  }
  function playAlarm(severe){if(ui.sound!==1)return;try{const A=window.AudioContext||window.webkitAudioContext;if(!A)return;audioCtx ||= new A();if(audioCtx.state==='suspended')audioCtx.resume();const t=audioCtx.currentTime;
      if(severe){const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sawtooth';o.frequency.setValueAtTime(520,t);o.frequency.setValueAtTime(390,t+.28);o.frequency.setValueAtTime(520,t+.56);g.gain.setValueAtTime(.11,t);g.gain.exponentialRampToValueAtTime(.001,t+.82);o.connect(g);g.connect(audioCtx.destination);o.start(t);o.stop(t+.84);}
      else{[880,1320].forEach((freq,i)=>{const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sine';o.frequency.value=freq;g.gain.setValueAtTime(.08,t+i*.12);g.gain.exponentialRampToValueAtTime(.001,t+.65);o.connect(g);g.connect(audioCtx.destination);o.start(t+i*.12);o.stop(t+.67);});}
    }catch(_){}}
  function render(){renderStatus();renderReadouts();renderControls();renderProcesses();renderEvents();$('#lastUpdated').textContent=`Updated ${timeFmt(state.ts)}`;scheduleChart();}
  function renderStatus(){
    const status=$('.statusbar'),active=state.alarms.filter(a=>a.active),unacked=active.some(a=>!a.acked);let mode=state.mode==='curve'?'on your curve':state.mode==='auto'?'on Auto':state.mode==='manual'?'on Manual': 'in SCRAM';
    const fanPct=Math.round((state.fans[0].max>state.fans[0].min?(state.fans[0].rpm-state.fans[0].min)/(state.fans[0].max-state.fans[0].min):0)*100);
    const alarmWords=active.length?active.map(a=>({CORE_WARM:'core warm',CORE_HOT:'CORE HOT',INTERLOCK:'safety interlock',SCRAM:'SCRAM',PUMP_STALL:'fan stall',SENSOR_FAIL:'sensor failure',MANUAL_OVERRIDE:'manual override'}[a.code]||a.code.toLowerCase().replaceAll('_',' '))).join(' · '):'all normal';
    $('#statusText').textContent=`Chip ${fmt(state.temp_c)} °C · fans at ${clamp(fanPct,0,100)}% ${mode} · ${alarmWords}`;
    status.classList.toggle('alarm',active.some(a=>a.code==='CORE_WARM')||unacked);status.classList.toggle('danger',active.some(a=>['CORE_HOT','INTERLOCK','SCRAM','PUMP_STALL'].includes(a.code)));
    status.classList.toggle('unacked',unacked);$('#ackBtn').hidden=!unacked;$('#simDot').parentElement.classList.toggle('active',ui.sim);$('#simLabel').textContent=ui.sim?'SIMULATOR':'LIVE';
  }
  function renderReadouts(){
    const temp=$('#tempValue'),block=temp.closest('.chip-readout');text(temp,fmt(state.temp_c));block.classList.toggle('warm',state.temp_c>=80&&state.temp_c<92);block.classList.toggle('hot',state.temp_c>=92);
    text($('#cpuValue'),`${fmt(state.cpu_c)}°`);text($('#gpuValue'),`${fmt(state.gpu_c)}°`);text($('#loadValue'),`${fmt(state.cpu_load*100)}%`);text($('#powerValue'),fmt(state.chip_w,1));
    for(let i=0;i<2;i++){text($(`#fan${i?'B':'A'}Value`),fmt(state.fans[i].rpm));text($(`#fan${i?'B':'A'}Target`),`rpm · target ${fmt(state.fans[i].target)}`);}
  }
  function renderControls(){
    $$('.mode-buttons button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode)));
    const descriptions={auto:'Apple runs the fans.',curve:'Fans rise between your two temperatures.',manual:'Both fans hold one fixed speed.'};text($('#modeCaption'),descriptions[state.mode]||'Both fans are at full speed.');
    $('#curveControls').hidden=state.mode!=='curve';$('#manualControls').hidden=state.mode!=='manual';text($('#startOutput'),`${fmt(state.curve.start_c)} °C`);text($('#fullOutput'),`${fmt(state.curve.full_c)} °C`);
    const pos=clamp((state.temp_c-40)/55*100,0,100);$('#tempMarker').style.left=`${pos}%`;text($('#previewLabel'),`${fmt(state.temp_c)} °C now`);
    const slider=$('#manualSlider');if(document.activeElement!==slider)slider.value=String(Math.round(state.manual_pct));text($('#manualOutput'),`${fmt(state.manual_pct)}%`);
    if(state.mode!=='scram')ui.lastMode=state.mode;
    const scram=state.mode==='scram';$('#scramPanel').classList.toggle('scrammed',scram);
    // The 3D switch (scram3d.js) owns the note when it is running; the flat cover and button are the fallback.
    if(window.Scram3D){window.Scram3D.sync(state);return;}
    $('#scramNote').textContent=scram?'Fans at full — pick a mode to stop':ui.cover?'Cover open · press red button':'Guard closed · no action';
    $('#scramCover').classList.toggle('open',ui.cover);$('#scramCover').setAttribute('aria-expanded',String(ui.cover));$('#scramCover').textContent=ui.cover?'COVER OPEN · READY':'LIFT COVER';$('#scramButton').setAttribute('aria-disabled',String(!ui.cover));
  }
  function renderProcesses(){
    const list=$('#processList'),cores=Math.max(1,state.cores),items=state.procs;const html=items.length?items.map(p=>{const share=p.cpu_pct/cores,percent=clamp(share,0,100);return `<li class="process-row"><span class="process-name" title="${esc(p.name)} · ${fmt(p.count)} processes">${esc(p.name)}</span><span class="process-track" aria-hidden="true"><i style="width:${percent}%"></i></span><span class="process-share">${fmt(share)}% of chip</span></li>`;}).join(''):'<li class="empty-process">No process sample yet.</li>';
    if(list.dataset.html!==html){list.innerHTML=html;list.dataset.html=html;}
    const top=items[0],share=top?top.cpu_pct/cores:0,note=$('#topAppNote');if(top&&share>50){note.hidden=false;note.textContent=`${top.name} is using most of the chip — closing it will cool the Mac fastest.`;}else note.hidden=true;
  }
  function renderEvents(){const list=$('#eventList'),items=state.events.slice(0,4);const html=items.length?items.map(e=>`<li class="event-row ${esc(e.level)}"><time>${timeFmt(e.ts)}</time><span>${esc(e.msg)}</span></li>`).join(''):'<li class="no-events">No recent events.</li>';if(list.dataset.html!==html){list.innerHTML=html;list.dataset.html=html;}}
  function text(el,value){const v=String(value);if(el.textContent!==v)el.textContent=v;}
  function scheduleChart(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;drawChart();});}
  function drawChart(){
    const c=$('#chart'),rect=c.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),w=rect.width,h=rect.height;if(!w||!h)return;
    const pw=Math.round(w*dpr),ph=Math.round(h*dpr);if(c.width!==pw||c.height!==ph){c.width=pw;c.height=ph;}const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);x.fillStyle='#efe4c7';x.fillRect(0,0,w,h);
    const pad={l:43,r:50,t:27,b:25},plot={l:pad.l,t:pad.t,w:w-pad.l-pad.r,h:h-pad.t-pad.b};if(plot.w<20||plot.h<20)return;
    x.save();x.beginPath();x.rect(plot.l,plot.t,plot.w,plot.h);x.clip();
    // Cream paper and a fine printed grid.
    x.strokeStyle='#c9b998';x.lineWidth=.55;for(let v=30;v<=100;v+=5){const y=plot.t+(100-v)/70*plot.h;x.beginPath();x.moveTo(plot.l,y);x.lineTo(plot.l+plot.w,y);x.stroke();}
    const rows=state.history.filter(r=>r[0]>=state.ts-ui.window).slice(-ui.window);const now=rows.length?rows[rows.length-1][0]:state.ts;const left=now-ui.window;const xAt=t=>plot.l+clamp((t-left)/ui.window,0,1)*plot.w;const yTemp=v=>plot.t+(100-clamp(v,30,100))/70*plot.h;const yRpm=v=>plot.t+(6300-clamp(v,0,6300))/6300*plot.h;
    const powerMax=Math.max(10,Math.ceil(Math.max(0,...rows.map(r=>r[4]))/10)*10);const yPower=v=>plot.t+(powerMax-clamp(v,0,powerMax))/powerMax*plot.h;
    // Time lines follow one minute divisions at two minutes and two minutes at ten.
    const minuteStep=ui.window===120?20:120;const first=Math.ceil(left/minuteStep)*minuteStep;
    for(let t=first;t<=now;t+=minuteStep){const xx=xAt(t);x.strokeStyle='#bcae8f';x.lineWidth=.7;x.beginPath();x.moveTo(xx,plot.t);x.lineTo(xx,plot.t+plot.h);x.stroke();}
    const ref=(value,color,label,dash=[5,4],labelY=0)=>{const y=yTemp(value);x.save();x.setLineDash(dash);x.strokeStyle=color;x.lineWidth=1.25;x.beginPath();x.moveTo(plot.l,y);x.lineTo(plot.l+plot.w,y);x.stroke();x.restore();x.fillStyle=color;x.font='9px "IBM Plex Mono",monospace';x.textAlign='right';x.fillText(label,plot.l+plot.w-4,y+labelY);};
    ref(state.curve.start_c,'#596c48',`fans start ${fmt(state.curve.start_c)}°`,[4,4],-3);ref(state.curve.full_c,'#8b7046',`full speed ${fmt(state.curve.full_c)}°`,[4,4],-3);ref(92,'#bf4037','HOT 92°',[5,3],-3);
    const pen=(idx,color,width,dashed,mapper)=>{x.save();x.strokeStyle=color;x.lineWidth=width;x.lineJoin='round';x.lineCap='round';if(dashed)x.setLineDash([5,4]);x.beginPath();let started=false;for(const r of rows){const xx=xAt(r[0]),v=r[idx];if(!Number.isFinite(v))continue;if(!started){x.moveTo(xx,mapper(v));started=true;}else x.lineTo(xx,mapper(v));}if(started)x.stroke();x.restore();};
    pen(4,'#817a68',1.4,true,yPower);pen(2,'#275f91',1.8,false,yRpm);pen(3,'#29805d',1.8,false,yRpm);pen(1,'#c85138',2.8,false,yTemp);
    // A subtle time cursor is driven by hover or by keyboard focus.
    let hovered=null;if(ui.hover&&rows.length){const index=clamp(Math.round((ui.hover.x-plot.l)/plot.w*(rows.length-1)),0,rows.length-1);hovered=rows[index];const xx=xAt(hovered[0]);x.strokeStyle='#34483e';x.lineWidth=1;x.setLineDash([3,3]);x.beginPath();x.moveTo(xx,plot.t);x.lineTo(xx,plot.t+plot.h);x.stroke();x.setLineDash([]);}
    const last=rows[rows.length-1];if(last){const xx=xAt(last[0]),yy=yTemp(last[1]);x.fillStyle='#c85138';x.beginPath();x.arc(xx,yy,3.1,0,Math.PI*2);x.fill();x.strokeStyle='#6e3027';x.lineWidth=1;x.beginPath();x.moveTo(xx,yy-10);x.lineTo(xx,yy-3);x.stroke();}
    x.restore();
    // Printed axis labels stay outside the clipped graph area.
    x.font='9px "IBM Plex Mono",monospace';x.fillStyle='#344238';x.textAlign='right';for(let v=30;v<=100;v+=10)x.fillText(String(v),pad.l-6,yTemp(v)+3);
    x.textAlign='left';for(let v=0;v<=6000;v+=1500)x.fillText(v===0?'0':`${v/1000}k`,plot.l+plot.w+6,yRpm(v)+3);
    x.fillStyle='#536047';x.textAlign='left';x.fillText('°C',4,15);x.textAlign='right';x.fillText('rpm',w-2,15);
    x.fillStyle='#39463b';x.textAlign='center';for(let t=first;t<=now;t+=minuteStep)x.fillText(timeFmt(t).slice(0,5),xAt(t),h-5);
    const powerScale=`0–${powerMax} W`;text($('#powerScale'),powerScale);
    if(hovered){const card=$('#hoverCard'),cx=xAt(hovered[0]);card.innerHTML=`<strong>${timeFmt(hovered[0])} IST</strong>Chip ${fmt(hovered[1],1)} °C<br>Fan A ${fmt(hovered[2])} rpm<br>Fan B ${fmt(hovered[3])} rpm<br>Chip ${fmt(hovered[4],1)} W`;card.hidden=false;card.style.left=`${clamp(cx+14,8,w-card.offsetWidth-8)}px`;card.style.top='12px';}else $('#hoverCard').hidden=true;
  }
  function chartPointer(e){const r=$('#chart').getBoundingClientRect();const left=43,right=50;ui.hover={x:clamp(e.clientX-r.left,left,r.width-right)};scheduleChart();}
  function changeCurve(which,delta){let start=state.curve.start_c,full=state.curve.full_c;if(which==='start'){start=clamp(start+delta,40,85);full=Math.max(full,start+5);}else{full=clamp(full+delta,start+5,95);}state.curve={start_c:start,full_c:full};renderControls();scheduleChart();post('curve',state.curve);}
  $$('.mode-buttons button').forEach(b=>b.addEventListener('click',()=>{state.mode=b.dataset.mode;render();post('mode',{mode:state.mode});}));
  $$('[data-step]').forEach(b=>b.addEventListener('click',()=>changeCurve(b.dataset.step,Number(b.dataset.delta))));
  $('#manualSlider').addEventListener('input',e=>{state.manual_pct=safe(e.target.value);text($('#manualOutput'),`${fmt(state.manual_pct)}%`);});
  $('#manualSlider').addEventListener('change',e=>{state.manual_pct=safe(e.target.value);post('manual',{pct:state.manual_pct});});
  $('#scramCover').addEventListener('click',()=>{ui.cover=!ui.cover;renderControls();});
  $('#scramButton').addEventListener('click',()=>{if(!ui.cover)return;ui.cover=false;state.mode='scram';state.fans.forEach(f=>f.rpm=f.max);pushEvent('alarm','SCRAM engaged · both fans commanded to full');render();post('mode',{mode:'scram'});});
  window.ReactorScram={
    soundOn:()=>ui.sound===1,
    current:()=>state,
    fire(){state.mode='scram';state.fans.forEach(f=>f.rpm=f.max);pushEvent('alarm','SCRAM engaged · both fans commanded to full');render();post('mode',{mode:'scram'});},
    release(){const m=ui.lastMode||'auto';state.mode=m;pushEvent('info',`SCRAM released · back to ${m}`);render();post('mode',{mode:m});},
  };
  $('#ackBtn').addEventListener('click',()=>{state.alarms.forEach(a=>{if(a.active)a.acked=true;});renderStatus();post('ack',{});});
  $('#soundMode').addEventListener('change',e=>{ui.sound=Number(e.target.value)===1?1:0;localStorage.setItem(soundKey,String(ui.sound));if(ui.sound){playAlarm(false);}});
  $$('[data-window]').forEach(b=>b.addEventListener('click',()=>{ui.window=Number(b.dataset.window);$$('[data-window]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));scheduleChart();}));
  const canvas=$('#chart');canvas.addEventListener('pointermove',chartPointer);canvas.addEventListener('pointerdown',e=>{ui.dragging=true;canvas.setPointerCapture(e.pointerId);chartPointer(e);});canvas.addEventListener('pointerleave',()=>{if(!ui.dragging){ui.hover=null;scheduleChart();}});canvas.addEventListener('pointerup',()=>{ui.dragging=false;ui.hover=null;scheduleChart();});canvas.addEventListener('pointercancel',()=>{ui.dragging=false;ui.hover=null;scheduleChart();});canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){ui.hover=null;scheduleChart();}});
  new ResizeObserver(scheduleChart).observe($('.chart-bezel'));window.addEventListener('resize',scheduleChart);document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleChart();});
  if(!ui.sim)poll();render();setInterval(poll,1000);
})();
