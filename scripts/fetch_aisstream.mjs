#!/usr/bin/env node
/**
 * MAGIC PAWS // AISstream collector + low-speed/drift detector + vessel length filter
 *
 * Collects a short AISstream sample for North Sea/Channel and Baltic BBoxes,
 * writes:
 *   data/live/ais_latest.json
 *   data/live/ais_history.ndjson              (run summaries)
 *   data/live/ais_track_history.ndjson        (per-MMSI recent positions, TTL-limited)
 *   data/live/ais_drift_candidates.json       (active low-speed/drift candidates, TTL-limited)
 *   data/live/ais_vessel_static_cache.json     (MMSI -> length/width/name/type cache, TTL-limited)
 *   data/live/ais_drift_alert_state.json       (dedupe/cooldown state for drift ntfy pushes)
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
 *   AIS_DRIFT_DISPLAY_MIN_LENGTH_M (default from config: 34)
 *   AIS_DRIFT_NOTIFY_MIN_LENGTH_M (default from config: 40)
 *   NTFY_ENABLED / NTFY_URL / NTFY_TOKEN for optional drift push alerts
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
const staticCachePath = path.join(outDir, "ais_vessel_static_cache.json");
const driftAlertStatePath = path.join(outDir, "ais_drift_alert_state.json");

const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const API_KEY = process.env.AISSTREAM_API_KEY || process.env.AISSTREAM_KEY || "";
const SAMPLE_SECONDS = Math.max(30, Number(process.env.AIS_SAMPLE_SECONDS || 120));
const MAX_MESSAGES = Math.max(100, Number(process.env.AIS_MAX_MESSAGES || 3000));

const TRACK_HISTORY_TTL_HOURS = Math.max(2, Number(process.env.AIS_TRACK_HISTORY_TTL_HOURS || 24));
const DRIFT_EVAL_LOOKBACK_HOURS = Math.max(0.5, Number(process.env.AIS_DRIFT_EVAL_LOOKBACK_HOURS || 6));
const DRIFT_ACTIVE_TTL_MINUTES = Math.max(45, Number(process.env.AIS_DRIFT_ACTIVE_TTL_MINUTES || 90));
const DRIFT_SOG_MAX = Math.max(0.5, Number(process.env.AIS_DRIFT_SOG_MAX || 2.5));
const DRIFT_MIN_MINUTES = Math.max(30, Number(process.env.AIS_DRIFT_MIN_MINUTES || 60));

const NTFY_ENABLED = String(process.env.NTFY_ENABLED || "").toLowerCase() === "true";
const NTFY_URL = process.env.NTFY_URL || "";
const NTFY_TOKEN = process.env.NTFY_TOKEN || "";
const NTFY_MIN_LEVEL = String(process.env.NTFY_MIN_LEVEL || "HIGH").toUpperCase();
const DASHBOARD_URL = process.env.MAGICPAWS_DASHBOARD_URL || "https://mowlsint.github.io/MagicPaws/";

function nowIso(){ return new Date().toISOString(); }
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
  const nameRe = safeRegExp(rules.ais_name_regex, "coast guard|police|customs|navy|patrol|sar|rescue", "i");
  const typeSet = new Set((rules.ais_ship_type_codes || []).map(Number));
  const text = [item.name, item.callsign, item.destination, item.type_text].map(norm).join(" ");
  return nameRe.test(text) || typeSet.has(Number(item.ship_type));
}

function firstFinite(...values){
  for (const v of values){
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function nested(obj, paths){
  for (const path of paths){
    let cur = obj;
    let ok = true;
    for (const part of path.split(".")){
      if (cur && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return null;
}
function shipTypeClass(code){
  const n = Number(code);
  if (!Number.isFinite(n)) return "unknown";
  if (n === 30) return "fishing";
  if (n === 35) return "military";
  if (n === 50) return "pilot";
  if (n === 51) return "sar";
  if (n === 52) return "tug";
  if (n === 53) return "port_tender";
  if (n === 54) return "anti_pollution";
  if (n === 55) return "law_enforcement";
  if (n >= 60 && n <= 69) return "passenger";
  if (n >= 70 && n <= 79) return "cargo";
  if (n >= 80 && n <= 89) return "tanker";
  if (n >= 90 && n <= 99) return "other_special";
  return "other";
}
function lengthOverrideByType(shipType, navStatus, det){
  const cls = shipTypeClass(shipType);
  const always = new Set(det.always_include_ship_classes || ["cargo", "tanker", "passenger", "military", "law_enforcement", "sar"]);
  if (Number(navStatus) === 6) return true; // aground remains incident-relevant even without length
  return always.has(cls);
}
function calculateDimensions(body = {}, meta = {}){
  const directLength = firstFinite(
    nested(body, ["Length", "length", "Dimension.Length", "Dimensions.Length", "Dimensions.length", "ShipLength", "ship_length"]),
    nested(meta, ["Length", "length", "ShipLength", "ship_length"])
  );
  const directWidth = firstFinite(
    nested(body, ["Width", "width", "Dimension.Width", "Dimensions.Width", "Dimensions.width", "ShipWidth", "ship_width"]),
    nested(meta, ["Width", "width", "ShipWidth", "ship_width"])
  );
  if (directLength || directWidth) {
    return {
      length_m: directLength && directLength > 0 ? Math.round(directLength) : null,
      width_m: directWidth && directWidth > 0 ? Math.round(directWidth) : null,
      source: "direct_length_width"
    };
  }
  const a = firstFinite(nested(body, ["Dimension.A", "Dimensions.A", "Dimension.ToBow", "Dimensions.ToBow", "ToBow", "to_bow", "A"]));
  const b = firstFinite(nested(body, ["Dimension.B", "Dimensions.B", "Dimension.ToStern", "Dimensions.ToStern", "ToStern", "to_stern", "B"]));
  const c = firstFinite(nested(body, ["Dimension.C", "Dimensions.C", "Dimension.ToPort", "Dimensions.ToPort", "ToPort", "to_port", "C"]));
  const d = firstFinite(nested(body, ["Dimension.D", "Dimensions.D", "Dimension.ToStarboard", "Dimensions.ToStarboard", "ToStarboard", "to_starboard", "D"]));
  const length = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  const width = (Number.isFinite(c) ? c : 0) + (Number.isFinite(d) ? d : 0);
  return {
    length_m: length > 0 ? Math.round(length) : null,
    width_m: width > 0 ? Math.round(width) : null,
    source: length > 0 || width > 0 ? "ais_dimensions_abcd" : "unknown"
  };
}
function extractStaticData(msg){
  const type = msg?.MessageType || msg?.message_type || "";
  const meta = msg?.MetaData || msg?.Metadata || msg?.metadata || {};
  const body = msg?.Message?.[type] || msg?.Message?.ShipStaticData || msg?.Message?.StaticDataReport || msg?.Message?.ShipStaticDataReport || {};
  const mmsi = norm(meta.MMSI ?? body.UserID ?? body.user_id ?? body.MMSI ?? body.mmsi);
  if (!mmsi) return null;
  const dim = calculateDimensions(body, meta);
  const shipType = firstFinite(
    body.ShipType, body.Type, body.ship_type, meta.ShipType, meta.ship_type,
    nested(body, ["ReportB.ShipType", "PartB.ShipType"])
  );
  const name = norm(meta.ShipName ?? meta.ship_name ?? body.Name ?? body.ShipName ?? body.name ?? body.VesselName ?? nested(body, ["ReportA.Name", "PartA.Name"]));
  const callsign = norm(meta.CallSign ?? body.CallSign ?? body.Callsign ?? body.callsign ?? nested(body, ["ReportB.CallSign", "PartB.CallSign"]));
  const destination = norm(body.Destination ?? body.destination ?? meta.Destination);
  const imo = norm(body.ImoNumber ?? body.IMO ?? body.imo ?? meta.IMO);
  if (!name && !callsign && !shipType && !dim.length_m && !dim.width_m && !destination && !imo) return null;
  return {
    mmsi,
    name,
    callsign,
    destination,
    imo,
    ship_type: shipType ?? null,
    ship_type_class: shipTypeClass(shipType),
    length_m: dim.length_m,
    width_m: dim.width_m,
    length_source: dim.source,
    last_static_seen: norm(meta.time_utc ?? meta.TimeUTC ?? meta.timestamp) || nowIso(),
    source: "aisstream_ship_static_data"
  };
}
function mergeStatic(existing = {}, incoming = {}){
  const out = { ...existing };
  for (const [k,v] of Object.entries(incoming)){
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  out.last_static_seen = incoming.last_static_seen || existing.last_static_seen || nowIso();
  return out;
}
function enrichWithStatic(item, cache){
  const st = cache?.vessels?.[String(item.mmsi || "")];
  if (!st) return item;
  return {
    ...item,
    name: item.name || st.name || "",
    callsign: item.callsign || st.callsign || "",
    destination: item.destination || st.destination || "",
    ship_type: item.ship_type ?? st.ship_type ?? null,
    ship_type_class: shipTypeClass(item.ship_type ?? st.ship_type),
    length_m: st.length_m ?? item.length_m ?? null,
    width_m: st.width_m ?? item.width_m ?? null,
    length_source: st.length_source || item.length_source || null,
    static_last_seen: st.last_static_seen || null,
    imo: st.imo || item.imo || ""
  };
}
async function pruneStaticCache(cache, ttlDays){
  const vessels = cache?.vessels && typeof cache.vessels === "object" ? cache.vessels : {};
  const cutoff = Date.now() - Math.max(1, Number(ttlDays || 14)) * 86400_000;
  const pruned = {};
  for (const [mmsi, row] of Object.entries(vessels)){
    const t = msOf(row.last_static_seen);
    if (t && t >= cutoff) pruned[mmsi] = row;
  }
  return { version: 1, generated_at: nowIso(), ttl_days: ttlDays, vessels: pruned };
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
  const displayMinLengthM = Number(process.env.AIS_DRIFT_DISPLAY_MIN_LENGTH_M || det.display_min_length_m || 34);
  const notifyMinLengthM = Number(process.env.AIS_DRIFT_NOTIFY_MIN_LENGTH_M || det.notify_min_length_m || 40);
  const unknownLengthNotify = Boolean(det.unknown_length_notify);
  const unknownLengthDisplayOverride = Boolean(det.unknown_length_display_override);
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
  const suppressed = { port_or_anchor:0, anchored_or_moored:0, fishing_likely:0, insufficient_track:0, too_fast:0, too_wide:0, anchor_drift_like:0, too_short_or_unknown_length:0 };

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

    const lengthM = firstFinite(latest.length_m, previousByMmsi.get(mmsi)?.length_m);
    const widthM = firstFinite(latest.width_m, previousByMmsi.get(mmsi)?.width_m);
    const typeClass = shipTypeClass(latest.ship_type);
    const overrideByType = lengthOverrideByType(latest.ship_type, nav, det);
    const lengthKnown = Number.isFinite(lengthM);
    const displayEligible = isAground || (lengthKnown && lengthM >= displayMinLengthM) || (!lengthKnown && overrideByType && unknownLengthDisplayOverride);
    const notifyEligible = isAground || (lengthKnown && lengthM >= notifyMinLengthM) || (!lengthKnown && overrideByType && unknownLengthNotify);
    if (!displayEligible) { suppressed.too_short_or_unknown_length++; continue; }

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
      `Navigational Status nicht moored/at anchor (${navText})`,
      lengthKnown ? `Schiffslänge ${lengthM} m erfüllt Anzeige-Schwelle ${displayMinLengthM} m` : `Schiffslänge unbekannt, Anzeige nur wegen Override/Incident`
    ];
    if (isAground) reasons.push("Navigational Status aground: als möglicher Incident ausdrücklich beibehalten");

    items.push({
      type,
      episode_id: episodeId,
      mmsi,
      name: latest.name || prev?.name || "",
      callsign: latest.callsign || "",
      ship_type: latest.ship_type ?? null,
      ship_type_class: typeClass,
      length_m: lengthKnown ? lengthM : null,
      width_m: widthM ?? null,
      length_source: latest.length_source || prev?.length_source || null,
      display_eligible: displayEligible,
      notify_eligible: notifyEligible,
      length_filter: { display_min_length_m: displayMinLengthM, notify_min_length_m: notifyMinLengthM, length_known: lengthKnown, override_by_type: overrideByType },
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
      alert_recommendation: notifyEligible ? (isAground ? "HIGH" : "HIGH") : "DASHBOARD_ONLY",
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


function alertLevelAllowed(level){
  const order = { WATCH: 1, HIGH: 2, CRITICAL: 3 };
  return (order[String(level || "").toUpperCase()] || 0) >= (order[NTFY_MIN_LEVEL] || 2);
}
async function sendNtfyDriftAlert(item){
  if (!NTFY_ENABLED || !NTFY_URL || !alertLevelAllowed("HIGH")) return { sent:false, reason:"ntfy_disabled" };
  const title = item.type === "AGROUND_INCIDENT" ? "MAGIC PAWS AIS: AGROUND" : "MAGIC PAWS AIS: Drift/Low-Speed";
  const priority = item.type === "AGROUND_INCIDENT" ? "5" : "4";
  const body = [
    `${item.name || item.mmsi || "unknown vessel"}`,
    `MMSI: ${item.mmsi || "unknown"}`,
    `Region: ${item.region_label_de || item.region_id || item.weirdness_bucket || "unknown"}`,
    `Länge: ${item.length_m ?? "unbekannt"} m`,
    `Dauer: ${item.duration_minutes ?? "–"} min unter ${DRIFT_SOG_MAX} kn`,
    `Ø SOG: ${item.avg_sog ?? "–"} kn | Radius: ${item.max_radius_nm ?? "–"} sm`,
    `Status: ${item.nav_status_text || item.nav_status || "unknown"}`,
    DASHBOARD_URL
  ].join("\n");
  const headers = {
    "Title": title,
    "Priority": priority,
    "Tags": item.type === "AGROUND_INCIDENT" ? "warning,ship" : "ship,warning",
    "Click": DASHBOARD_URL,
    "Content-Type": "text/plain; charset=utf-8"
  };
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
  try {
    const res = await fetch(NTFY_URL, { method:"POST", headers, body });
    if (!res.ok) return { sent:false, reason:`http_${res.status}`, text: await res.text().catch(()=>"") };
    return { sent:true };
  } catch (e) {
    return { sent:false, reason:e?.message || String(e) };
  }
}
async function updateDriftAlerts(items, cfg, collectedAt){
  const det = cfg.drift_detection || {};
  const cooldownHours = Math.max(1, Number(det.alert_cooldown_hours || process.env.AIS_DRIFT_ALERT_COOLDOWN_HOURS || 6));
  const stateTtlHours = Math.max(12, Number(det.alert_state_ttl_hours || 48));
  const state = await readJson(driftAlertStatePath, { version:1, alerts:{} });
  const alerts = state.alerts && typeof state.alerts === "object" ? state.alerts : {};
  const now = Date.now();
  const pruneBefore = now - stateTtlHours * 3600_000;
  for (const [k,v] of Object.entries(alerts)){
    if (msOf(v.last_alerted_at || v.cooldown_until) < pruneBefore) delete alerts[k];
  }
  const results = [];
  for (const it of items){
    const key = `${it.mmsi || it.episode_id}:${it.weirdness_bucket || it.region_id || "unknown"}`;
    const old = alerts[key] || {};
    it.last_alerted_at = old.last_alerted_at || it.last_alerted_at || null;
    it.alert_cooldown_until = old.cooldown_until || it.alert_cooldown_until || null;
    const cooldownActive = it.alert_cooldown_until && msOf(it.alert_cooldown_until) > now;
    if (!it.notify_eligible || cooldownActive) continue;
    const res = await sendNtfyDriftAlert(it);
    results.push({ key, mmsi:it.mmsi, sent:res.sent, reason:res.reason || null });
    if (res.sent) {
      const until = new Date(now + cooldownHours * 3600_000).toISOString();
      it.last_alerted_at = collectedAt;
      it.alert_cooldown_until = until;
      alerts[key] = { last_alerted_at: collectedAt, cooldown_until: until, episode_id: it.episode_id, mmsi: it.mmsi, title: it.name || it.mmsi || "AIS drift candidate" };
    }
  }
  await writeJson(driftAlertStatePath, { version:1, generated_at:collectedAt, cooldown_hours:cooldownHours, alerts });
  return results;
}

async function main(){
  const cfg = YAML.parse(await fs.readFile(configPath, "utf8"));
  const regions = cfg.regions || {};
  const bboxes = Object.values(regions).map(r => r.bbox).filter(Boolean);
  const rules = cfg.authority_detection || {};
  const det = cfg.drift_detection || {};
  let staticCache = await readJson(staticCachePath, { version:1, vessels:{} });
  staticCache = await pruneStaticCache(staticCache, det.static_cache_ttl_days || 14);

  if (!API_KEY) {
    const out = { ok:false, source:"aisstream", generated_at:nowIso(), error:"missing AISSTREAM_API_KEY", regions:Object.keys(regions), items:[], clusters_5nm:[], summary:{ authority_vessels:0, total:0 } };
    await writeJson(latestPath, out);
    await writeJson(driftPath, { ok:false, source:"aisstream", generated_at:out.generated_at, error:"missing AISSTREAM_API_KEY", items:[], summary:{ total:0 } });
    await writeJson(staticCachePath, staticCache);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const seen = new Map();
  const errors = [];
  const started = Date.now();

  let rawMessageCount = 0;
  const connectionRuns = [];

  const handleAisMessage = (buf) => {
    rawMessageCount++;
    try {
      const msg = JSON.parse(buf.toString());
      if (msg?.error) { errors.push(String(msg.error)); return; }
      const stat = extractStaticData(msg);
      if (stat?.mmsi) {
        staticCache.vessels ||= {};
        staticCache.vessels[stat.mmsi] = mergeStatic(staticCache.vessels[stat.mmsi], stat);
      }
      let item = extractPosition(msg);
      if (!item) return;
      item = enrichWithStatic(item, staticCache);
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
  };

  const listenAisstream = (attempt) => new Promise((resolve) => {
    const ws = new WebSocket(AIS_URL);
    const attemptStarted = Date.now();
    let done = false;
    let localMessages = 0;

    const finish = (reason, extra = {}) => {
      if (done) return;
      done = true;
      const windowSeconds = Math.round((Date.now() - attemptStarted) / 1000);
      connectionRuns.push({
        attempt: attempt.name,
        key_field: attempt.keyField,
        reason,
        window_seconds: windowSeconds,
        raw_messages: localMessages,
        ...extra
      });
      try { ws.close(); } catch {}
      clearTimeout(timer);
      resolve({ reason, windowSeconds, rawMessages: localMessages, ...extra });
    };

    const timer = setTimeout(() => finish("timer"), SAMPLE_SECONDS * 1000);

    ws.on("open", () => {
      const sub = {
        [attempt.keyField]: API_KEY,
        BoundingBoxes: bboxes,
        FilterMessageTypes: attempt.messageTypes
      };
      ws.send(JSON.stringify(sub));
    });

    ws.on("message", (buf) => {
      localMessages++;
      if (rawMessageCount >= MAX_MESSAGES) return finish("max_messages");
      handleAisMessage(buf);
    });

    ws.on("error", (e) => {
      const msg = e?.message || String(e);
      errors.push(`${attempt.name}: websocket error: ${msg}`);
      finish("error", { error: msg });
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : "";
      finish("close", { close_code: code, close_reason: reason });
    });
  });

  // Try a conservative official subscription first. If AISstream closes immediately without messages,
  // retry once with the alternate API-key casing shown in AISstream's JavaScript example.
  const commonTypes = ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"];
  const safeTypes = ["PositionReport", "ShipStaticData", "StaticDataReport"];
  const attempts = [
    { name:"api_key_common_types", keyField:"APIKey", messageTypes:commonTypes },
    { name:"apikey_common_types", keyField:"Apikey", messageTypes:commonTypes },
    { name:"api_key_safe_types", keyField:"APIKey", messageTypes:safeTypes }
  ];

  for (const attempt of attempts) {
    const before = rawMessageCount;
    const result = await listenAisstream(attempt);
    const gotMessages = rawMessageCount > before;
    const stayedOpenEnough = result.windowSeconds >= Math.min(20, SAMPLE_SECONDS);
    if (gotMessages || stayedOpenEnough || result.reason === "timer" || result.reason === "max_messages") break;
    errors.push(`${attempt.name}: early close after ${result.windowSeconds}s with 0 messages${result.close_code ? ` (close ${result.close_code})` : ""}${result.close_reason ? `: ${result.close_reason}` : ""}`);
  }

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
    ok: (errors.length === 0 && rawMessageCount > 0) || items.length > 0,
    source: "aisstream",
    generated_at: collectedAt,
    window_seconds: Math.round((Date.now() - started) / 1000),
    sample_seconds_requested: SAMPLE_SECONDS,
    raw_message_count: rawMessageCount,
    connection_runs: connectionRuns,
    regions: Object.keys(regions),
    item_count: items.length,
    items,
    clusters_5nm: clusters,
    summary: { total: items.length, authority_vessels: items.filter(x=>x.authority_like).length, by_region: byRegion },
    errors: errors.slice(0, 10)
  };

  // Write latest + summary history.
  staticCache.generated_at = collectedAt;
  await writeJson(staticCachePath, staticCache);
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
      ship_type_class: it.ship_type_class || shipTypeClass(it.ship_type),
      length_m: it.length_m ?? null,
      width_m: it.width_m ?? null,
      length_source: it.length_source || null,
      static_last_seen: it.static_last_seen || null,
      region_id: it.region_id,
      weirdness_bucket: it.weirdness_bucket,
      region_label_de: it.region_label_de
    }));
  const trackRows = keep.concat(currentTrack).sort((a,b)=>msOf(a.ts)-msOf(b.ts));
  await writeJsonl(trackHistPath, trackRows);

  const previousDrift = await readJson(driftPath, { items:[] });
  const drift = evaluateDriftCandidates(trackRows, regions, cfg, previousDrift);
  const alertResults = await updateDriftAlerts(drift.items, cfg, collectedAt);
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
    summary: { total: drift.items.length, by_region: drift.byRegion, suppressed: drift.suppressed, alert_results: alertResults }
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
