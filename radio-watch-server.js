/*
 * Dependency-free development/operations server for R4DIO DASH.
 * Serves the static app and provides the same-origin live-traffic endpoint that
 * browsers need because the upstream aviation feeds do not expose usable CORS.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DEPLOYMENT_PORT = process.env.PORT || process.env.RADIO_WATCH_PORT;
const PORT = Number(DEPLOYMENT_PORT) || 8080;
// Cloud hosts inject PORT and require the process to accept connections on all
// interfaces. Local development remains private to this computer by default.
const HOST = process.env.RADIO_WATCH_HOST || (DEPLOYMENT_PORT ? '0.0.0.0' : '127.0.0.1');
const SYSTEM_AUDIO_HELPER = path.join(__dirname, 'scripts', 'system-audio-mute.ps1');
const SYSTEM_AUDIO_LEASE_MS = 4000;
const LOCAL_AUDIO_BRIDGE_ENABLED = process.platform === 'win32' && !DEPLOYMENT_PORT && ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const CACHE_MS = 8000;
const MAX_ALTITUDE_FT = 10000;
const ADSB_URL = 'https://api.adsb.lol/v2/point/49.82/15.45/180';
const OGN_URL = 'https://live.glidernet.org/lxml.php?a=0&b=51.2&c=48.35&d=19.1&e=11.8&z=2&y=6';
const RLP_METEO_URL = 'https://meteo.rlp.cz/';
const AWC_METAR_URL = 'https://aviationweather.gov/api/data/metar?ids=LKBC,LKCR,LKCS,LKCV,LKKB,LKKU,LKKV,LKLN,LKMH,LKMT,LKNA,LKPD,LKPJ,LKPR,LKTB,LKTH,LKVO&format=json';
const CZECH_POLYGON = [
  [12.09,50.25],[12.24,50.48],[12.58,50.69],[13.18,50.99],[14.15,51.06],[14.74,50.91],
  [15.18,50.99],[15.58,50.82],[16.12,50.67],[16.58,50.49],[17.18,50.37],[17.72,50.25],
  [18.17,50.08],[18.56,49.92],[18.86,49.55],[18.55,49.42],[18.39,49.15],[18.05,49.00],
  [17.66,48.84],[17.16,48.75],[16.95,48.61],[16.48,48.73],[16.00,48.72],[15.56,48.82],
  [15.10,48.72],[14.70,48.58],[14.20,48.64],[13.84,48.76],[13.52,48.95],[13.08,49.01],
  [12.57,49.35],[12.39,49.62],[12.15,49.86],[12.09,50.25]
];
const CONTENT_TYPES = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.cup':'text/plain; charset=utf-8','.cub':'text/plain; charset=utf-8','.pdf':'application/pdf',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'
};

let trafficCache = null;
let trafficCacheTime = 0;
let trafficRequest = null;
let metarCache = null;
let metarCacheTime = 0;
let metarRequest = null;
let systemAudioQueue = Promise.resolve();
const systemAudioLease = { active:false, priorMuted:false, outputMuted:false, deadline:0 };
let systemAudioHelperProcess = null;
let systemAudioHelperBuffer = '';
let systemAudioHelperStderr = '';
let systemAudioHelperRequests = [];

function insideCzech(lat,lon){
  if(lat<48.35||lat>51.2||lon<11.8||lon>19.1)return false;
  let inside=false;
  for(let i=0,j=CZECH_POLYGON.length-1;i<CZECH_POLYGON.length;j=i++){
    const [xi,yi]=CZECH_POLYGON[i],[xj,yj]=CZECH_POLYGON[j];
    if(((yi>lat)!==(yj>lat))&&lon<(xj-xi)*(lat-yi)/(yj-yi)+xi)inside=!inside;
  }
  return inside;
}

async function fetchText(url){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(url,{headers:{'User-Agent':'R4DIO-DASH-CZ/1.0'},signal:controller.signal});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {clearTimeout(timeout);}
}

function validTrack(track){
  return Number.isFinite(track.lat)&&Number.isFinite(track.lon)&&Number.isFinite(track.altitudeFt)&&
    track.altitudeFt>=-500&&track.altitudeFt<MAX_ALTITUDE_FT&&insideCzech(track.lat,track.lon);
}

function parseAdsb(payload){
  const now=Date.now();
  return (payload.ac||[]).map(aircraft=>{
    const barometric=aircraft.alt_baro,geometric=aircraft.alt_geom;
    const altitudeFt=barometric==='ground'?0:(barometric!==null&&barometric!==''&&Number.isFinite(Number(barometric))?Number(barometric):Number(geometric));
    const age=Number(aircraft.seen);
    return {
      id:`ADSB:${aircraft.hex||aircraft.flight||`${aircraft.lat}:${aircraft.lon}`}`,source:'ADSB',
      callsign:String(aircraft.flight||aircraft.r||aircraft.hex||'ADSB').trim().toUpperCase(),
      registration:String(aircraft.r||'').trim().toUpperCase(),aircraftType:String(aircraft.t||'').trim().toUpperCase(),
      squawk:String(aircraft.squawk||'').trim(),category:String(aircraft.category||'').trim().toUpperCase(),emergency:String(aircraft.emergency||'').trim().toLowerCase(),
      lat:Number(aircraft.lat),lon:Number(aircraft.lon),altitudeFt,heading:Number(aircraft.track),
      groundSpeedKt:Number(aircraft.gs),verticalRateFpm:Number.isFinite(Number(aircraft.baro_rate))?Number(aircraft.baro_rate):Number(aircraft.geom_rate),
      receiver:'adsb.lol',reportedTime:Number.isFinite(age)?new Date(now-age*1000).toISOString().slice(11,19):'',ageSeconds:age
    };
  }).filter(track=>(!Number.isFinite(track.ageSeconds)||track.ageSeconds<=35)&&validTrack(track));
}

function decodeXml(value){
  return value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}

function parseOgn(xml){
  const reports=[];
  for(const match of xml.matchAll(/<m\s+[^>]*a="([^"]+)"[^>]*\/?\s*>/g)){
    const fields=decodeXml(match[1]).split(','),lat=Number(fields[0]),lon=Number(fields[1]);
    const altitudeFt=Number(fields[4])*3.280839895,identifier=String(fields[13]||fields[12]||fields[3]||`${lat}:${lon}`).trim();
    const rawCallsign=String(fields[3]||identifier).trim(),identifierLike=/^[a-f0-9]{8,}$/i.test(rawCallsign);
    const track={
      id:`OGN:${identifier}`,source:'OGN',callsign:identifierLike?rawCallsign.slice(-6).toUpperCase():rawCallsign.toUpperCase(),
      registration:identifierLike?'':rawCallsign.toUpperCase(),aircraftType:'GLIDER / FLARM',squawk:'',category:'',emergency:'',
      lat,lon,altitudeFt,heading:Number(fields[7]),groundSpeedKt:Number(fields[8])/1.852,
      verticalRateFpm:Number(fields[9])*196.850394,receiver:String(fields[11]||''),reportedTime:String(fields[5]||'')
    };
    if(validTrack(track))reports.push(track);
  }
  return reports;
}

function decodeHtml(value){
  return value.replace(/&nbsp;|&#160;/gi,' ').replace(/&quot;|&#34;/gi,'"').replace(/&apos;|&#39;/gi,"'")
    .replace(/&lt;|&#60;/gi,'<').replace(/&gt;|&#62;/gi,'>').replace(/&amp;|&#38;/gi,'&');
}

function parseRlpMetars(html){
  const text=decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'\n').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'\n').replace(/<[^>]+>/g,'\n'));
  const chunks=text.split(/(?=\b(?:METAR|SPECI)\s+[A-Z]{4}\b)/),latest=new Map();
  for(const chunk of chunks){
    const match=chunk.replace(/[\t ]+/g,' ').match(/^\s*((?:METAR|SPECI)\s+([A-Z]{4})\s+(?:NIL\b|[^=\r\n]*=))/);
    if(!match)continue;
    const raw=match[1].trim(),code=match[2],nil=/\sNIL=?$/.test(raw);
    const previous=latest.get(code);
    if(!previous||previous.nil&&!nil)latest.set(code,{code,raw,nil});
  }
  return [...latest.values()];
}

function parseAwcMetars(json){
  return (Array.isArray(json)?json:[]).map(item=>({code:String(item.icaoId||item.stationId||'').toUpperCase(),raw:String(item.rawOb||item.raw_text||'').trim(),nil:false}))
    .filter(report=>/^[A-Z]{4}$/.test(report.code)&&report.raw);
}

async function loadMetars(){
  if(metarCache&&Date.now()-metarCacheTime<60000)return metarCache;
  if(metarRequest)return metarRequest;
  metarRequest=(async()=>{
    const [rlpResult,awcResult]=await Promise.allSettled([fetchText(RLP_METEO_URL),fetchText(AWC_METAR_URL)]);
    let rlpReports=[],awcReports=[],primaryError='',fallbackError='';
    if(rlpResult.status==='fulfilled'){
      try{rlpReports=parseRlpMetars(rlpResult.value).filter(report=>!report.nil);}catch(error){primaryError=String(error.message||error);}
    }else primaryError=rlpResult.reason?.name==='AbortError'?'timeout':String(rlpResult.reason?.message||rlpResult.reason);
    if(awcResult.status==='fulfilled'){
      try{awcReports=parseAwcMetars(JSON.parse(awcResult.value));}catch(error){fallbackError=String(error.message||error);}
    }else fallbackError=awcResult.reason?.name==='AbortError'?'timeout':String(awcResult.reason?.message||awcResult.reason);
    const merged=new Map(awcReports.map(report=>[report.code,report]));
    rlpReports.forEach(report=>merged.set(report.code,report));
    const reports=[...merged.values()].sort((a,b)=>a.code.localeCompare(b.code));
    if(!reports.length)throw new Error(`No current METAR reports${primaryError?` · ŘLP: ${primaryError}`:''}${fallbackError?` · AWC: ${fallbackError}`:''}`);
    const source=rlpReports.length&&awcReports.length?'ŘLP ČR meteo + AviationWeather.gov':rlpReports.length?'ŘLP ČR meteo':'AviationWeather.gov fallback';
    const payload={generatedAt:new Date().toISOString(),source,reports,primaryError,fallbackError};
    metarCache=payload;metarCacheTime=Date.now();return payload;
  })();
  try{return await metarRequest;}finally{metarRequest=null;}
}

async function loadTraffic(){
  if(trafficCache&&Date.now()-trafficCacheTime<CACHE_MS)return trafficCache;
  if(trafficRequest)return trafficRequest;
  trafficRequest=(async()=>{
    const [adsbResult,ognResult]=await Promise.allSettled([fetchText(ADSB_URL),fetchText(OGN_URL)]);
    const feeds={ADSB:{ok:adsbResult.status==='fulfilled'},OGN:{ok:ognResult.status==='fulfilled'}};
    let aircraft=[];
    if(adsbResult.status==='fulfilled'){
      try{aircraft.push(...parseAdsb(JSON.parse(adsbResult.value)));}catch(error){feeds.ADSB={ok:false,error:`parse: ${error.message}`};}
    }else feeds.ADSB.error=adsbResult.reason?.name==='AbortError'?'timeout':String(adsbResult.reason?.message||adsbResult.reason);
    if(ognResult.status==='fulfilled'){
      try{aircraft.push(...parseOgn(ognResult.value));}catch(error){feeds.OGN={ok:false,error:`parse: ${error.message}`};}
    }else feeds.OGN.error=ognResult.reason?.name==='AbortError'?'timeout':String(ognResult.reason?.message||ognResult.reason);
    const payload={generatedAt:new Date().toISOString(),feeds,aircraft};
    if(feeds.ADSB.ok||feeds.OGN.ok){trafficCache=payload;trafficCacheTime=Date.now();}
    return payload;
  })();
  try{return await trafficRequest;}finally{trafficRequest=null;}
}

function sendJson(response,status,payload){
  response.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'
  });
  response.end(JSON.stringify(payload));
}

function isLoopbackAddress(address=''){
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
}

function isSameOriginRequest(request){
  const origin=request.headers.origin;
  if(!origin)return true;
  try{return new URL(origin).host===request.headers.host;}
  catch{return false;}
}

function localAudioAvailable(request){
  return LOCAL_AUDIO_BRIDGE_ENABLED&&isLoopbackAddress(request.socket.remoteAddress)&&fs.existsSync(SYSTEM_AUDIO_HELPER);
}

function sendLocalAudioJson(response,status,payload){
  response.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'
  });
  response.end(JSON.stringify(payload));
}

function rejectSystemAudioHelperRequests(error){
  const pending=systemAudioHelperRequests.splice(0);
  pending.forEach(request=>request.reject(error));
}

function ensureSystemAudioHelper(){
  if(systemAudioHelperProcess&&!systemAudioHelperProcess.killed)return systemAudioHelperProcess;
  systemAudioHelperBuffer='';systemAudioHelperStderr='';
  const helper=spawn('powershell.exe',[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',SYSTEM_AUDIO_HELPER,'-Action','serve'
  ],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  systemAudioHelperProcess=helper;
  helper.stdout.setEncoding('utf8');helper.stderr.setEncoding('utf8');
  helper.stdout.on('data',chunk=>{
    systemAudioHelperBuffer+=chunk;
    const lines=systemAudioHelperBuffer.split(/\r?\n/);systemAudioHelperBuffer=lines.pop()||'';
    for(const line of lines){
      if(!line.trim())continue;
      const request=systemAudioHelperRequests.shift();
      if(!request)continue;
      try{
        const payload=JSON.parse(line);
        if(payload.ok===false)request.reject(new Error(payload.error||'System audio helper failed'));
        else request.resolve(payload);
      }catch{request.reject(new Error('System audio helper returned an invalid response.'));}
    }
  });
  helper.stderr.on('data',chunk=>{systemAudioHelperStderr=(systemAudioHelperStderr+chunk).slice(-16384);});
  let helperClosed=false;
  const fail=error=>{
    if(helperClosed)return;helperClosed=true;
    if(systemAudioHelperProcess!==helper)return;
    systemAudioHelperProcess=null;
    rejectSystemAudioHelperRequests(new Error((systemAudioHelperStderr||error?.message||'System audio helper stopped').trim()));
  };
  helper.once('error',fail);
  helper.once('exit',(code,signal)=>fail(new Error(`System audio helper exited (${signal||code}).`)));
  return helper;
}

function runSystemAudioHelper(action){
  return new Promise((resolve,reject)=>{
    const helper=ensureSystemAudioHelper(),request={resolve,reject};
    systemAudioHelperRequests.push(request);
    helper.stdin.write(`${action}\n`,error=>{
      if(!error)return;
      const index=systemAudioHelperRequests.indexOf(request);
      if(index>=0)systemAudioHelperRequests.splice(index,1);
      reject(error);
    });
  });
}

function stopSystemAudioHelper(){
  const helper=systemAudioHelperProcess;systemAudioHelperProcess=null;
  if(!helper)return;
  try{helper.stdin.end();}catch{}
  const forceClose=setTimeout(()=>{if(!helper.killed)helper.kill();},1000);forceClose.unref();
  helper.once('exit',()=>clearTimeout(forceClose));
}

function queueSystemAudio(operation){
  const result=systemAudioQueue.then(operation,operation);
  systemAudioQueue=result.catch(()=>{});
  return result;
}

async function acquireSystemAudioMute(){
  systemAudioLease.deadline=Date.now()+SYSTEM_AUDIO_LEASE_MS;
  const wasActive=systemAudioLease.active;
  const result=await runSystemAudioHelper('mute');
  if(!wasActive){
    systemAudioLease.priorMuted=Boolean(result.priorMuted);
  }
  systemAudioLease.outputMuted=Boolean(result.muted);
  if(!systemAudioLease.outputMuted){
    try{await runSystemAudioHelper('release');}catch{}
    systemAudioLease.active=false;systemAudioLease.priorMuted=false;systemAudioLease.deadline=0;
    throw new Error('Windows audio endpoint did not confirm the mute command.');
  }
  systemAudioLease.active=true;
  return systemAudioStatus(true);
}

async function releaseSystemAudioMute(){
  systemAudioLease.deadline=0;
  if(systemAudioLease.active){
    systemAudioLease.active=false;
    systemAudioLease.priorMuted=false;
    const result=await runSystemAudioHelper('release');
    systemAudioLease.outputMuted=Boolean(result.muted);
  }
  return systemAudioStatus(true);
}

function systemAudioStatus(supported){
  return {
    supported,
    mutedByRadioWatch:systemAudioLease.active,
    outputMuted:systemAudioLease.outputMuted,
    leaseRemainingMs:systemAudioLease.active?Math.max(0,systemAudioLease.deadline-Date.now()):0
  };
}

function readJsonBody(request,maximumBytes=1024){
  return new Promise((resolve,reject)=>{
    let body='',bytes=0;
    request.setEncoding('utf8');
    request.on('data',chunk=>{
      bytes+=Buffer.byteLength(chunk);
      if(bytes>maximumBytes){body='';reject(Object.assign(new Error('Request body too large.'),{statusCode:413}));return;}
      body+=chunk;
    });
    request.on('end',()=>{
      try{resolve(body?JSON.parse(body):{});}
      catch{reject(Object.assign(new Error('Invalid JSON body.'),{statusCode:400}));}
    });
    request.on('error',reject);
  });
}

async function serveSystemAudio(request,response,pathname='/api/system-audio'){
  if(!localAudioAvailable(request)){
    sendLocalAudioJson(response,200,{supported:false,mutedByRadioWatch:false,leaseRemainingMs:0,reason:'System audio control is available only from the private Windows localhost server.'});
    return;
  }
  if(!isSameOriginRequest(request)){
    sendLocalAudioJson(response,403,{supported:true,error:'Cross-origin system audio control is forbidden.'});
    return;
  }
  const fastAction=pathname==='/api/system-audio/mute'?true:pathname==='/api/system-audio/release'?false:null;
  if(fastAction!==null){
    if(request.method!=='POST'){
      response.writeHead(405,{'Allow':'POST'});response.end('Method not allowed');return;
    }
    try{
      const payload=await queueSystemAudio(()=>fastAction?acquireSystemAudioMute():releaseSystemAudioMute());
      sendLocalAudioJson(response,200,payload);
    }catch(error){sendLocalAudioJson(response,500,{supported:true,error:String(error.message||error)});}
    return;
  }
  if(request.method==='GET'||request.method==='HEAD'){
    if(request.method==='HEAD'){response.writeHead(200,{'Cache-Control':'no-store'});response.end();return;}
    try{
      const result=await queueSystemAudio(()=>runSystemAudioHelper('get'));
      systemAudioLease.outputMuted=Boolean(result.muted);
      sendLocalAudioJson(response,200,systemAudioStatus(true));
    }catch(error){sendLocalAudioJson(response,500,{supported:true,error:String(error.message||error)});}
    return;
  }
  if(request.method!=='POST'){
    response.writeHead(405,{'Allow':'GET, HEAD, POST'});response.end('Method not allowed');return;
  }
  try{
    const body=await readJsonBody(request);
    if(typeof body.active!=='boolean')throw Object.assign(new Error('The active field must be boolean.'),{statusCode:400});
    const payload=await queueSystemAudio(()=>body.active?acquireSystemAudioMute():releaseSystemAudioMute());
    sendLocalAudioJson(response,200,payload);
  }catch(error){sendLocalAudioJson(response,error.statusCode||500,{supported:true,error:String(error.message||error)});}
}

function serveHealth(response){
  sendJson(response,200,{
    ok:true,service:'radio-watch',generatedAt:new Date().toISOString(),
    trafficCacheAgeSeconds:trafficCacheTime?Math.round((Date.now()-trafficCacheTime)/1000):null,
    metarCacheAgeSeconds:metarCacheTime?Math.round((Date.now()-metarCacheTime)/1000):null
  });
}

async function serveTraffic(response){
  try{
    const payload=await loadTraffic();
    const usable=payload.feeds.ADSB.ok||payload.feeds.OGN.ok;
    sendJson(response,usable?200:502,payload);
  }catch(error){sendJson(response,502,{generatedAt:new Date().toISOString(),feeds:{ADSB:{ok:false},OGN:{ok:false}},aircraft:[],error:String(error.message||error)});}
}

async function serveMetars(response){
  try{sendJson(response,200,await loadMetars());}
  catch(error){sendJson(response,502,{generatedAt:new Date().toISOString(),source:'unavailable',reports:[],error:String(error.message||error)});}
}

function serveStatic(request,response,pathname){
  const relative=pathname==='/'?'index.html':decodeURIComponent(pathname).replace(/^\/+/, '');
  const target=path.resolve(ROOT,relative),rootPrefix=ROOT.endsWith(path.sep)?ROOT:ROOT+path.sep;
  if(target!==ROOT&&!target.toLowerCase().startsWith(rootPrefix.toLowerCase())){response.writeHead(403);response.end('Forbidden');return;}
  if(path.extname(target).toLowerCase()==='.ps1'){response.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});response.end('Not found');return;}
  fs.stat(target,(statError,stat)=>{
    const file=!statError&&stat.isDirectory()?path.join(target,'index.html'):target;
    fs.readFile(file,(error,data)=>{
      if(error){response.writeHead(error.code==='ENOENT'?404:500,{'Content-Type':'text/plain; charset=utf-8'});response.end(error.code==='ENOENT'?'Not found':'Server error');return;}
      response.writeHead(200,{
        'Content-Type':CONTENT_TYPES[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache',
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin',
        'Permissions-Policy':'usb=(self)'
      });
      response.end(request.method==='HEAD'?undefined:data);
    });
  });
}

const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/api/system-audio'||url.pathname==='/api/system-audio/mute'||url.pathname==='/api/system-audio/release'){void serveSystemAudio(request,response,url.pathname);return;}
  if(request.method==='OPTIONS'){response.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,HEAD,OPTIONS'});response.end();return;}
  if(!['GET','HEAD'].includes(request.method)){response.writeHead(405,{'Allow':'GET, HEAD, OPTIONS'});response.end('Method not allowed');return;}
  if(url.pathname==='/api/health'){serveHealth(response);return;}
  if(url.pathname==='/api/live-traffic'){serveTraffic(response);return;}
  if(url.pathname==='/api/metars'){serveMetars(response);return;}
  serveStatic(request,response,url.pathname);
});

setInterval(()=>{
  if(systemAudioLease.active&&systemAudioLease.deadline&&Date.now()>systemAudioLease.deadline){
    systemAudioLease.deadline=0;
    void queueSystemAudio(releaseSystemAudioMute).catch(error=>console.error(`Could not restore system audio after lease expiry: ${error.message}`));
  }
},500).unref();

let activePort=PORT;
server.on('error',error=>{
  if(error.code==='EADDRINUSE'&&!DEPLOYMENT_PORT&&activePort<PORT+9){
    const occupiedPort=activePort;
    activePort+=1;
    console.warn(`Port ${occupiedPort} is already in use; trying ${activePort}…`);
    server.listen(activePort,HOST);
    return;
  }
  console.error(`R4DIO DASH server failed: ${error.message}`);
  process.exitCode=1;
});
server.on('listening',()=>{
  const address=process.env.RENDER_EXTERNAL_URL||`http://${HOST}:${activePort}`;
  console.log(`R4DIO DASH: ${address}`);
});
let shutdownStarted=false;
async function shutdown(signal){
  if(shutdownStarted)return;
  shutdownStarted=true;
  console.log(`${signal} received; closing R4DIO DASH server.`);
  try{await queueSystemAudio(releaseSystemAudioMute);}
  catch(error){console.error(`Could not restore system audio during shutdown: ${error.message}`);}
  server.close(()=>{stopSystemAudioHelper();process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.once('SIGTERM',()=>shutdown('SIGTERM'));
process.once('SIGINT',()=>shutdown('SIGINT'));
server.listen(activePort,HOST);
