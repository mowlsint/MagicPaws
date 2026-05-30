#!/usr/bin/env node
/**
 * MAGIC PAWS // ntfy threshold alerts
 * Sends ntfy notifications when:
 *   - Hybrid-Index > 75%
 *   - Government Weirdness North Sea > 60%
 *   - Government Weirdness Baltic Sea > 60%
 *
 * Designed for GitHub Actions. Uses only Node 18+ built-ins.
 * Required secrets/env:
 *   NTFY_ENABLED=true
 *   NTFY_URL=https://ntfy.sh/<topic>  OR self-hosted topic URL
 *   NTFY_TOKEN=<optional bearer token>
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, "data/live/magicpaws_threshold_alert_state.json");
const DEFAULTS = {
  hybrid: Number(process.env.MAGICPAWS_ALERT_HYBRID_THRESHOLD || 75),
  weird: Number(process.env.MAGICPAWS_ALERT_WEIRDNESS_THRESHOLD || 60),
  cooldownMinutes: Number(process.env.MAGICPAWS_ALERT_COOLDOWN_MINUTES || 180)
};

function readJsonMaybe(rel){
  const p = path.join(ROOT, rel);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}
function writeJson(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }
function asArr(x){ return Array.isArray(x) ? x : []; }
function labelsOf(e){ return asArr(e && e.labels).map(String); }
function getMs(e){
  const candidates = [e?.event_ts, e?.published_at, e?.ts, e?.timestamp, e?.date, e?.created_at, e?.updated_at];
  for (const c of candidates){
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}
function hasAny(e, wanted){
  const labels = labelsOf(e);
  return wanted.some(x => labels.includes(x));
}
function scoreEventForHybrid(e){
  const labels = labelsOf(e);
  const sev = String(e?.severity || "SEV:1");
  const conf = String(e?.confidence || "CONF:LOW");
  const sevW = sev === "SEV:4" ? 9 : sev === "SEV:3" ? 6 : sev === "SEV:2" ? 3 : 1;
  const confW = conf === "CONF:HIGH" ? 1.2 : conf === "CONF:MED" ? 1.0 : 0.8;
  let v = sevW * confW;
  if (e?.phase0?.suspect || labels.includes("P0:SUSPECT")) v *= 1.6;
  if (["OBJ:CABLE","OBJ:PIPELINE","OBJ:WINDFARM","OBJ:PORT","OBJ:VTS_WSV"].some(x => labels.includes(x))) v *= 1.25;
  if (["PAT:LOITERING","PAT:STS_SUSPECT","PAT:AIS_GAP","PAT:DARK_ACTIVITY","PAT:SURVEYING","PAT:ROUTE_DEVIATION","PAT:ROUTE_OBSERVED","PAT:GNSS_JAM","PAT:GNSS_SPOOF","RF:GNSS_JAM","RF:GNSS_SPOOF"].some(x => labels.includes(x))) v *= 1.20;
  if (["V:SHADOW_FLEET","V:RUS_RESEARCH","V:RUS_WARSHIP","V:RUS_AUXILIARY","V:SANCTIONS_EVASION"].some(x => labels.includes(x))) v *= 1.15;
  return v;
}
function buildHybridHourlyBuckets(events, bucketCount = 72){
  const now = Date.now();
  const bucketMs = 60 * 60 * 1000;
  const buckets = Array.from({length:bucketCount}, (_,i)=>({idx:i, score:0, count:0, pct:0}));
  const seen = new Set();
  for (const e of events){
    const ms = getMs(e);
    if (!ms) continue;
    const age = now - ms;
    if (age < 0 || age > bucketMs * bucketCount) continue;
    const key = e.url || e.id || e.number || `${e.title || ""}:${e.ts || ""}`;
    const seenKey = `${Math.floor(ms/bucketMs)}:${key}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    const b = bucketCount - 1 - Math.floor(age / bucketMs);
    if (b < 0 || b >= bucketCount) continue;
    buckets[b].score += scoreEventForHybrid(e);
    buckets[b].count += 1;
  }
  return buckets.map(b => ({...b, pct: clamp(Math.round((b.score / 28) * 100), 0, 100)}));
}
function scorePhaseZero(events, windowHours = 72){
  const buckets = buildHybridHourlyBuckets(events, 72);
  const recent = buckets.slice(-windowHours);
  const avg = recent.length ? recent.reduce((s,b)=>s+(b.pct||0),0)/recent.length : 0;
  return clamp(Math.round(avg), 0, 100);
}
function eventInRegion(e, region){
  const labels = labelsOf(e);
  const text = `${e?.title || ""} ${e?.summary || ""}`.toLowerCase();
  if (region === "north"){
    return labels.some(l => ["REG:NORTH_SEA","REG:GER_BIGHT","REG:CHANNEL","REG:SKAGERRAK"].includes(l)) || /north sea|nordsee|german bight|deutsche bucht|channel|skagerrak/.test(text);
  }
  return labels.some(l => ["REG:BALTIC_SEA","REG:BALTIC","REG:DANISH_STRAITS","REG:ORESUND","REG:GOTLAND_SEA","REG:GULF_OF_FINLAND"].includes(l)) || /baltic|ostsee|danish straits|øresund|oresund|gulf of finland|gotland/.test(text);
}
function scoreWeirdnessFromEvents(events, region){
  const now = Date.now();
  let points = 0;
  const seen = new Set();
  for (const e of events){
    const ms = getMs(e);
    if (!ms || (now - ms) / 36e5 > 24 || !eventInRegion(e, region)) continue;
    const key = e.url || e.id || e.number || e.title || JSON.stringify(e).slice(0,80);
    if (seen.has(key)) continue;
    seen.add(key);
    const labels = labelsOf(e);
    const text = `${e.title || ""} ${e.summary || ""} ${labels.join(" ")}`.toLowerCase();
    const ais = hasAny(e,["SRC:AIS","D:AIS_TRACK","PAT:AIS_GAP","PAT:DARK_ACTIVITY","PAT:LOITERING","PAT:ROUTE_DEVIATION","PAT:ROUTE_OBSERVED","PAT:STS_SUSPECT"]) || /ais gap|dark vessel|loitering|route deviation|ship-to-ship|\bsts\b|rendezvous/.test(text);
    const adsb = hasAny(e,["SRC:ADSB","D:AIR_ACTIVITY","V:MPA","V:SAR_UNIT","V:AUTH_COAST_GUARD","PAT:RACETRACK","PAT:LOW_ORBIT"]) || /ads-?b|mpa|p-8|p8 poseidon|sar aircraft|coast guard aircraft|helicopter|racetrack|orbit|isr/.test(text);
    const official = hasAny(e,["SRC:OFFICIAL","SRC:AUTHORITY","V:AUTH_COAST_GUARD"]) || /coast guard|police|navy|marine|behörde|bsh|wsv|official/.test(text);
    const ci = hasAny(e,["OBJ:PORT","OBJ:VTS_WSV","OBJ:CABLE","OBJ:PIPELINE","OBJ:WINDFARM","D:INFRA_CI"]);
    const rf = hasAny(e,["D:RF_SIGNAL","PAT:GNSS_JAM","PAT:GNSS_SPOOF"]) || labels.some(l => l.startsWith("RF:"));
    let w = 0;
    if (ais) w += 4.5;
    if (adsb) w += 4.0;
    if (official) w += 1.5;
    if (ci) w += 1.2;
    if (rf) w += 1.3;
    if (ais && adsb) w *= 1.8;
    else if ((ais || adsb) && (official || ci || rf)) w *= 1.35;
    points += w;
  }
  return clamp(Math.round((points / 95) * 100), 0, 100);
}
function findNumber(obj, paths){
  for (const p of paths){
    const parts = p.split('.');
    let cur = obj;
    for (const part of parts){ cur = cur?.[part]; }
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function latestSummaryValue(){
  const daily = readJsonMaybe("data/snapshots/magicpaws_daily_summary.json");
  const arr = Array.isArray(daily) ? daily : asArr(daily?.days || daily?.items || daily?.daily_summary);
  return arr.length ? arr[arr.length - 1] : null;
}
function loadEvents(){
  const active = readJsonMaybe("data/logs/magicpaws_events_20d.json");
  return asArr(active?.events || active?.items || active);
}
async function sendNtfy(title, message, priority = "high", tags = "warning"){
  if (String(process.env.NTFY_ENABLED || "").toLowerCase() !== "true") {
    console.log("NTFY_ENABLED is not true; would send:", title, message);
    return false;
  }
  const url = process.env.NTFY_URL;
  if (!url) throw new Error("NTFY_URL missing");
  const headers = { "Title": title, "Priority": priority, "Tags": tags };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  const res = await fetch(url, { method:"POST", headers, body: message });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${await res.text()}`);
  return true;
}
function shouldSend(state, key, now){
  const last = Date.parse(state.last_sent?.[key] || 0) || 0;
  return !last || (now - last) >= DEFAULTS.cooldownMinutes * 60 * 1000;
}
async function main(){
  const events = loadEvents();
  const sensor = readJsonMaybe("data/snapshots/magicpaws_sensor_latest.json") || {};
  const latest = latestSummaryValue() || {};
  const hybrid = findNumber(sensor, ["hybrid_index","hybrid_index_pct","hybridIndex","phase_zero_index","p0_pct","metrics.hybrid_index","metrics.phase_zero_index"]) ??
                 findNumber(latest, ["hybrid_index","hybrid_index_proxy","hybridIndex","phase_zero_index","p0_pct"]) ??
                 scorePhaseZero(events, 72);
  const weirdNorth = findNumber(sensor, ["government_weirdness.north_sea","government_weirdness.north","weirdness.north_sea","weirdness.north","government_weirdness_proxy.north_sea"]) ??
                     findNumber(latest, ["government_weirdness.north_sea","government_weirdness_proxy.north_sea","weirdness.north_sea","weirdness.north"]) ??
                     scoreWeirdnessFromEvents(events, "north");
  const weirdBaltic = findNumber(sensor, ["government_weirdness.baltic_sea","government_weirdness.baltic","weirdness.baltic_sea","weirdness.baltic","government_weirdness_proxy.baltic_sea"]) ??
                      findNumber(latest, ["government_weirdness.baltic_sea","government_weirdness_proxy.baltic_sea","weirdness.baltic_sea","weirdness.baltic"]) ??
                      scoreWeirdnessFromEvents(events, "baltic");

  const state = readJsonMaybe("data/live/magicpaws_threshold_alert_state.json") || { last_sent:{} };
  const now = Date.now();
  const generated_at = new Date(now).toISOString();
  const alerts = [];
  if (hybrid > DEFAULTS.hybrid && shouldSend(state, "hybrid", now)) alerts.push({ key:"hybrid", label:"Hybrid-Index", value:Math.round(hybrid), threshold:DEFAULTS.hybrid });
  if (weirdNorth > DEFAULTS.weird && shouldSend(state, "weird_north", now)) alerts.push({ key:"weird_north", label:"Government Weirdness Nordsee", value:Math.round(weirdNorth), threshold:DEFAULTS.weird });
  if (weirdBaltic > DEFAULTS.weird && shouldSend(state, "weird_baltic", now)) alerts.push({ key:"weird_baltic", label:"Government Weirdness Ostsee", value:Math.round(weirdBaltic), threshold:DEFAULTS.weird });

  for (const a of alerts){
    await sendNtfy(
      `MAGIC PAWS ${a.label}: ${a.value}%`,
      `${a.label} liegt bei ${a.value}% und damit über der Schwelle ${a.threshold}%.\nHybrid: ${Math.round(hybrid)}% | Weirdness Nordsee: ${Math.round(weirdNorth)}% | Weirdness Ostsee: ${Math.round(weirdBaltic)}%\nStand: ${generated_at}`,
      a.key === "hybrid" ? "urgent" : "high",
      "warning,magicpaws"
    );
    state.last_sent[a.key] = generated_at;
  }
  state.generated_at = generated_at;
  state.thresholds = DEFAULTS;
  state.last_values = { hybrid:Math.round(hybrid), government_weirdness_north:Math.round(weirdNorth), government_weirdness_baltic:Math.round(weirdBaltic) };
  state.alerts_sent = (Number(state.alerts_sent) || 0) + alerts.length;
  state.last_run_alert_count = alerts.length;

  // Avoid noisy scheduled commits every 30 minutes. Cooldown state is only
  // required when an alert was actually sent. Set MAGICPAWS_ALERT_WRITE_STATE_EVERY_RUN=true
  // if you want this file to be refreshed on every check for dashboard health display.
  if (alerts.length > 0 || String(process.env.MAGICPAWS_ALERT_WRITE_STATE_EVERY_RUN || "").toLowerCase() === "true") {
    writeJson(STATE_PATH, state);
  }
  console.log(JSON.stringify({ ok:true, generated_at, values:state.last_values, alerts:alerts.length }, null, 2));
}

main().catch(err => {
  console.error(err);
  writeJson(STATE_PATH, { ok:false, generated_at:new Date().toISOString(), error:String(err?.message || err) });
  process.exitCode = 1;
});
