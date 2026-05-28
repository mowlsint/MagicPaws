#!/usr/bin/env node
/**
 * MAGIC PAWS // ADS-B collector
 * Pulls adsb.fi public v3 radius endpoints for maritime North Sea/Channel and Baltic tiles,
 * writes data/live/adsb_latest.json and appends data/live/adsb_history.ndjson.
 *
 * Optional env: ADSB_API_BASE (default https://opendata.adsb.fi/api), ADSB_REQUEST_DELAY_MS (default 1200)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "config", "live_sensor_regions.yml");
const outDir = path.join(repoRoot, "data", "live");
const latestPath = path.join(outDir, "adsb_latest.json");
const histPath = path.join(outDir, "adsb_history.ndjson");
const API_BASE = (process.env.ADSB_API_BASE || "https://opendata.adsb.fi/api").replace(/\/$/, "");
const DELAY_MS = Math.max(1050, Number(process.env.ADSB_REQUEST_DELAY_MS || 1200));

function nowIso(){ return new Date().toISOString(); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function norm(s){ return String(s ?? "").trim(); }
function asNum(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

function cleanRegexPattern(value, fallback = ""){
  let raw = String(value ?? fallback ?? "").trim();
  // Config files sometimes contain PCRE/Python inline flags like (?i).
  // JavaScript RegExp uses the second argument ("i"), so strip inline flags safely.
  raw = raw
    .replace(/^\(\?[a-zA-Z]+\)/, "")
    .replace(/\(\?i\)/g, "")
    .replace(/\(\?-i\)/g, "");
  return raw || fallback;
}
function safeRegExp(value, fallback = "", flags = "i"){
  const pattern = cleanRegexPattern(value, fallback);
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    console.warn(`Invalid regex pattern "${pattern}", using fallback: ${err.message}`);
    return new RegExp(cleanRegexPattern(fallback, ""), flags);
  }
}
function inBbox(lat, lon, bbox){
  if (!Array.isArray(bbox) || bbox.length < 2) return false;
  const a = bbox[0], b = bbox[1];
  return lat >= Math.min(a[0],b[0]) && lat <= Math.max(a[0],b[0]) && lon >= Math.min(a[1],b[1]) && lon <= Math.max(a[1],b[1]);
}
function regionFor(lat, lon, regions){
  for (const [id, cfg] of Object.entries(regions || {})){
    if (inBbox(lat, lon, cfg.bbox)) return { id, weirdness_bucket: cfg.weirdness_bucket || id, label_de: cfg.label_de || id };
  }
  return { id:"unknown", weirdness_bucket:"unknown", label_de:"Unknown" };
}
function authorityLike(ac, rules){
  const callRe = safeRegExp(rules.adsb_callsign_regex, "nato|gaf|sar|coast|police|navy|mpa", "i");
  const typeRe = safeRegExp(rules.adsb_type_regex, "p-?8|p-?3|c295|cn235|helicopter", "i");
  const text = [ac.flight, ac.callsign, ac.t, ac.desc, ac.type, ac.r, ac.ownOp, ac.operator].map(norm).join(" ");
  return Boolean(ac.mil) || callRe.test(text) || typeRe.test(text);
}
function classifyFlags(ac, item){
  const txt = [item.callsign, item.type_code, item.description, item.operator].join(" ").toLowerCase();
  const flags = [];
  if (item.authority_like) flags.push("authority_like");
  if (ac.mil) flags.push("military_flag");
  if (/p-?8|poseidon|p-?3|orion|atl2|mpa|maritime patrol/.test(txt)) flags.push("mpa_possible");
  if (/sar|rescue|coast.?guard|search/.test(txt)) flags.push("sar_or_coastguard_possible");
  if (/isr|recon|surveillance|raven|eagle/.test(txt)) flags.push("isr_possible");
  return flags;
}
function normalizeAircraft(ac, region, rules){
  const lat = asNum(ac.lat), lon = asNum(ac.lon);
  if (lat === null || lon === null || Math.abs(lat)>90 || Math.abs(lon)>180) return null;
  const r = regionFor(lat, lon, { [region.id]: region.cfg });
  if (r.id === "unknown") return null;
  const item = {
    type: "adsb",
    hex: norm(ac.hex),
    callsign: norm(ac.flight || ac.callsign).replace(/\s+/g," "),
    registration: norm(ac.r),
    type_code: norm(ac.t),
    description: norm(ac.desc),
    operator: norm(ac.ownOp || ac.operator),
    lat, lon,
    alt_baro: ac.alt_baro ?? null,
    alt_geom: ac.alt_geom ?? null,
    track: asNum(ac.track),
    gs: asNum(ac.gs),
    squawk: norm(ac.squawk),
    seen: asNum(ac.seen),
    seen_pos: asNum(ac.seen_pos),
    emergency: norm(ac.emergency),
    mil: Boolean(ac.mil),
    region_id: r.id,
    weirdness_bucket: r.weirdness_bucket,
    region_label_de: r.label_de,
    ts: nowIso(),
    raw_source: "adsb.fi"
  };
  item.authority_like = authorityLike(ac, rules);
  item.flags = classifyFlags(ac, item);
  return item;
}
async function writeJson(pathname, data){
  await fs.mkdir(path.dirname(pathname), { recursive:true });
  await fs.writeFile(pathname, JSON.stringify(data, null, 2) + "\n", "utf8");
}
async function fetchJson(url){
  const res = await fetch(url, { headers: { "Accept":"application/json", "User-Agent":"MagicPaws/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}
async function main(){
  const cfg = YAML.parse(await fs.readFile(configPath, "utf8"));
  const rules = cfg.authority_detection || {};
  const items = new Map();
  const errors = [];
  const calls = [];

  for (const [id, rcfg] of Object.entries(cfg.regions || {})){
    for (const q of (rcfg.adsb_queries || [])){
      const dist = Math.min(250, Number(q.dist_nm || 250));
      const url = `${API_BASE}/v3/lat/${encodeURIComponent(q.lat)}/lon/${encodeURIComponent(q.lon)}/dist/${encodeURIComponent(dist)}`;
      try {
        const data = await fetchJson(url);
        calls.push({ region:id, name:q.name, total:data?.total ?? data?.ac?.length ?? 0 });
        for (const ac of (Array.isArray(data?.ac) ? data.ac : [])){
          const item = normalizeAircraft(ac, { id, cfg:rcfg }, rules);
          if (!item) continue;
          const key = item.hex || `${item.callsign}:${item.lat.toFixed(3)}:${item.lon.toFixed(3)}`;
          const prev = items.get(key);
          if (!prev || Number(item.seen_pos ?? 999) < Number(prev.seen_pos ?? 999)) items.set(key, item);
        }
      } catch(e) { errors.push(`${q.name || id}: ${e.message}`); }
      await sleep(DELAY_MS);
    }
  }

  const arr = [...items.values()].sort((a,b)=>String(a.callsign || a.hex).localeCompare(String(b.callsign || b.hex)));
  const byRegion = {};
  for (const it of arr){
    const k = it.weirdness_bucket || "unknown";
    byRegion[k] ||= { total:0, authority_aircraft:0, mpa_possible:0, sar_or_coastguard_possible:0 };
    byRegion[k].total++;
    if (it.authority_like) byRegion[k].authority_aircraft++;
    if (it.flags.includes("mpa_possible")) byRegion[k].mpa_possible++;
    if (it.flags.includes("sar_or_coastguard_possible")) byRegion[k].sar_or_coastguard_possible++;
  }
  const out = {
    ok: errors.length === 0 || arr.length > 0,
    source: "adsb.fi",
    generated_at: nowIso(),
    api_base: API_BASE,
    regions: Object.keys(cfg.regions || {}),
    calls,
    item_count: arr.length,
    items: arr,
    summary: { total: arr.length, authority_aircraft: arr.filter(x=>x.authority_like).length, by_region: byRegion },
    attribution: "ADS-B data via adsb.fi open data API. Respect adsb.fi terms and rate limits.",
    errors: errors.slice(0, 10)
  };
  await writeJson(latestPath, out);
  await fs.appendFile(histPath, JSON.stringify({ generated_at: out.generated_at, item_count: out.item_count, summary: out.summary, calls: out.calls }) + "\n", "utf8");
  console.log(JSON.stringify({ ok: out.ok, item_count: out.item_count, summary: out.summary, errors: out.errors }, null, 2));
}
main().catch(async err => {
  const out = { ok:false, source:"adsb.fi", generated_at:nowIso(), error:String(err?.stack || err), items:[], summary:{ total:0, authority_aircraft:0 } };
  await writeJson(latestPath, out).catch(()=>{});
  console.error(err);
  process.exitCode = 1;
});
