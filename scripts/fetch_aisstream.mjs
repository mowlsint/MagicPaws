#!/usr/bin/env node
/**
 * MAGIC PAWS // AISstream collector + low-speed/drift detector
 *
 * Collects a short AISstream sample for North Sea/Channel and Baltic BBoxes,
 * writes:
 *   data/live/ais_latest.json
 *   data/live/ais_history.ndjson              (run summaries)
 *   data/live/ais_track_history.ndjson        (per-MMSI recent positions, TTL-limited)
 *   data/live/ais_drift_candidates.json       (active low-speed/drift candidates, TTL-limited)
 *
 * Required secret/env: AISSTREAM_API_KEY
 * Optional env:
 *   AIS_SAMPLE_SECONDS (default 120)
 *   AIS_MAX_MESSAGES (default 3000)
 *   AIS_TRACK_HISTORY_TTL_HOURS (default 24)
 *   AIS_DRIFT_EVAL_LOOKBACK_HOURS (default 6)
 *   AIS_DRIFT_ACTIVE_TTL_MINUTES (default 90)
 *   AIS_DRIFT_SOG_MAX (default 2.5)
 *   AIS_DRIFT_MIN_MINUTES (default 60)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import YAML from "yaml";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "config", "live_sensor_regions.yml");
const outDir = path.join(repoRoot, "data", "live");
const latestPath = path.join(outDir, "ais_latest.json");
const histPath = path.join(outDir, "ais_history.ndjson");
const trackHistPath = path.join(outDir, "ais_track_history.ndjson");
const driftPath = path.join(outDir, "ais_drift_candidates.json");

const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = process.env.AISSTREAM_API_KEY || process.env.AISSTREAM_KEY || "";
const SAMPLE_SECONDS = Math.max(30, Number(process.env.AIS_SAMPLE_SECONDS || 120));
const MAX_MESSAGES = Math.max(100, Number(process.env.AIS_MAX_MESSAGES || 3000));

const TRACK_HISTORY_TTL_HOURS = Math.max(2, Number(process.env.AIS_TRACK_HISTORY_TTL_HOURS || 24));
const DRIFT_EVAL_LOOKBACK_HOURS = Math.max(2, Number(process.env.AIS_DRIFT_EVAL_LOOKBACK_HOURS || 6));
const DRIFT_ACTIVE_TTL_MINUTES = Math.max(45, Number(process.env.AIS_DRIFT_ACTIVE_TTL_MINUTES || 90));
const DRIFT_SOG_MAX = Math.max(0.5, Number(process.env.AIS_DRIFT_SOG_MAX || 2.5));
const DRIFT_MIN_MINUTES = Math.max(30, Number(process.env.AIS_DRIFT_MIN_MINUTES || 60));

function nowIso(){ return new Date().toISOString(); }
function norm(s){ return String(s ?? "").trim(); }
function asNum(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function msOf(v){ const t = Date.parse(norm(v)); return Number.isFinite(t) ? t : 0; }
function addMinutes(iso, minutes){ return new Date(msOf(iso) + minutes * 60_000).toISOString(); }
function sha1Short(value, len = 12){ return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, len); }

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
function navStatusText(code){
  const map = {
    0:"under_way_using_engine", 1:"at_anchor", 2:"not_under_command",
    3:"restricted_maneuverability", 4:"constrained_by_draught", 5:"moored",
    6:"aground", 7:"engaged_in_fishing", 8:"under_way_sailing", 15:"not_defined"
  };
  const n = Number(code);
  return map[n] || (Number.isFinite(n) ? `status_${n}` : "unknown");
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
  const navStatus = asNum(body.NavigationalStatus ?? body.nav_status ?? meta.NavigationalStatus ?? meta.nav_status);
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
    nav_status: navStatus,
    nav_status_text: navStatusText(navStatus),
    ship_type: shipType,
    ts: norm(meta.time_utc ?? meta.TimeUTC ?? meta.timestamp) || nowIso(),
    raw_source: "aisstream"
  };
}
async function writeJson(pathname, data){
  await fs.mkdir(path.dirname(pathname), { recursive:true });
  await fs.writeFile(pathname, JSON.stringify(data, null, 2) + "\n", "utf8");
}
async function readJson(pathname, fallback){
  try { return JSON.parse(await fs.readFile(pathname, "utf8")); } catch { return fallback; }
}
async function readJsonl(pathname){
  try {
    const txt = await fs.readFile(pathname, "utf8");
    return txt.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}
async function writeJsonl(pathname, rows){
  await fs.mkdir(path.dirname(pathname), { recursive:true });
  await fs.writeFile(pathname, rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}
function nearestSafetyZone(point, zones){
  let best = null;
  for (const z of zones || []){
    const lat = Number(z.lat), lon = Number(z.lon), radius = Number(z.radius_nm ?? z.radius ?? 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius)) continue;
    const dist = haversineNm(point, { lat, lon });
    const margin = Number(z.safety_margin_nm ?? 0);
    const effective = radius + margin;
    if (dist <= effective && (!best || dist < best.distance_nm)) {
      best = { id: z.id || z.name || "zone", name: z.name || z.id || "zone", type: z.type || "safety_zone", distance_nm: Number(dist.toFixed(2)), radius_nm: radius, effective_radius_nm: effective };
    }
  }
  return best;
}
function trackStats(points){
  const sorted = points.slice().sort((a,b)=>msOf(a.ts) - msOf(b.ts));
  const first = sorted[0], last = sorted.at(-1);
  const durationMinutes = Math.round((msOf(last.ts) - msOf(first.ts)) / 60_000);
  const centroid = {
    lat: sorted.reduce((s,p)=>s + Number(p.lat), 0) / sorted.length,
    lon: sorted.reduce((s,p)=>s + Number(p.lon), 0) / sorted.length
  };
  let maxRadiusNm = 0;
  let trackDistanceNm = 0;
  for (let i = 0; i < sorted.length; i++){
    maxRadiusNm = Math.max(maxRadiusNm, haversineNm(sorted[i], centroid));
    if (i > 0) trackDistanceNm += haversineNm(sorted[i-1], sorted[i]);
  }
  const displacementNm = haversineNm(first, last);
  const sogVals = sorted.map(p => Number(p.sog)).filter(Number.isFinite);
  const avgSog = sogVals.length ? sogVals.reduce((a,b)=>a+b,0)/sogVals.length : null;
  const maxSog = sogVals.length ? Math.max(...sogVals) : null;
  const slowCount = sogVals.filter(v => v < DRIFT_SOG_MAX).length;
  const slowRatio = sogVals.length ? slowCount / sogVals.length : 0;
  const headingVals = sorted.map(p => Number(p.heading)).filter(Number.isFinite).filter(v => v < 511);
  const cogVals = sorted.map(p => Number(p.cog)).filter(Number.isFinite).filter(v => v < 360);
  return {
    first, last,
    points: sorted.length,
    duration_minutes: durationMinutes,
    centroid: { lat: Number(centroid.lat.toFixed(5)), lon: Number(centroid.lon.toFixed(5)) },
    max_radius_nm: Number(maxRadiusNm.toFixed(2)),
    track_distance_nm: Number(trackDistanceNm.toFixed(2)),
    displacement_nm: Number(displacementNm.toFixed(2)),
    avg_sog: avgSog === null ? null : Number(avgSog.toFixed(2)),
    max_sog: maxSog === null ? null : Number(maxSog.toFixed(2)),
    slow_ratio: Number(slowRatio.toFixed(2)),
    heading_sample_count: headingVals.length,
    cog_sample_count: cogVals.length
  };
}
function evaluateDriftCandidates(trackRows, regions, cfg, previousPack){
  const det = cfg.drift_detection || {};
  const zones = det.safety_zones || [];
  const maxRadiusNm = Number(det.max_radius_nm ?? 3.0);
  const minDisplacementNm = Number(det.min_displacement_nm ?? 0.25);
  const minTrackDistanceNm = Number(det.min_track_distance_nm ?? 0.45);
  const slowRatioMin = Number(det.slow_ratio_min ?? 0.75);
  const activeTtlMinutes = Number(det.active_ttl_minutes ?? DRIFT_ACTIVE_TTL_MINUTES);
  const excludedStatuses = new Set((det.exclude_nav_status || [1,5]).map(Number));
  const fishingStatuses = new Set((det.fishing_nav_status || [7]).map(Number));
  const fishingShipTypes = new Set((det.fishing_ship_type_codes || [30]).map(Number));

  const nowMs = Date.now();
  const evalCutoff = nowMs - DRIFT_EVAL_LOOKBACK_HOURS * 3600_000;
  const previousByMmsi = new Map((previousPack?.items || []).map(x => [String(x.mmsi || ""), x]).filter(([k]) => k));
  const groups = new Map();
  for (const r of trackRows){
    const mmsi = norm(r.mmsi);
    if (!mmsi) continue;
    const t = msOf(r.ts);
    if (!t || t < evalCutoff) continue;
    if (!Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lon))) continue;
    groups.set(mmsi, [...(groups.get(mmsi) || []), r]);
  }

  const items = [];
  const suppressed = { port_or_anchor:0, anchored_or_moored:0, fishing_likely:0, insufficient_track:0, too_fast:0, too_wide:0, anchor_drift_like:0 };

  for (const [mmsi, pts] of groups.entries()){
    const sorted = pts.slice().sort((a,b)=>msOf(a.ts)-msOf(b.ts));
    const last = sorted.at(-1);
    if ((nowMs - msOf(last.ts)) > activeTtlMinutes * 60_000) continue;

    // Focus on the most recent low-speed episode: keep recent points from last 120 minutes first.
    const episodeCutoff = msOf(last.ts) - Math.max(DRIFT_MIN_MINUTES + 30, 120) * 60_000;
    const episode = sorted.filter(p => msOf(p.ts) >= episodeCutoff);
    if (episode.length < 2) { suppressed.insufficient_track++; continue; }
    const st = trackStats(episode);
    if (st.duration_minutes < DRIFT_MIN_MINUTES) { suppressed.insufficient_track++; continue; }
    if ((st.max_sog ?? 99) >= DRIFT_SOG_MAX || st.slow_ratio < slowRatioMin) { suppressed.too_fast++; continue; }

    const latest = st.last;
    const nav = Number(latest.nav_status);
    const navText = latest.nav_status_text || navStatusText(nav);
    const zone = nearestSafetyZone(latest, zones);
    const inPortOrAnchorage = Boolean(zone);
    const excludedByNav = excludedStatuses.has(nav); // at anchor / moored only; aground is intentionally NOT excluded
    const fishingLikely = fishingStatuses.has(nav) || fishingShipTypes.has(Number(latest.ship_type));

    if (excludedByNav) { suppressed.anchored_or_moored++; continue; }
    if (inPortOrAnchorage) { suppressed.port_or_anchor++; continue; }
    if (fishingLikely) { suppressed.fishing_likely++; continue; }
    if (st.max_radius_nm > maxRadiusNm) { suppressed.too_wide++; continue; }

    const movedMoreThanAnchorDrift = st.displacement_nm >= minDisplacementNm || st.track_distance_nm >= minTrackDistanceNm;
    const isAground = nav === 6;
    if (!movedMoreThanAnchorDrift && !isAground) { suppressed.anchor_drift_like++; continue; }

    const region = regionFor(Number(latest.lat), Number(latest.lon), regions);
    const prev = previousByMmsi.get(mmsi);
    const firstSeen = prev?.first_seen && msOf(prev.first_seen) ? prev.first_seen : st.first.ts;
    const episodeKey = `${mmsi}:${region.weirdness_bucket}:${Math.round(Number(latest.lat)*10)/10}:${Math.round(Number(latest.lon)*10)/10}:${firstSeen.slice(0,13)}`;
    const episodeId = prev?.episode_id || `drift-${sha1Short(episodeKey, 14)}`;

    const type = isAground ? "AGROUND_INCIDENT" : "DRIFT_CANDIDATE";
    const confidence = isAground ? "high" : (st.duration_minutes >= 120 ? "medium" : "low");
    const relevance = clamp(
      35 +
      (st.duration_minutes >= 120 ? 15 : 0) +
      (st.avg_sog !== null && st.avg_sog < 1.0 ? 10 : 0) +
      (st.track_distance_nm >= 1.0 ? 10 : 0) +
      (isAground ? 35 : 0),
      0, 100
    );

    const reasons = [
      `SOG unter ${DRIFT_SOG_MAX} kn über mindestens ${DRIFT_MIN_MINUTES} Minuten`,
      `Radius ${st.max_radius_nm} sm innerhalb Schwelle ${maxRadiusNm} sm`,
      `Ortsveränderung ${st.displacement_nm} sm / Track ${st.track_distance_nm} sm über Ankerdrift-Schwelle`,
      `Navigational Status nicht moored/at anchor (${navText})`
    ];
    if (isAground) reasons.push("Navigational Status aground: als möglicher Incident ausdrücklich beibehalten");

    items.push({
      type,
      episode_id: episodeId,
      mmsi,
      name: latest.name || prev?.name || "",
      callsign: latest.callsign || "",
      ship_type: latest.ship_type ?? null,
      nav_status: Number.isFinite(nav) ? nav : null,
      nav_status_text: navText,
      region_id: region.id,
      weirdness_bucket: region.weirdness_bucket,
      region_label_de: region.label_de,
      lat: Number(Number(latest.lat).toFixed(5)),
      lon: Number(Number(latest.lon).toFixed(5)),
      first_seen: firstSeen,
      last_seen: latest.ts,
      active_until: addMinutes(latest.ts, activeTtlMinutes),
      expires_at: addMinutes(latest.ts, activeTtlMinutes),
      duration_minutes: st.duration_minutes,
      sample_points: st.points,
      avg_sog: st.avg_sog,
      max_sog: st.max_sog,
      max_radius_nm: st.max_radius_nm,
      displacement_nm: st.displacement_nm,
      track_distance_nm: st.track_distance_nm,
      confidence,
      relevance,
      alert_recommendation: relevance >= 75 || isAground ? "HIGH_IF_COUPLED" : "DASHBOARD_ONLY",
      ttl_minutes: activeTtlMinutes,
      reason: reasons,
      nearest_safety_zone: zone || null,
      last_alerted_at: prev?.last_alerted_at || null,
      alert_cooldown_until: prev?.alert_cooldown_until || null
    });
  }

  items.sort((a,b)=> (b.relevance-a.relevance) || (msOf(b.last_seen)-msOf(a.last_seen)));
  const active = items.filter(x => msOf(x.active_until) > nowMs);
  const byRegion = {};
  for (const it of active){
    const k = it.weirdness_bucket || "unknown";
    byRegion[k] ||= { total:0, drift_candidates:0, aground:0 };
    byRegion[k].total++;
    if (it.type === "DRIFT_CANDIDATE") byRegion[k].drift_candidates++;
    if (it.type === "AGROUND_INCIDENT") byRegion[k].aground++;
  }
  return { items: active.slice(0,100), suppressed, byRegion };
}

async function main(){
  const cfg = YAML.parse(await fs.readFile(configPath, "utf8"));
  const regions = cfg.regions || {};
  const bboxes = Object.values(regions).map(r => r.bbox).filter(Boolean);
  const rules = cfg.authority_detection || {};

  if (!API_KEY) {
    const out = { ok:false, source:"aisstream", generated_at:nowIso(), error:"missing AISSTREAM_API_KEY", regions:Object.keys(regions), items:[], clusters_5nm:[], summary:{ authority_vessels:0, total:0 } };
    await writeJson(latestPath, out);
    await writeJson(driftPath, { ok:false, source:"aisstream", generated_at:out.generated_at, error:"missing AISSTREAM_API_KEY", items:[], summary:{ total:0 } });
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
        if (item.ship_type === 30 || item.nav_status === 7) item.flags.push("fishing_likely");
        if (item.nav_status === 6) item.flags.push("aground");
        const key = item.mmsi || `${item.lat.toFixed(4)},${item.lon.toFixed(4)},${item.name}`;
        seen.set(key, item);
      } catch(e) { errors.push(e.message); }
    });
    ws.on("error", (e) => { errors.push(e.message || String(e)); });
    ws.on("close", () => { clearTimeout(timer); resolve(); });
  });

  const collectedAt = nowIso();
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
    generated_at: collectedAt,
    window_seconds: Math.round((Date.now() - started) / 1000),
    sample_seconds_requested: SAMPLE_SECONDS,
    regions: Object.keys(regions),
    item_count: items.length,
    items,
    clusters_5nm: clusters,
    summary: { total: items.length, authority_vessels: items.filter(x=>x.authority_like).length, by_region: byRegion },
    errors: errors.slice(0, 10)
  };

  // Write latest + summary history.
  await writeJson(latestPath, out);
  await fs.appendFile(histPath, JSON.stringify({ generated_at: out.generated_at, item_count: out.item_count, summary: out.summary, clusters_5nm: out.clusters_5nm.slice(0,5) }) + "\n", "utf8");

  // Maintain compact per-MMSI track history with TTL, then evaluate slow/drift candidates.
  const oldTrack = await readJsonl(trackHistPath);
  const cutoff = Date.now() - TRACK_HISTORY_TTL_HOURS * 3600_000;
  const keep = oldTrack.filter(r => msOf(r.ts) >= cutoff);
  const currentTrack = items
    .filter(it => it.mmsi && Number.isFinite(it.lat) && Number.isFinite(it.lon))
    .map(it => ({
      collected_at: collectedAt,
      ts: it.ts || collectedAt,
      mmsi: it.mmsi,
      name: it.name || "",
      callsign: it.callsign || "",
      lat: it.lat,
      lon: it.lon,
      sog: it.sog,
      cog: it.cog,
      heading: it.heading,
      nav_status: it.nav_status,
      nav_status_text: it.nav_status_text,
      ship_type: it.ship_type,
      region_id: it.region_id,
      weirdness_bucket: it.weirdness_bucket,
      region_label_de: it.region_label_de
    }));
  const trackRows = keep.concat(currentTrack).sort((a,b)=>msOf(a.ts)-msOf(b.ts));
  await writeJsonl(trackHistPath, trackRows);

  const previousDrift = await readJson(driftPath, { items:[] });
  const drift = evaluateDriftCandidates(trackRows, regions, cfg, previousDrift);
  const driftOut = {
    ok: true,
    source: "aisstream",
    generated_at: collectedAt,
    description: "Low-speed/drift candidates from AISstream history. Excludes at anchor/moored and configured port/anchorage safety zones; aground remains included as possible incident.",
    criteria: {
      sog_below_kn: DRIFT_SOG_MAX,
      min_duration_minutes: DRIFT_MIN_MINUTES,
      eval_lookback_hours: DRIFT_EVAL_LOOKBACK_HOURS,
      track_history_ttl_hours: TRACK_HISTORY_TTL_HOURS,
      active_ttl_minutes: DRIFT_ACTIVE_TTL_MINUTES,
      excluded_nav_status: ["at_anchor", "moored"],
      aground_policy: "kept_as_possible_incident"
    },
    item_count: drift.items.length,
    items: drift.items,
    summary: { total: drift.items.length, by_region: drift.byRegion, suppressed: drift.suppressed }
  };
  await writeJson(driftPath, driftOut);

  console.log(JSON.stringify({ ok: out.ok, item_count: out.item_count, drift_candidates: drift.items.length, summary: out.summary, drift_summary: driftOut.summary, errors: out.errors }, null, 2));
}
main().catch(async err => {
  const out = { ok:false, source:"aisstream", generated_at:nowIso(), error:String(err?.stack || err), items:[], clusters_5nm:[], summary:{ total:0, authority_vessels:0 } };
  await writeJson(latestPath, out).catch(()=>{});
  await writeJson(driftPath, { ok:false, source:"aisstream", generated_at:out.generated_at, error:out.error, items:[], summary:{ total:0 } }).catch(()=>{});
  console.error(err);
  process.exitCode = 1;
});
