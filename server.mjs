import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.VARIANTLAB_API_KEY || "";
const ROOT = process.env.VARIANTLAB_WORKDIR || "/tmp/variantlab-worker";
const jobs = new Map();
await fsp.mkdir(ROOT, { recursive: true });

function json(res, status, data) {
  res.writeHead(status, {"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
  res.end(JSON.stringify(data));
}
function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
}
function auth(req) {
  return Boolean(API_KEY) && req.headers["x-variantlab-key"] === API_KEY;
}
async function readJson(req, max) {
  const chunks=[]; let size=0; const limit=max || 2000000;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function saveState(state) {
  await fsp.mkdir(state.dir,{recursive:true});
  await fsp.writeFile(path.join(state.dir,"state.json"),JSON.stringify(state,null,2));
}
async function loadState(id) {
  if (jobs.has(id)) return jobs.get(id);
  try {
    const state=JSON.parse(await fsp.readFile(path.join(ROOT,id,"state.json"),"utf8"));
    jobs.set(id,state);
    return state;
  } catch {
    return null;
  }
}
function runFfmpeg(args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(ffmpegPath || "ffmpeg",args,{stdio:["ignore","ignore","pipe"]});
    let err="";
    child.stderr.on("data",d=>{err+=d.toString();if(err.length>24000)err=err.slice(-24000);});
    child.on("error",reject);
    child.on("close",code=>code===0?resolve():reject(new Error(err || ("ffmpeg exited "+code))));
  });
}
function colorFilter(name) {
  if(name==="warm") return "eq=contrast=1.04:saturation=1.10,colorbalance=rs=.05:bs=-.03";
  if(name==="cool") return "eq=contrast=1.04:saturation=1.05,colorbalance=bs=.06:rs=-.03";
  if(name==="contrast") return "eq=contrast=1.16:saturation=1.08";
  if(name==="bw") return "hue=s=0,eq=contrast=1.10";
  if(name==="vintage") return "eq=contrast=1.05:saturation=.82:brightness=.02,colorbalance=rs=.06:gs=.02:bs=-.04";
  return "eq=contrast=1.02:saturation=1.02";
}
function assTime(sec) {
  const s=Math.max(0,sec); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const r=s%60;
  return h+":"+String(m).padStart(2,"0")+":"+r.toFixed(2).padStart(5,"0");
}
function escAss(value) {
  return String(value||"").replace(/\\/g,"\\\\").replace(/{/g,"\\{").replace(/}/g,"\\}").replace(/\n/g,"\\N");
}
async function writeAss(file, recipe, duration) {
  const words=String(recipe.subtitleText||"").trim().split(/\s+/).filter(Boolean);
  const cues=[]; for(let i=0;i<words.length;i+=6)cues.push(words.slice(i,i+6).join(" "));
  const cueDur=cues.length?duration/cues.length:duration;
  const styleColor=recipe.subtitleStyle==="yellow"?"&H0000FFFF":recipe.subtitleStyle==="neon"?"&H00FFFF7F":"&H00FFFFFF";
  const events=[];
  if(recipe.hook)events.push("Dialogue: 1,"+assTime(0)+","+assTime(Math.min(duration,3.4))+",Title,,0,0,0,,"+escAss(recipe.hook));
  cues.forEach((text,i)=>events.push("Dialogue: 0,"+assTime(i*cueDur)+","+assTime(Math.min(duration,(i+1)*cueDur))+",Sub,,0,0,0,,"+escAss(text)));
  const ass="[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Title,Arial,66,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,3,1,8,90,250,270,1\nStyle: Sub,Arial,56,"+styleColor+","+styleColor+",&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,3,1,2,90,250,520,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"+events.join("\n")+"\n";
  await fsp.writeFile(file,ass);
}
async function probeDuration(source) {
  return await new Promise(resolve=>{
    const child=spawn(ffmpegPath || "ffmpeg",["-i",source,"-f","null","-"],{stdio:["ignore","ignore","pipe"]});
    let err=""; child.stderr.on("data",d=>err+=d.toString());
    child.on("close",()=>{
      const m=err.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):1);
    });
  });
}
async function renderVariant(state,recipe,index) {
  const source=path.join(state.dir,"source.mp4");
  const base="variant-"+String(index+1).padStart(2,"0");
  const output=path.join(state.dir,base+".mp4");
  const poster=path.join(state.dir,base+".jpg");
  const trim=Math.max(0,Number(state.trimStartSeconds||0));
  const sourceDuration=await probeDuration(source);
  const speed=Number(recipe.speed||1);
  const duration=Math.max(.25,sourceDuration-trim)/speed;
  const ass=path.join(state.dir,"captions-"+index+".ass");
  await writeAss(ass,recipe,duration);
  const zoom=1+((index%3)*0.025);
  const vf=[
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop="+(1080/zoom)+":"+(1920/zoom),
    "scale=1080:1920",
    colorFilter(recipe.colorPreset),
    "setpts=PTS/"+speed,
    "subtitles='"+ass.replace(/'/g,"\\'")+"'"
  ].join(",");
  const args=[];
  if(trim>.05)args.push("-ss",trim.toFixed(3));
  args.push("-i",source,"-vf",vf,"-map","0:v:0","-map","0:a?");
  if(speed!==1)args.push("-filter:a","atempo="+speed);
  args.push("-t",duration.toFixed(3),"-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p","-c:a","aac","-b:a","128k","-movflags","+faststart",output);
  await runFfmpeg(args);
  await runFfmpeg(["-ss","0.25","-i",output,"-frames:v","1","-q:v","3",poster]);
  return {video:path.basename(output),poster:path.basename(poster)};
}
async function renderJob(state) {
  state.status="running";state.progress=0;state.error=null;await saveState(state);
  const recipes=state.recipes||[];const concurrency=Math.min(3,Math.max(1,Number(state.concurrency||2)));
  let cursor=0,done=0;
  async function worker(){
    while(true){
      const index=cursor++;
      if(index>=recipes.length)return;
      const recipe=recipes[index];
      state.variants[index]={position:index+1,status:"running"};await saveState(state);
      try{
        const files=await renderVariant(state,recipe,index);
        state.variants[index]={position:index+1,status:"done",...files};
      }catch(error){
        state.variants[index]={position:index+1,status:"error",error:String(error.message||error).slice(-1200)};
      }
      done+=1;state.progress=Math.round(done*100/recipes.length);await saveState(state);
    }
  }
  await Promise.all(Array.from({length:concurrency},()=>worker()));
  const failed=state.variants.some(v=>v&&v.status==="error");
  state.status=failed?"error":"done";state.progress=100;state.error=failed?"Una o más variantes fallaron.":null;await saveState(state);
}
async function assembleSource(state,total){
  const target=path.join(state.dir,"source.mp4");
  const ws=fs.createWriteStream(target);
  for(let i=0;i<total;i++){
    const chunkFile=path.join(state.dir,"chunk-"+i);
    await new Promise((resolve,reject)=>{
      const rs=fs.createReadStream(chunkFile);
      rs.on("error",reject);rs.on("end",resolve);rs.pipe(ws,{end:false});
    });
  }
  await new Promise(resolve=>ws.end(resolve));
  for(let i=0;i<total;i++)await fsp.unlink(path.join(state.dir,"chunk-"+i)).catch(()=>{});
}
function streamFile(res,file,type,name){
  const stat=fs.statSync(file);
  res.writeHead(200,{"content-type":type,"content-length":String(stat.size),"content-disposition":'attachment; filename="'+name+'"'});
  fs.createReadStream(file).pipe(res);
}
async function handle(req,res){
  const url=new URL(req.url,"http://localhost:"+PORT);
  if(req.method==="GET"&&url.pathname==="/health")return json(res,200,{ok:true,ffmpeg:Boolean(ffmpegPath),jobs:jobs.size});
  if(!auth(req))return json(res,401,{ok:false,error:"unauthorized"});
  if(req.method==="POST"&&url.pathname==="/jobs"){
    const body=await readJson(req);const id=safeId(body.jobId||crypto.randomUUID());const dir=path.join(ROOT,id);await fsp.mkdir(dir,{recursive:true});
    const state={id,dir,status:"uploading",progress:0,error:null,recipes:Array.isArray(body.recipes)?body.recipes.slice(0,30):[],trimStartSeconds:Number(body.trimStartSeconds||0),variants:[]};
    jobs.set(id,state);await saveState(state);return json(res,200,{ok:true,jobId:id});
  }
  let match=url.pathname.match(/^\/jobs\/([^/]+)\/chunks\/(\d+)$/);
  if(req.method==="PUT"&&match){
    const state=await loadState(safeId(match[1]));if(!state)return json(res,404,{ok:false});
    const index=Number(match[2]);const out=fs.createWriteStream(path.join(state.dir,"chunk-"+index));let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024){out.destroy();return json(res,413,{ok:false,error:"chunk too large"});}out.write(chunk);}
    await new Promise(resolve=>out.end(resolve));return json(res,200,{ok:true,index});
  }
  match=url.pathname.match(/^\/jobs\/([^/]+)\/finalize$/);
  if(req.method==="POST"&&match){
    const state=await loadState(safeId(match[1]));if(!state)return json(res,404,{ok:false});const body=await readJson(req);
    await assembleSource(state,Number(body.totalChunks));state.status="queued";await saveState(state);setImmediate(()=>renderJob(state));return json(res,202,{ok:true,jobId:state.id});
  }
  match=url.pathname.match(/^\/jobs\/([^/]+)$/);
  if(req.method==="GET"&&match){
    const state=await loadState(safeId(match[1]));if(!state)return json(res,404,{ok:false});
    return json(res,200,{ok:true,job:{id:state.id,status:state.status,progress:state.progress,error:state.error,variants:state.variants}});
  }
  match=url.pathname.match(/^\/jobs\/([^/]+)\/variants\/(\d+)\/(video|poster)$/);
  if(req.method==="GET"&&match){
    const state=await loadState(safeId(match[1]));if(!state)return json(res,404,{ok:false});
    const index=Number(match[2])-1;const variant=state.variants[index];if(!variant||variant.status!=="done")return json(res,404,{ok:false});
    const kind=match[3];const name=kind==="video"?variant.video:variant.poster;return streamFile(res,path.join(state.dir,name),kind==="video"?"video/mp4":"image/jpeg",name);
  }
  match=url.pathname.match(/^\/jobs\/([^/]+)\/download-all$/);
  if(req.method==="GET"&&match){
    const state=await loadState(safeId(match[1]));if(!state)return json(res,404,{ok:false});
    res.writeHead(200,{"content-type":"application/zip","content-disposition":'attachment; filename="VariantLab-'+state.id+'.zip"'});
    const archive=archiver("zip",{zlib:{level:0}});archive.on("error",error=>res.destroy(error));archive.pipe(res);
    for(const variant of state.variants.filter(v=>v&&v.status==="done"))archive.file(path.join(state.dir,variant.video),{name:variant.video});
    await archive.finalize();return;
  }
  return json(res,404,{ok:false,error:"not found"});
}
http.createServer((req,res)=>{handle(req,res).catch(error=>{console.error(error);if(!res.headersSent)json(res,500,{ok:false,error:String(error.message||error)});else res.destroy();});}).listen(PORT,()=>console.log("VariantLab worker listening on "+PORT));
