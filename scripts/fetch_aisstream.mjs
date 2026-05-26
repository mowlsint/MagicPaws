#!/usr/bin/env node
/**
 * MAGIC PAWS // AISstream collector
 * Collects a short AISstream sample for North Sea/Channel and Baltic BBoxes,
 * writes data/live/ais_latest.json and appends data/live/ais_history.ndjson.
 *
 * Required secret/env: AISSTREAM_API_KEY
 * Optional env: AIS_SAMPLE_SECONDS (default 120), AIS_MAX_MESSAGES (default 3000)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "config", "live_sensor_regions.yml");
const outDir = path.join(repoRoot, "data", "live");
const latestPath = path.join(outDir, "ais_latest.json");
const histPath = path.join(outDir, "ais_history.ndjson");

const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = process.env.AISSTREAM_API_KEY || process.env.AISSTREAM_KEY || "";
const SAMPLE_SECONDS = Math.max(30, Number(process.env.AIS_SAMPLE_SECONDS || 120));
const MAX_MESSAGES = Math.max(100, Number(process.env.AIS_MAX_MESSAGES || 3000));

function nowIso(){ return new Date().toISOString(); }
function norm(s){ return String(s ?? "").trim(); }
function asNum(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function inBbox(lat, lon, bbox){
  if (!Array.isArray(bbox) || bbox.length < 2) return false;
  const a = bbox[0], b = bbox[1];
  const minLat = Math.min(Number(a[0]), Number(b[0]));
  const maxLat = Math.max(Number(a[0]), Number(b[0]));
  const minLon = Math.min(Number(a[1]), Number(b[1]));
  const maxLon = Math.max(Number(a[1]), Number(b[1]));
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}
function regionFor(lat, lon, regions){
  for (const [id, cfg] of Object.entries(regions || {})){
    if (inBbox(lat, lon, cfg.bbox)) return { id, weirdness_bucket: cfg.weirdness_bucket || id, label_de: cfg.label_de || id };
  }
  return { id:"unknown", weirdness_bucket:"unknown", label_de:"Unknown" };
}
function haversineNm(a,b){
  const R = 3440.065;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat-a.lat), dLon = toRad(b.lon-a.lon);
  const s1 = Math.sin(dLat/2), s2 = Math.sin(dLon/2);
  const x = s1*s1 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*s2*s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function boolAuthority(item, rules){
  const nameRe = new RegExp(rules.ais_name_regex || "coast guard|police|customs|navy|patrol|sar|rescue", "i");
  const typeSet = new Set((rules.ais_ship_type_codes || []).map(Number));
  const text = [item.name, item.callsign, item.destination, item.type_text].map(norm).join(" ");
  return nameRe.test(text) || typeSet.has(Number(item.ship_type));
}
function clusterAuthority(items){
  const authority = items.filter(x => x.authority_like && Number.isFinite(x.lat) && Number.isFinite(x.lon));
  const clusters = [];
  for (const a of authority){
    const members = authority.filter(b => haversineNm(a,b) <= 5);
    if (members.length >= 3) {
      const key = members.map(m => m.mmsi || m.name || `${m.lat},${m.lon}`).sort().join("|");
      if (!clusters.some(c => c.key === key)) {
        clusters.push({
          key,
          count: members.length,
          center: {
            lat: Number((members.reduce((s,m)=>s+m.lat,0)/members.length).toFixed(5)),
            lon: Number((members.reduce((s,m)=>s+m.lon,0)/members.length).toFixed(5))
          },
          mmsi: members.map(m => m.mmsi).filter(Boolean).slice(0,12),
          names: members.map(m => m.name).filter(Boolean).slice(0,12)
        });
      }
    }
  }
  return clusters.sort((a,b)=>b.count-a.count).slice(0,20);
}
function extractPosition(msg){
  const type = msg?.MessageType || msg?.message_type || "";
  const meta = msg?.MetaData || msg?.Metadata || msg?.metadata || {};
  const body = msg?.Message?.[type] || msg?.Message?.PositionReport || msg?.Message?.StandardClassBPositionReport || msg?.Message?.ExtendedClassBPositionReport || {};
  const lat = asNum(meta.latitude ?? meta.Latitude ?? body.Latitude ?? body.latitude);
  const lon = asNum(meta.longitude ?? meta.Longitude ?? body.Longitude ?? body.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const mmsi = norm(meta.MMSI ?? body.UserID ?? body.user_id ?? body.mmsi);
  const shipType = asNum(body.ShipType ?? body.Type ?? body.ship_type ?? meta.ShipType ?? meta.ship_type);
  return {
    type: "ais",
    message_type: type || "AIS",
    mmsi,
    name: norm(meta.ShipName ?? meta.ship_name ?? body.Name ?? body.ShipName),
    callsign: norm(meta.CallSign ?? body.CallSign),
    destination: norm(body.Destination ?? meta.Destination),
    lat, lon,
    sog: asNum(body.Sog ?? body.SOG ?? meta.SOG),
    cog: asNum(body.Cog ?? body.COG ?? meta.COG),
    heading: asNum(body.TrueHeading ?? body.Heading ?? meta.TrueHeading),
    nav_status: asNum(body.NavigationalStatus ?? body.nav_status),
    ship_type: shipType,
    ts: norm(meta.time_utc ?? meta.TimeUTC ?? meta.timestamp) || nowIso(),
    raw_source: "aisstream"
  };
}
async function writeJson(pathname, data){
  await fs.mkdir(path.dirname(pathname), { recursive:true });
  await fs.writeFile(pathname, JSON.stringify(data, null, 2) + "\n", "utf8");
}
async function main(){
  const cfg = YAML.parse(await fs.readFile(configPath, "utf8"));
  const regions = cfg.regions || {};
  const bboxes = Object.values(regions).map(r => r.bbox).filter(Boolean);
  const rules = cfg.authority_detection || {};

  if (!API_KEY) {
    const out = { ok:false, source:"aisstream", generated_at:nowIso(), error:"missing AISSTREAM_API_KEY", regions:Object.keys(regions), items:[], clusters:[], summary:{ authority_vessels:0, total:0 } };
    await writeJson(latestPath, out);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const seen = new Map();
  const errors = [];
  const started = Date.now();

  await new Promise((resolve) => {
    const ws = new WebSocket(AIS_URL);
    const finish = () => { try { ws.close(); } catch {} resolve(); };
    const timer = setTimeout(finish, SAMPLE_SECONDS * 1000);

    ws.on("open", () => {
      const sub = { APIKey: API_KEY, BoundingBoxes: bboxes, FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"] };
      ws.send(JSON.stringify(sub));
    });
    ws.on("message", (buf) => {
      if (seen.size >= MAX_MESSAGES) return finish();
      try {
        const msg = JSON.parse(buf.toString());
        if (msg?.error) { errors.push(String(msg.error)); return; }
        const item = extractPosition(msg);
        if (!item) return;
        const r = regionFor(item.lat, item.lon, regions);
        if (r.id === "unknown") return;
        item.region_id = r.id;
        item.weirdness_bucket = r.weirdness_bucket;
        item.region_label_de = r.label_de;
        item.authority_like = boolAuthority(item, rules);
        item.flags = [];
        if (item.authority_like) item.flags.push("authority_like");
        if (item.ship_type === 55) item.flags.push("law_enforcement_type");
        if (item.ship_type === 51) item.flags.push("sar_type");
        const key = item.mmsi || `${item.lat.toFixed(4)},${item.lon.toFixed(4)},${item.name}`;
        seen.set(key, item);
      } catch(e) { errors.push(e.message); }
    });
    ws.on("error", (e) => { errors.push(e.message || String(e)); });
    ws.on("close", () => { clearTimeout(timer); resolve(); });
  });

  const items = [...seen.values()].sort((a,b)=>String(a.mmsi).localeCompare(String(b.mmsi)));
  const clusters = clusterAuthority(items);
  const byRegion = {};
  for (const it of items){
    const k = it.weirdness_bucket || "unknown";
    byRegion[k] ||= { total:0, authority_vessels:0, clusters_5nm:0 };
    byRegion[k].total++;
    if (it.authority_like) byRegion[k].authority_vessels++;
  }
  for (const c of clusters){
    const r = regionFor(c.center.lat, c.center.lon, regions).weirdness_bucket;
    byRegion[r] ||= { total:0, authority_vessels:0, clusters_5nm:0 };
    byRegion[r].clusters_5nm++;
  }
  const out = {
    ok: errors.length === 0 || items.length > 0,
    source: "aisstream",
    generated_at: nowIso(),
    window_seconds: Math.round((Date.now() - started) / 1000),
    sample_seconds_requested: SAMPLE_SECONDS,
    regions: Object.keys(regions),
    item_count: items.length,
    items,
    clusters_5nm: clusters,
    summary: { total: items.length, authority_vessels: items.filter(x=>x.authority_like).length, by_region: byRegion },
    errors: errors.slice(0, 10)
  };
  await writeJson(latestPath, out);
  await fs.appendFile(histPath, JSON.stringify({ generated_at: out.generated_at, item_count: out.item_count, summary: out.summary, clusters_5nm: out.clusters_5nm.slice(0,5) }) + "\n", "utf8");
  console.log(JSON.stringify({ ok: out.ok, item_count: out.item_count, summary: out.summary, errors: out.errors }, null, 2));
}
main().catch(async err => {
  const out = { ok:false, source:"aisstream", generated_at:nowIso(), error:String(err?.stack || err), items:[], clusters_5nm:[], summary:{ total:0, authority_vessels:0 } };
  await writeJson(latestPath, out).catch(()=>{});
  console.error(err);
  process.exitCode = 1;
});
