import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.VARIANTLAB_API_KEY || "";
const ROOT = process.env.VARIANTLAB_WORKDIR || "/tmp/variantlab-worker";
const jobs = new Map();
await fsp.mkdir(ROOT, { recursive: true });

function allowedOrigin(origin) {
  if (!origin) return "";
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname.endsWith(".higgsfield.app")) return origin;
  } catch {}
  return "";
}
function corsHeaders(req) {
  const origin = allowedOrigin(req.headers.origin);
  return origin ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,x-job-token,x-variantlab-key",
    "access-control-max-age": "86400",
    "vary": "origin",
  } : {};
}
function json(req, res, status, data) {
  res.writeHead(status, {
    ...corsHeaders(req),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
}
function masterAuth(req) {
  return Boolean(API_KEY) && req.headers["x-variantlab-key"] === API_KEY;
}
function stateAuth(req, state) {
  return masterAuth(req) || (Boolean(state?.uploadToken) && req.headers["x-job-token"] === state.uploadToken);
}
async function readJson(req, max = 2_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function saveState(state) {
  await fsp.mkdir(state.dir, { recursive: true });
  await fsp.writeFile(path.join(state.dir, "state.json"), JSON.stringify(state, null, 2));
}
async function loadState(id) {
  if (jobs.has(id)) return jobs.get(id);
  try {
    const state = JSON.parse(await fsp.readFile(path.join(ROOT, id, "state.json"), "utf8"));
    jobs.set(id, state);
    return state;
  } catch {
    return null;
  }
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d.toString(); if (err.length > 32000) err = err.slice(-32000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(err || ("ffmpeg exited " + code))));
  });
}
async function probeInfo(source) {
  return await new Promise(resolve => {
    const child = spawn(ffmpegPath || "ffmpeg", ["-i", source, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => err += d.toString());
    child.on("close", () => {
      const m = err.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve({
        duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 1,
        hasAudio: /Audio:\s/.test(err),
      });
    });
  });
}
function colorFilter(name) {
  if (name === "warm") return "eq=contrast=1.04:saturation=1.10,colorbalance=rs=.05:bs=-.03";
  if (name === "cool") return "eq=contrast=1.04:saturation=1.05,colorbalance=bs=.06:rs=-.03";
  if (name === "contrast") return "eq=contrast=1.16:saturation=1.08";
  if (name === "bw") return "hue=s=0,eq=contrast=1.10";
  if (name === "vintage") return "eq=contrast=1.05:saturation=.82:brightness=.02,colorbalance=rs=.06:gs=.02:bs=-.04";
  return "eq=contrast=1.02:saturation=1.02";
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function normalizeSegments(speechSegments, trim, duration) {
  const start = clamp(Number(trim || 0), 0, Math.max(0, duration - 0.25));
  const raw = Array.isArray(speechSegments) ? speechSegments : [];
  const picked = raw
    .map(s => ({ start: clamp(Number(s.start || 0), start, duration), end: clamp(Number(s.end || 0), start, duration) }))
    .filter(s => s.end - s.start >= 0.12 && s.end > start)
    .sort((a, b) => a.start - b.start);
  if (!picked.length) return [{ start, end: duration }];
  const merged = [];
  for (const segment of picked) {
    const padded = { start: Math.max(start, segment.start - 0.08), end: Math.min(duration, segment.end + 0.12) };
    const last = merged[merged.length - 1];
    if (last && padded.start - last.end <= 0.38) last.end = Math.max(last.end, padded.end);
    else merged.push(padded);
  }
  if (merged[0].start > start && merged[0].start - start < 0.6) merged[0].start = start;
  return merged;
}
function keptDuration(segments) {
  return segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}
function sourceTimeToOutput(time, segments, speed) {
  let elapsed = 0;
  for (const segment of segments) {
    if (time < segment.start) return elapsed / speed;
    if (time <= segment.end) return (elapsed + Math.max(0, time - segment.start)) / speed;
    elapsed += segment.end - segment.start;
  }
  return elapsed / speed;
}
function buildSourceWords(chunks) {
  const out = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const words = String(chunk.text || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const start = Number(chunk.start || 0), end = Math.max(start + .1, Number(chunk.end || start + 1));
    words.forEach((word, index) => {
      out.push({ word, start: start + (index / words.length) * (end - start), end: start + ((index + 1) / words.length) * (end - start) });
    });
  }
  return out;
}
function buildCaptionEvents(text, chunks, segments, speed, duration) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const sourceWords = buildSourceWords(chunks);
  const mapped = words.map((word, index) => {
    if (!sourceWords.length) {
      return { word, start: (index / words.length) * duration, end: ((index + 1) / words.length) * duration };
    }
    const sourceIndex = words.length === 1 ? 0 : Math.round((index / (words.length - 1)) * (sourceWords.length - 1));
    const source = sourceWords[sourceIndex];
    return {
      word,
      start: clamp(sourceTimeToOutput(source.start, segments, speed), 0, duration),
      end: clamp(sourceTimeToOutput(source.end, segments, speed), 0, duration),
    };
  });
  const events = [];
  const group = 5;
  for (let i = 0; i < mapped.length; i += group) {
    const slice = mapped.slice(i, i + group);
    const start = slice[0].start;
    const end = Math.max(start + .18, slice[slice.length - 1].end);
    events.push({ start, end, text: slice.map(x => x.word).join(" ") });
  }
  return events;
}
function assTime(sec) {
  const s = Math.max(0, sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + r.toFixed(2).padStart(5, "0");
}
function escAss(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}").replace(/\n/g, "\\N");
}
async function writeAss(file, recipe, duration, chunks, segments, speed) {
  const styleColor = recipe.subtitleStyle === "yellow" ? "&H0000FFFF" : recipe.subtitleStyle === "neon" ? "&H00FFFF7F" : "&H00FFFFFF";
  const events = [];
  if (recipe.hook) events.push("Dialogue: 1," + assTime(0) + "," + assTime(Math.min(duration, 3.4)) + ",Title,,0,0,0,," + escAss(recipe.hook));
  for (const cue of buildCaptionEvents(recipe.subtitleText, chunks, segments, speed, duration)) {
    events.push("Dialogue: 0," + assTime(cue.start) + "," + assTime(cue.end) + ",Sub,,0,0,0,," + escAss(cue.text));
  }
  const ass = "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Title,Arial,66,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,3,1,8,90,250,270,1\nStyle: Sub,Arial,56," + styleColor + "," + styleColor + ",&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,3,1,2,90,250,520,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + events.join("\n") + "\n";
  await fsp.writeFile(file, ass);
}
function cropFilter(index, anchorX, anchorY) {
  const zoom = 1 + ((index % 3) * 0.025);
  const w = 1080 / zoom, h = 1920 / zoom;
  const x = "max(0,min(iw-ow,iw*" + clamp(anchorX, .15, .85) + "-ow/2))";
  const y = "max(0,min(ih-oh,ih*" + clamp(anchorY, .18, .75) + "-oh/2))";
  return "scale=1080:1920:force_original_aspect_ratio=increase,crop=" + w.toFixed(2) + ":" + h.toFixed(2) + ":x='" + x + "':y='" + y + "',scale=1080:1920";
}
async function callbackOutput(state, recipe, kind, file) {
  if (!state.callbackUrl || !state.callbackToken) return;
  const body = await fsp.readFile(file);
  const url = new URL(state.callbackUrl);
  url.searchParams.set("jobId", state.id);
  url.searchParams.set("variantId", String(recipe.variantId || recipe.id || ""));
  url.searchParams.set("kind", kind);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": kind === "video" ? "video/mp4" : "image/jpeg",
      "x-cloud-token": state.callbackToken,
    },
    body,
  });
  if (!response.ok) throw new Error("Callback failed " + response.status + ": " + await response.text());
}
async function renderVariant(state, recipe, index) {
  const source = path.join(state.dir, "source.mp4");
  const base = "variant-" + String(index + 1).padStart(2, "0");
  const output = path.join(state.dir, base + ".mp4");
  const poster = path.join(state.dir, base + ".jpg");
  const info = await probeInfo(source);
  const speed = Number(recipe.speed || 1);
  const segments = normalizeSegments(state.speechSegments, state.trimStartSeconds, info.duration);
  const duration = Math.max(.25, keptDuration(segments)) / speed;
  const ass = path.join(state.dir, "captions-" + index + ".ass");
  await writeAss(ass, recipe, duration, state.transcriptChunks, segments, speed);

  const anchorX = Number(state.faceAnchor?.x || .5);
  const anchorY = Number(state.faceAnchor?.y || .42);
  const graph = [];
  const videoLabels = [], audioLabels = [];
  segments.forEach((segment, i) => {
    graph.push("[0:v]trim=start=" + segment.start.toFixed(3) + ":end=" + segment.end.toFixed(3) + ",setpts=(PTS-STARTPTS)/" + speed + "," + cropFilter(index, anchorX, anchorY) + "," + colorFilter(recipe.colorPreset) + "[v" + i + "]");
    videoLabels.push("[v" + i + "]");
    if (info.hasAudio) {
      graph.push("[0:a]atrim=start=" + segment.start.toFixed(3) + ":end=" + segment.end.toFixed(3) + ",asetpts=PTS-STARTPTS" + (speed !== 1 ? ",atempo=" + speed : "") + "[a" + i + "]");
      audioLabels.push("[a" + i + "]");
    }
  });
  if (segments.length > 1) graph.push(videoLabels.join("") + "concat=n=" + segments.length + ":v=1:a=0[vcat]");
  else graph.push(videoLabels[0] + "null[vcat]");
  if (info.hasAudio) {
    if (segments.length > 1) graph.push(audioLabels.join("") + "concat=n=" + segments.length + ":v=0:a=1[acat]");
    else graph.push(audioLabels[0] + "anull[acat]");
  }
  graph.push("[vcat]subtitles='" + ass.replace(/'/g, "\\'") + "'[vout]");

  const args = ["-i", source, "-filter_complex", graph.join(";"), "-map", "[vout]"];
  if (info.hasAudio) args.push("-map", "[acat]");
  args.push("-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p");
  if (info.hasAudio) args.push("-c:a", "aac", "-b:a", "128k");
  args.push("-movflags", "+faststart", output);

  await runFfmpeg(args);
  await runFfmpeg(["-ss", "0.25", "-i", output, "-frames:v", "1", "-q:v", "3", poster]);
  await callbackOutput(state, recipe, "poster", poster);
  await callbackOutput(state, recipe, "video", output);
  return { video: path.basename(output), poster: path.basename(poster) };
}
async function renderJob(state) {
  state.status = "running"; state.progress = 0; state.error = null; await saveState(state);
  const recipes = state.recipes || [];
  const concurrency = Math.min(3, Math.max(1, Number(state.concurrency || 2)));
  let cursor = 0, done = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= recipes.length) return;
      const recipe = recipes[index];
      state.variants[index] = { position: index + 1, variantId: recipe.variantId, status: "running" };
      await saveState(state);
      try {
        const files = await renderVariant(state, recipe, index);
        state.variants[index] = { position: index + 1, variantId: recipe.variantId, status: "done", ...files };
      } catch (error) {
        state.variants[index] = { position: index + 1, variantId: recipe.variantId, status: "error", error: String(error.message || error).slice(-1600) };
      }
      done += 1;
      state.progress = Math.round(done * 100 / Math.max(1, recipes.length));
      await saveState(state);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const failed = state.variants.some(v => v && v.status === "error");
  state.status = failed ? "error" : "done";
  state.progress = 100;
  state.error = failed ? "Una o más variantes fallaron." : null;
  await saveState(state);
  setTimeout(() => fsp.rm(state.dir, { recursive: true, force: true }).catch(() => undefined), 6 * 60 * 60 * 1000).unref?.();
}
async function assembleSource(state, total) {
  const target = path.join(state.dir, "source.mp4");
  const ws = fs.createWriteStream(target);
  for (let i = 0; i < total; i += 1) {
    const chunkFile = path.join(state.dir, "chunk-" + i);
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(chunkFile);
      rs.on("error", reject);
      rs.on("end", resolve);
      rs.pipe(ws, { end: false });
    });
  }
  await new Promise(resolve => ws.end(resolve));
  for (let i = 0; i < total; i += 1) await fsp.unlink(path.join(state.dir, "chunk-" + i)).catch(() => undefined);
}
function streamFile(req, res, file, type, name) {
  const stat = fs.statSync(file);
  res.writeHead(200, {
    ...corsHeaders(req),
    "content-type": type,
    "content-length": String(stat.size),
    "content-disposition": 'attachment; filename="' + name + '"',
  });
  fs.createReadStream(file).pipe(res);
}
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost:" + PORT);
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req)); res.end(); return;
  }
  if (req.method === "GET" && url.pathname === "/health") return json(req, res, 200, { ok: true, ffmpeg: Boolean(ffmpegPath), jobs: jobs.size });

  if (req.method === "POST" && url.pathname === "/jobs") {
    if (!masterAuth(req)) return json(req, res, 401, { ok: false, error: "unauthorized" });
    const body = await readJson(req);
    const id = safeId(body.jobId || crypto.randomUUID());
    const dir = path.join(ROOT, id);
    await fsp.mkdir(dir, { recursive: true });
    const uploadToken = randomBytes(24).toString("base64url");
    const recipes = Array.isArray(body.recipes) ? body.recipes.slice(0, 30) : [];
    const state = {
      id, dir, uploadToken, status: "uploading", progress: 0, error: null,
      recipes, trimStartSeconds: Number(body.trimStartSeconds || 0),
      speechSegments: Array.isArray(body.speechSegments) ? body.speechSegments : [],
      transcriptChunks: Array.isArray(body.transcriptChunks) ? body.transcriptChunks : [],
      faceAnchor: body.faceAnchor || { x: .5, y: .42 },
      callbackUrl: String(body.callbackUrl || ""),
      callbackToken: String(body.callbackToken || ""),
      variants: recipes.map((r, i) => ({ position: i + 1, variantId: r.variantId, status: "queued" })),
    };
    jobs.set(id, state); await saveState(state);
    return json(req, res, 200, { ok: true, jobId: id, uploadToken });
  }

  let match = url.pathname.match(/^\/jobs\/([^/]+)\/recipes$/);
  if (req.method === "PATCH" && match) {
    if (!masterAuth(req)) return json(req, res, 401, { ok: false, error: "unauthorized" });
    const state = await loadState(safeId(match[1])); if (!state) return json(req, res, 404, { ok: false });
    if (!["uploading", "queued"].includes(state.status)) return json(req, res, 409, { ok: false, error: "job already started" });
    const body = await readJson(req);
    const extra = Array.isArray(body.recipes) ? body.recipes : [];
    if (state.recipes.length + extra.length > 30) return json(req, res, 400, { ok: false, error: "maximum 30 variants" });
    state.recipes.push(...extra);
    state.variants = state.recipes.map((r, i) => state.variants[i] || ({ position: i + 1, variantId: r.variantId, status: "queued" }));
    await saveState(state);
    return json(req, res, 200, { ok: true, total: state.recipes.length });
  }

  match = url.pathname.match(/^\/jobs\/([^/]+)\/chunks\/(\d+)$/);
  if (req.method === "PUT" && match) {
    const state = await loadState(safeId(match[1])); if (!state) return json(req, res, 404, { ok: false });
    if (!stateAuth(req, state)) return json(req, res, 401, { ok: false, error: "unauthorized" });
    const index = Number(match[2]);
    const out = fs.createWriteStream(path.join(state.dir, "chunk-" + index));
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { out.destroy(); return json(req, res, 413, { ok: false, error: "chunk too large" }); }
      out.write(chunk);
    }
    await new Promise(resolve => out.end(resolve));
    return json(req, res, 200, { ok: true, index });
  }

  match = url.pathname.match(/^\/jobs\/([^/]+)\/finalize$/);
  if (req.method === "POST" && match) {
    const state = await loadState(safeId(match[1])); if (!state) return json(req, res, 404, { ok: false });
    if (!stateAuth(req, state)) return json(req, res, 401, { ok: false, error: "unauthorized" });
    const body = await readJson(req);
    await assembleSource(state, Number(body.totalChunks));
    state.status = "queued"; await saveState(state);
    setImmediate(() => renderJob(state));
    return json(req, res, 202, { ok: true, jobId: state.id, variants: state.recipes.length });
  }

  match = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const state = await loadState(safeId(match[1])); if (!state) return json(req, res, 404, { ok: false });
    if (!stateAuth(req, state)) return json(req, res, 401, { ok: false, error: "unauthorized" });
    return json(req, res, 200, { ok: true, job: { id: state.id, status: state.status, progress: state.progress, error: state.error, variants: state.variants } });
  }

  match = url.pathname.match(/^\/jobs\/([^/]+)\/variants\/(\d+)\/(video|poster)$/);
  if (req.method === "GET" && match) {
    const state = await loadState(safeId(match[1])); if (!state) return json(req, res, 404, { ok: false });
    if (!stateAuth(req, state)) return json(req, res, 401, { ok: false, error: "unauthorized" });
    const index = Number(match[2]) - 1, variant = state.variants[index];
    if (!variant || variant.status !== "done") return json(req, res, 404, { ok: false });
    const kind = match[3], name = kind === "video" ? variant.video : variant.poster;
    return streamFile(req, res, path.join(state.dir, name), kind === "video" ? "video/mp4" : "image/jpeg", name);
  }

  match = url.pathname.match(/^\/jobs\/([^/]+)\/download-all$/);
  if (req.method === "GET" && match) {
    const state = await loadState(safeId(match[1])); if (!state) return json(req, res, 404, { ok: false });
    if (!stateAuth(req, state)) return json(req, res, 401, { ok: false, error: "unauthorized" });
    res.writeHead(200, { ...corsHeaders(req), "content-type": "application/zip", "content-disposition": 'attachment; filename="VariantLab-' + state.id + '.zip"' });
    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("error", error => res.destroy(error)); archive.pipe(res);
    for (const variant of state.variants.filter(v => v && v.status === "done")) archive.file(path.join(state.dir, variant.video), { name: variant.video });
    await archive.finalize(); return;
  }
  return json(req, res, 404, { ok: false, error: "not found" });
}
http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(req, res, 500, { ok: false, error: String(error.message || error) });
    else res.destroy();
  });
}).listen(PORT, () => console.log("VariantLab worker listening on " + PORT));
