import fs from "fs";
import path from "path";
import YAML from "yaml";

const SNAPSHOT_PATH = "data/snapshots/voodoo_sensor_snapshots.ndjson";
const LATEST_PATH = "data/snapshots/voodoo_sensor_latest.json";
const KEYWORD_CFG_PATH = "config/keyword_barometer.yml";
const AIS_LIVE_PATH = "data/live/ais_latest.json";

const DEFAULT_OWNER = "mowlsint";
const DEFAULT_REPO = "Voodoo_Dashboard";
const SNAPSHOT_KEEP_DAYS = Number(process.env.SNAPSHOT_KEEP_DAYS || 100);
const ISSUE_PAGES = Number(process.env.SNAPSHOT_ISSUE_PAGES || 10);
const BUCKET_HOURS = Number(process.env.SNAPSHOT_BUCKET_HOURS || 3);

// Source caps reduce creator/feed volume bias during the cold-start phase.
// Raw events are still kept in the snapshot diagnostics; only score inputs are weighted.
const SOURCE_CAP_PROFILE = {
  social: [1.0, 0.45, 0.2, 0.08],
  rss: [1.0, 0.65, 0.35, 0.15],
  media: [1.0, 0.75, 0.5, 0.25],
  official: [1.0, 0.9, 0.75, 0.5],
  osint: [1.0, 0.6, 0.3, 0.12],
  unknown: [1.0, 0.5, 0.2, 0.08],
};

function norm(s) {
  return String(s ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hoursAgo(date, now = new Date()) {
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60);
}

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function firstLabel(labels, prefix) {
  return (labels || []).find((l) => typeof l === "string" && l.startsWith(prefix)) || null;
}

function hasAny(labels, wanted) {
  return wanted.some((w) => labels.includes(w));
}

function anyLabelStarts(labels, prefixes) {
  return labels.some((l) => prefixes.some((p) => l.startsWith(p)));
}

function parseRepo() {
  const full = process.env.GITHUB_REPOSITORY || "";
  if (full.includes("/")) {
    const [owner, repo] = full.split("/", 2);
    return { owner, repo };
  }
  return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO };
}

async function ghRequest(pathname) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Missing GH_TOKEN / GITHUB_TOKEN.");
  }

  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "voodoo-snapshot",
    },
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} GET ${pathname}: ${txt.slice(0, 500)}`);
  }

  return txt ? JSON.parse(txt) : null;
}

async function listOpenIssues(owner, repo, pages = ISSUE_PAGES) {
  const out = [];

  for (let p = 1; p <= pages; p++) {
    const items = await ghRequest(`/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${p}`);
    for (const it of items || []) {
      if (!it.pull_request) out.push(it);
    }
    if (!items || items.length < 100) break;
  }

  return out;
}


function parseJsonSection(body, heading) {
  const re = new RegExp(`###\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|\\n---|$)`, "i");
  const m = String(body || "").match(re);
  if (!m) return null;
  const raw = m[1].trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(raw); } catch { return null; }
}

function parseGeoJsonFromBody(body) {
  return parseJsonSection(body, "Geo JSON") || {};
}

function validGeoPoint(g) {
  return !!(g && Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lon)) && Math.abs(Number(g.lat)) <= 90 && Math.abs(Number(g.lon)) <= 180);
}

function parseRouteFromBody(body) {
  const gj = parseGeoJsonFromBody(body);
  if (gj?.route?.coordinates?.length >= 2) return gj.route;
  const route = parseJsonSection(body, "Route");
  if (route?.coordinates?.length >= 2) return route;
  return null;
}

function suppressHullFalsePositive(text) {
  return /\b(ship|vessel|carrier|tanker|bulk carrier|container ship|lpg carrier)\b.{0,24}\bhull\b|\bhull\b.{0,30}\b(attached|damage|breach|ship|vessel|carrier|tanker)\b/i.test(String(text || ""));
}

const SNAPSHOT_GAZETTEER = [
  { matched_id:"port_ust_luga", matched_name:"Ust-Luga", aliases:["Ust-Luga","Ust Luga","Port of Ust-Luga","Ust-Luga terminal"], lat:59.67, lon:28.26, radius_km:18, regions:["REG:BALTIC","REG:GULF_OF_FINLAND","REG:RUSSIA_BALTIC"], score:95 },
  { matched_id:"strait_gibraltar", matched_name:"Strait of Gibraltar", aliases:["Strait of Gibraltar","Gibraltar Strait","Gibraltar"], lat:35.96, lon:-5.55, radius_km:45, regions:["REG:MEDITERRANEAN","REG:STRAIT_GIBRALTAR"], score:82 },
  { matched_id:"suez_canal", matched_name:"Suez Canal", aliases:["Suez Canal","Suez"], lat:29.97, lon:32.55, radius_km:55, regions:["REG:SUEZ","REG:RED_SEA"], score:82 },
  { matched_id:"strait_hormuz", matched_name:"Strait of Hormuz", aliases:["Strait of Hormuz","Hormuz Strait","Hormuz"], lat:26.57, lon:56.25, radius_km:60, regions:["REG:PERSIAN_GULF","REG:STRAIT_HORMUZ"], score:82 },
  { matched_id:"bab_el_mandeb", matched_name:"Bab el-Mandeb", aliases:["Bab el-Mandeb","Bab al-Mandab","Bab el Mandeb"], lat:12.61, lon:43.33, radius_km:55, regions:["REG:BAB_EL_MANDEB","REG:RED_SEA"], score:82 },
  { matched_id:"port_skagen", matched_name:"Skagen", aliases:["Skagen"], lat:57.72, lon:10.59, radius_km:30, regions:["REG:SKAGERRAK","REG:DANISH_STRAITS"], score:80 },
  { matched_id:"port_rotterdam", matched_name:"Rotterdam", aliases:["Rotterdam","Port of Rotterdam","Maasvlakte"], lat:51.948, lon:4.142, radius_km:35, regions:["REG:NORTH_SEA"], score:80 },
  { matched_id:"port_hull", matched_name:"Hull", aliases:["Hull","Port of Hull"], lat:53.74, lon:-0.33, radius_km:18, regions:["REG:NORTH_SEA"], score:70 }
];

function inferGeoCandidatesFromText(text) {
  const raw = String(text || "");
  const low = raw.toLowerCase();
  const out = [];
  const seen = new Set();
  const maritimeContext = /\b(port|terminal|anchorage|arriv|depart|sail|transit|passed|heading|destination|eta|ais|vessel|ship|tanker|carrier|warship|naval|fleet|lng|lpg|oil|shadow|sanction)\b/i.test(raw);
  for (const p of SNAPSHOT_GAZETTEER) {
    if (p.matched_id === "port_hull" && suppressHullFalsePositive(raw)) continue;
    for (const alias of p.aliases || []) {
      const a = String(alias).toLowerCase();
      if (!a) continue;
      if (!new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}([^a-z0-9]|$)`, "i").test(raw)) continue;
      if (seen.has(p.matched_id)) continue;
      seen.add(p.matched_id);
      out.push({ ...p, matched_alias: alias, method:"snapshot_controlled_gazetteer", precision:p.radius_km <= 25 ? "port" : "area", confidence: maritimeContext ? "medium_high" : "medium", display_on_map:true, score:(p.score || 70) + (maritimeContext ? 5 : 0) });
    }
  }
  return out.sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,6);
}

function promoteGeoFromCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const [best, second] = candidates;
  if (!best || !Number.isFinite(Number(best.lat)) || !Number.isFinite(Number(best.lon))) return null;
  if (best.score >= 90 || !second || (best.score - (second.score || 0)) >= 18) {
    return { lat:Number(best.lat), lon:Number(best.lon), precision:best.precision || "port_or_area", method:best.method || "geo_candidate_promotion", matched_name:best.matched_name, matched_id:best.matched_id, radius_km:best.radius_km || null, confidence:best.confidence || "medium", geo_role:"event_location_or_topic_area", display_on_map:true, inferred:true };
  }
  return null;
}

function scoreHybridEventPoints(e) {
  const labels = e.labels || [];
  const sev = e.severity || "SEV:1";
  const conf = e.confidence || "CONF:LOW";
  const eventFactor = Number.isFinite(Number(e.score_factor)) ? Number(e.score_factor) : 1;
  const sevW = sev === "SEV:4" ? 9 : sev === "SEV:3" ? 6 : sev === "SEV:2" ? 3 : 1;
  const confW = conf === "CONF:HIGH" ? 1.2 : conf === "CONF:MED" ? 1.0 : 0.8;
  const ci = hasAny(labels, ["OBJ:CABLE","OBJ:PIPELINE","OBJ:WINDFARM","OBJ:PORT","OBJ:VTS_WSV"]) || labels.includes("D:INFRA_CI");
  const patterns = hasAny(labels, ["PAT:LOITERING","PAT:STS_SUSPECT","PAT:AIS_GAP","PAT:DARK_ACTIVITY","PAT:SURVEYING","PAT:ROUTE_DEVIATION","PAT:ROUTE_OBSERVED","PAT:GNSS_JAM","PAT:GNSS_SPOOF","PAT:RF_BURST"]);
  const vesselHot = hasAny(labels, ["V:SHADOW_FLEET","V:RUS_RESEARCH","V:RUS_WARSHIP","V:RUS_AUXILIARY","V:SANCTIONS_EVASION"]);
  const rfCyber = labels.includes("D:RF_SIGNAL") || labels.includes("D:CYBER_OT") || anyLabelStarts(labels, ["RF:"]);
  let evPts = sevW * confW;
  if (e.phase0_suspect) evPts *= 1.6;
  if (ci) evPts *= 1.25;
  if (patterns) evPts *= 1.2;
  if (vesselHot) evPts *= 1.15;
  if (rfCyber) evPts *= 1.1;
  return evPts * eventFactor;
}

function buildHybridHourlyBuckets(events, hours = 72, now = new Date()) {
  const buckets = Array.from({ length: hours }, (_, i) => ({ idx:i, start:null, points:0, pct:0, events:0 }));
  const bucketMs = 3600000;
  for (const e of events || []) {
    const d = parseDate(e.ts);
    if (!d) continue;
    const age = now.getTime() - d.getTime();
    if (age < 0 || age >= hours * bucketMs) continue;
    const idx = hours - 1 - Math.floor(age / bucketMs);
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx].points += scoreHybridEventPoints(e);
    buckets[idx].events += 1;
  }
  for (const b of buckets) b.pct = clamp(Math.round((b.points / 28) * 100));
  return buckets;
}

function scoreHybridWindow(events, windowHours = 6, peakHours = 72, now = new Date()) {
  const buckets = buildHybridHourlyBuckets(events, peakHours, now);
  const last = buckets.slice(-windowHours);
  const avg = last.length ? last.reduce((s,b)=>s+b.pct,0) / last.length : 0;
  const peak = buckets.length ? Math.max(...buckets.map(b=>b.pct)) : 0;
  const windows = {};
  for (const h of [6,12,24,48]) {
    const part = buckets.slice(-h);
    windows[String(h)] = part.length ? Math.round(part.reduce((s,b)=>s+b.pct,0) / part.length) : 0;
  }
  return { score: clamp(Math.round(avg)), peak_score: peak, window_hours: windowHours, peak_hours: peakHours, windows, hourly_buckets: buckets.map(b => ({ idx:b.idx, points:Number(b.points.toFixed(2)), pct:b.pct, events:b.events })), weighted_points: Number(buckets.reduce((s,b)=>s+b.points,0).toFixed(2)) };
}

function eventHasAnyText(e, terms) {
  const hay = `${e.title || ""}\n${e.body || ""}\n${(e.labels || []).join(" ")}`.toLowerCase();
  return terms.some(t => hay.includes(t));
}

function issueToEvent(issue) {
  const labels = (issue.labels || [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean);

  const body = issue.body || "";
  const bodyTimeMatch = body.match(/### Zeit \(UTC\)\s*\n([^\n]+)/i);
  const sourceMatch = body.match(/###\s*(?:Quelle|Source)\s*\n([^\n]+)/i);
  const platformMatch = body.match(/### Plattform\s*\n([^\n]+)/i);
  const linkMatch = body.match(/### Link\s*\n([^\n]+)/i) || body.match(/### URL\s*\n([^\n]+)/i);

  const bodyTime = bodyTimeMatch ? parseDate(bodyTimeMatch[1]) : null;
  const issueTime = parseDate(issue.created_at);
  const ts = bodyTime || issueTime || new Date();

  const sourceLine = sourceMatch ? norm(sourceMatch[1]) : "";
  const sourceIdMatch = sourceLine.match(/\(([^()]+)\)\s*$/);
  const sourceId = sourceIdMatch ? sourceIdMatch[1] : null;

  const latLonMatch =
    body.match(/Geo\s*[:=]\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/i) ||
    body.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);

  const geoJson = parseGeoJsonFromBody(body);
  const sourceGeoMetadata = geoJson?.source_geo_metadata || geoJson?.source_metadata || {};
  let geo = validGeoPoint(geoJson.geo)
    ? geoJson.geo
    : (latLonMatch ? { lat: Number(latLonMatch[1]), lon: Number(latLonMatch[2]), method: "explicit_coordinate", confidence: "high", display_on_map: true } : null);
  let geo_candidates = Array.isArray(geoJson.geo_candidates) ? geoJson.geo_candidates : [];
  if (!geo_candidates.length) geo_candidates = inferGeoCandidatesFromText(`${issue.title || ""}
${body}`);
  if (!geo) geo = promoteGeoFromCandidates(geo_candidates);
  const route = parseRouteFromBody(body);

  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title || "",
    body,
    url: issue.html_url || "",
    link: linkMatch ? norm(linkMatch[1]) : "",
    source_line: sourceLine,
    source_id: sourceId,
    platform: platformMatch ? norm(platformMatch[1]) : "",
    ts: ts.toISOString(),
    labels,
    category: firstLabel(labels, "D:") || "D:UNKNOWN",
    region: firstLabel(labels, "REG:") || null,
    severity: firstLabel(labels, "SEV:") || "SEV:1",
    confidence: firstLabel(labels, "CONF:") || "CONF:LOW",
    phase0_suspect: labels.includes("P0:SUSPECT"),
    phase0_level: labels.find((l) => l === "P0:LOW" || l === "P0:MED" || l === "P0:HIGH") || null,
    geo,
    geo_candidates,
    route,
    source_geo_metadata: sourceGeoMetadata,
  };
}

function bucketStart(date = new Date(), bucketHours = BUCKET_HOURS) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  const h = d.getUTCHours();
  d.setUTCHours(Math.floor(h / bucketHours) * bucketHours);
  return d;
}

function bucketEnd(start, bucketHours = BUCKET_HOURS) {
  return new Date(start.getTime() + bucketHours * 60 * 60 * 1000);
}

function mapToSortedObject(m) {
  return Object.fromEntries(
    Array.from(m.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  );
}

function normalizeUrlForDedupe(url) {
  const raw = norm(url);
  if (!raw) return "";

  try {
    const u = new URL(raw);
    u.hash = "";

    for (const p of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "igshid",
      "ref",
      "ref_src",
    ]) {
      u.searchParams.delete(p);
    }

    return u.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

function simpleHash(s) {
  let h = 2166136261;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function extractTextSection(body) {
  const b = String(body || "");
  const m = b.match(/###\s*Text\s*\n([\s\S]*?)(?:\n\n###|\n###\s*Extra|<!--|$)/i);
  return (m ? m[1] : b)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2500);
}

function sourceKey(e) {
  return e.source_id || e.source_line || "unknown";
}

function sourceKind(e) {
  const labels = e.labels || [];
  const p = String(e.platform || "").toLowerCase();
  const title = String(e.title || "");

  if (labels.includes("SRC:SOCIAL") || p === "x" || p === "bsky" || p === "mastodon") {
    return "social";
  }

  if (p === "rss" || /^\[RSS\]/i.test(title)) {
    return "rss";
  }

  if (labels.includes("SRC:OFFICIAL")) {
    return "official";
  }

  if (labels.includes("SRC:MEDIA")) {
    return "media";
  }

  if (labels.includes("SRC:OSINT")) {
    return "osint";
  }

  return "unknown";
}

function isSocialOrRss(e) {
  const k = sourceKind(e);
  return k === "social" || k === "rss";
}

function eventFingerprint(e) {
  const link = normalizeUrlForDedupe(e.link || "");
  if (link) return `link:${link}`;

  const ingest = String(e.body || "").match(/VOODOO_(?:INGEST|FEED_INGEST):\s*([a-f0-9]+)(?:\s+SOURCE=([A-Za-z0-9_-]+))?/i);
  if (ingest) return `ingest:${ingest[2] || sourceKey(e)}:${ingest[1]}`;

  const text = `${e.title}\n${extractTextSection(e.body)}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  return `text:${simpleHash(text)}`;
}

function dedupeEventList(events) {
  const seen = new Set();
  const kept = [];
  const duplicateBySource = new Map();

  for (const e of events || []) {
    const fp = eventFingerprint(e);
    if (seen.has(fp)) {
      const src = sourceKey(e);
      duplicateBySource.set(src, (duplicateBySource.get(src) || 0) + 1);
      continue;
    }

    seen.add(fp);
    kept.push(e);
  }

  return {
    events: kept,
    duplicate_count: Math.max(0, (events || []).length - kept.length),
    duplicates_by_source: mapToSortedObject(duplicateBySource),
  };
}

function getSourceCapFactor(kind, occurrenceIndex) {
  const profile = SOURCE_CAP_PROFILE[kind] || SOURCE_CAP_PROFILE.unknown;
  const idx = Math.max(0, occurrenceIndex - 1);
  return profile[Math.min(idx, profile.length - 1)] ?? 0.08;
}

function applySourceCaps(events) {
  const occurrence = new Map();
  const capsBySource = new Map();
  const weighted = [];

  for (const e of events || []) {
    const src = sourceKey(e);
    const kind = sourceKind(e);
    const n = (occurrence.get(src) || 0) + 1;
    occurrence.set(src, n);

    const factor = getSourceCapFactor(kind, n);
    const item = {
      ...e,
      score_factor: factor,
      source_occurrence: n,
      source_kind: kind,
    };
    weighted.push(item);

    const cur = capsBySource.get(src) || {
      source_id: src,
      source_kind: kind,
      raw_events: 0,
      weighted_events: 0,
      capped_events: 0,
    };

    cur.raw_events += 1;
    cur.weighted_events += factor;
    if (factor < 1) cur.capped_events += 1;
    capsBySource.set(src, cur);
  }

  const capSummary = Array.from(capsBySource.values())
    .map((x) => ({
      source_id: x.source_id,
      source_kind: x.source_kind,
      raw_events: x.raw_events,
      weighted_events: Number(x.weighted_events.toFixed(2)),
      capped_events: x.capped_events,
    }))
    .sort((a, b) => b.raw_events - a.raw_events || a.source_id.localeCompare(b.source_id))
    .slice(0, 20);

  const weightedEventTotal = weighted.reduce((sum, e) => sum + (Number(e.score_factor) || 0), 0);

  return {
    events: weighted,
    source_cap_summary: capSummary,
    weighted_event_total: Number(weightedEventTotal.toFixed(2)),
  };
}

function sourceKindCounts(events) {
  const m = new Map();

  for (const e of events || []) {
    const key = sourceKind(e);
    m.set(key, (m.get(key) || 0) + 1);
  }

  return mapToSortedObject(m);
}

function sourceDomainCounts(events) {
  const m = new Map();

  for (const e of events || []) {
    const key = `${sourceKey(e)}|${e.category || "D:UNKNOWN"}`;
    m.set(key, (m.get(key) || 0) + 1);
  }

  return mapToSortedObject(m);
}

function sourceRegionCounts(events) {
  const m = new Map();

  for (const e of events || []) {
    const key = `${sourceKey(e)}|${e.region || "REG:UNKNOWN"}`;
    m.set(key, (m.get(key) || 0) + 1);
  }

  return mapToSortedObject(m);
}

function loadKeywordConfig() {
  if (!fs.existsSync(KEYWORD_CFG_PATH)) {
    return {
      loaded: false,
      tiers: {},
      genericSingleTerms: [],
      contextAnchors: [],
    };
  }

  const raw = fs.readFileSync(KEYWORD_CFG_PATH, "utf8");
  const cfg = YAML.parse(raw);

  const tiers = {};
  for (const tierName of ["A", "B", "C", "D"]) {
    const t = cfg?.tiers?.[tierName];
    if (!t) continue;
    tiers[tierName] = {
      weight: Number(t.weight ?? cfg?.scoring?.tier_weights?.[tierName] ?? 0),
      requireContext: Boolean(t.require_context),
      terms: Array.isArray(t.terms) ? t.terms.map(String) : [],
    };
  }

  const genericSingleTerms = cfg?.scoring?.noise_dampening?.generic_single_terms || [];
  const contextAnchors = []
    .concat(cfg?.context_anchors?.maritime || [])
    .concat(cfg?.context_anchors?.regions || [])
    .concat(cfg?.context_anchors?.infrastructure || [])
    .concat(cfg?.context_anchors?.vessel || [])
    .concat(cfg?.context_anchors?.authority_activity || [])
    .map(String);

  return {
    loaded: true,
    version: cfg?.version ?? null,
    tiers,
    genericSingleTerms,
    contextAnchors,
    genericFactor: Number(cfg?.scoring?.noise_dampening?.single_generic_term_factor ?? 0.25),
  };
}

function includesTerm(textLower, term) {
  const t = String(term || "").toLowerCase().trim();
  if (!t) return false;

  // For short uppercase-ish abbreviations such as AIS, UAS, USV, EW, use boundary logic.
  if (/^[a-z0-9-]{2,6}$/.test(t)) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(textLower);
  }

  return textLower.includes(t);
}

function hasContext(textLower, anchors) {
  return anchors.some((a) => includesTerm(textLower, a));
}

function scoreKeywordBarometer(events, kwCfg) {
  // Punkt 3/4 preparation: only Social + RSS are allowed to drive the keyword barometer.
  const sourceScoped = events.filter(isSocialOrRss);

  if (!kwCfg.loaded) {
    return {
      score: 0,
      weighted_hits: 0,
      raw_hits: 0,
      scored_events: sourceScoped.length,
      top_terms: [],
      config_loaded: false,
    };
  }

  const termStats = new Map();
  let weighted = 0;
  let rawHits = 0;

  for (const e of sourceScoped) {
    const text = `${e.title}\n${e.body}`.toLowerCase();
    const context = hasContext(text, kwCfg.contextAnchors);
    const eventFactor = Number.isFinite(Number(e.score_factor)) ? Number(e.score_factor) : 1;

    for (const [tierName, tier] of Object.entries(kwCfg.tiers)) {
      for (const term of tier.terms) {
        if (!includesTerm(text, term)) continue;

        const generic = kwCfg.genericSingleTerms
          .map((x) => String(x).toLowerCase())
          .includes(String(term).toLowerCase());

        if (tier.requireContext && !context) continue;

        let w = tier.weight || 0;
        if (generic && !context) w *= kwCfg.genericFactor || 0.25;
        w *= eventFactor;

        rawHits += 1;
        weighted += w;

        const key = `${tierName}|${term}`;
        const cur = termStats.get(key) || { term, tier: tierName, count: 0, weighted: 0 };
        cur.count += 1;
        cur.weighted += w;
        termStats.set(key, cur);
      }
    }
  }

  const topTerms = Array.from(termStats.values())
    .sort((a, b) => b.weighted - a.weighted || b.count - a.count)
    .slice(0, 12)
    .map((x) => ({
      term: x.term,
      tier: x.tier,
      count: x.count,
      weighted: Number(x.weighted.toFixed(2)),
    }));

  // Cold-start score: not a real baseline yet, just capped weighted density.
  const score = clamp(Math.round((weighted / 20) * 100));

  return {
    score,
    weighted_hits: Number(weighted.toFixed(2)),
    raw_hits: rawHits,
    scored_events: sourceScoped.length,
    top_terms: topTerms,
    config_loaded: true,
    config_version: kwCfg.version,
  };
}

function scoreHybridSeismograph(events) {
  return scoreHybridWindow(events, 6, 72, new Date());
}


function eventInRegion(e, regionId) {
  const labels = e.labels || [];
  const hay = `${e.title}\n${e.body}`.toLowerCase();

  if (regionId === "north_sea") {
    return labels.includes("REG:NORTH_SEA") ||
      labels.includes("REG:GER_BIGHT") ||
      hay.includes("north sea") ||
      hay.includes("nordsee") ||
      hay.includes("german bight") ||
      hay.includes("deutsche bucht");
  }

  if (regionId === "baltic_sea") {
    return labels.includes("REG:BALTIC_SEA") ||
      labels.includes("REG:BALTIC") ||
      hay.includes("baltic") ||
      hay.includes("ostsee") ||
      hay.includes("kattegat") ||
      hay.includes("skagerrak") ||
      hay.includes("bornholm") ||
      hay.includes("gotland");
  }

  return false;
}


function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pointFromAny(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    [obj.lat, obj.lon], [obj.latitude, obj.longitude], [obj.Latitude, obj.Longitude],
    [obj.y, obj.x], [obj.position?.lat, obj.position?.lon], [obj.position?.latitude, obj.position?.longitude],
    [obj.coords?.lat, obj.coords?.lon], [obj.location?.lat, obj.location?.lon],
    [obj.geo?.lat, obj.geo?.lon], [obj.center?.lat, obj.center?.lon]
  ];
  if (Array.isArray(obj.coordinates) && obj.coordinates.length >= 2) candidates.push([obj.coordinates[1], obj.coordinates[0]]);
  if (obj.geometry?.type === "Point" && Array.isArray(obj.geometry.coordinates)) candidates.push([obj.geometry.coordinates[1], obj.geometry.coordinates[0]]);
  for (const [la, lo] of candidates) {
    const lat = numeric(la), lon = numeric(lo);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

function aisItemsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const arrays = [payload.items, payload.vessels, payload.targets, payload.ships, payload.data, payload.rows, payload.results].filter(Array.isArray);
  if (Array.isArray(payload.features)) arrays.push(payload.features.map(f => ({ ...(f.properties || {}), geometry:f.geometry })));
  return arrays.flat().filter(Boolean);
}

function aisText(item) {
  return `${item?.name || ""} ${item?.vessel_name || ""} ${item?.shipname || ""} ${item?.callsign || ""} ${item?.ship_type || ""} ${item?.ship_type_text || ""} ${item?.type || ""} ${item?.category || ""} ${item?.nav_status || ""} ${(Array.isArray(item?.labels) ? item.labels.join(" ") : "")}`.toLowerCase();
}

function isAuthorityAisItem(item) {
  const labels = Array.isArray(item?.labels) ? item.labels : [];
  if (hasAny(labels, ["V:AUTH_COAST_GUARD","V:AUTH_POLICE","V:AUTH_NAVY","V:AUTH_CUSTOMS","V:SAR_UNIT","V:GOVERNMENT","SRC:GOV","SRC:OFFICIAL"])) return true;
  const t = aisText(item);
  return /\b(coast guard|kustwacht|kystvakt|kystverket|police|polizei|bundespolizei|customs|douane|zoll|navy|naval|marine|patrol|sar|search and rescue|rescue|government|authority|bsh|wsv|havariekommando|border guard|fiskeridirektoratet|fishery patrol)\b/i.test(t);
}

let cachedAuthorityAisItems = null;
function authorityAisItems() {
  if (cachedAuthorityAisItems) return cachedAuthorityAisItems;
  const payload = readJsonIfExists(AIS_LIVE_PATH);
  cachedAuthorityAisItems = aisItemsFromPayload(payload).map(item => {
    const point = pointFromAny(item);
    return point ? { ...item, lat:point.lat, lon:point.lon } : null;
  }).filter(item => item && isAuthorityAisItem(item));
  return cachedAuthorityAisItems;
}

function distanceNm(a, b) {
  const R = 3440.065;
  const lat1 = Number(a.lat) * Math.PI / 180;
  const lat2 = Number(b.lat) * Math.PI / 180;
  const dLat = (Number(b.lat) - Number(a.lat)) * Math.PI / 180;
  const dLon = (Number(b.lon) - Number(a.lon)) * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function eventTextForCorrelation(e) {
  return `${e?.title || ""}\n${e?.body || ""}\n${(e?.labels || []).join(" ")}\n${e?.source_line || ""}\n${e?.source_id || ""}`;
}

function sourceIsTjGeoSignal(e) {
  const meta = e?.source_geo_metadata || {};
  const t = eventTextForCorrelation(e).toLowerCase();
  return /\b(te3ej|tj\s*\/\s*te3ej)\b/i.test(t) || meta.government_weirdness_source === true || (String(meta.source_profile || "") === "route_geo_social" && /te3ej/i.test(String(e?.source_id || e?.source_line || "")));
}

function isPointLikeEventGeo(e) {
  if (!validGeoPoint(e?.geo)) return false;
  const g = e.geo || {};
  const method = String(g.method || "").toLowerCase();
  const precision = String(g.precision || "").toLowerCase();
  return precision === "exact" || precision === "route_waypoint" || /coordinate|waypoint|position|morse|dm_|dms/.test(method);
}

function isRussianSurveyOrGovTarget(e) {
  const labels = e?.labels || [];
  if (hasAny(labels, ["V:RUS_RESEARCH","V:RUS_AUXILIARY","V:RUS_WARSHIP","V:RUS_GOV","V:SURVEY","V:INTELLIGENCE"])) return true;
  const t = eventTextForCorrelation(e).toLowerCase();
  const russian = /\b(russian|russia|rus\.?|rf|ru navy|russian navy|black sea fleet|baltic fleet|росси|россий)\b/i.test(t);
  const target = /\b(research|survey|hydrographic|oceanographic|scientific|intelligence|sigint|spy ship|auxiliary|naval auxiliary|warship|frigate|corvette|submarine|yantar|sibiryakov|evgeniy churov|churov|government vessel|navy vessel)\b/i.test(t);
  return russian && target;
}

function tjAuthorityCorrelations(regionalEvents, regionId) {
  const authority = authorityAisItems();
  const matches = [];
  if (!authority.length) return { matches, weighted_points:0, authority_targets:0 };
  for (const e of regionalEvents) {
    if (!sourceIsTjGeoSignal(e) || !isPointLikeEventGeo(e) || !isRussianSurveyOrGovTarget(e)) continue;
    const near = authority.map(item => ({ item, distance_nm:distanceNm(e.geo, item) }))
      .filter(x => Number.isFinite(x.distance_nm) && x.distance_nm <= 1)
      .sort((a,b) => a.distance_nm - b.distance_nm);
    if (!near.length) continue;
    const bonus = Math.min(28, 18 + Math.max(0, near.length - 1) * 5);
    matches.push({
      event_number:e.number,
      title:String(e.title || "").slice(0, 160),
      source_id:e.source_id || null,
      region:regionId,
      lat:Number(e.geo.lat),
      lon:Number(e.geo.lon),
      authority_count:near.length,
      nearest_nm:Number(near[0].distance_nm.toFixed(2)),
      points:bonus
    });
  }
  return { matches, weighted_points:Number(matches.reduce((sum, m) => sum + m.points, 0).toFixed(2)), authority_targets:authority.length };
}

function scoreGovernmentWeirdness(events, regionId) {
  const regional = events.filter((e) => eventInRegion(e, regionId));
  let points = 0;
  let ais_signal_events = 0;
  let adsb_signal_events = 0;
  let coupled_signal_events = 0;

  for (const e of regional) {
    const labels = e.labels || [];
    const eventFactor = Number.isFinite(Number(e.score_factor)) ? Number(e.score_factor) : 1;
    const ais = hasAny(labels, ["SRC:AIS","D:AIS_TRACK","PAT:AIS_GAP","PAT:DARK_ACTIVITY","PAT:LOITERING","PAT:ROUTE_DEVIATION","PAT:ROUTE_OBSERVED","PAT:STS_SUSPECT"]) || eventHasAnyText(e, ["ais gap","dark vessel","loitering","route deviation","ship-to-ship"," sts ","rendezvous"]);
    const adsb = hasAny(labels, ["SRC:ADSB","D:AIR_ACTIVITY","V:MPA","V:SAR_UNIT","V:AUTH_COAST_GUARD","PAT:RACETRACK","PAT:LOW_ORBIT"]) || eventHasAnyText(e, ["ads-b","adsb","mpa","p-8","p8 poseidon","sar aircraft","coast guard aircraft","helicopter","racetrack","orbit","isr"]);
    const official = labels.includes("SRC:OFFICIAL") || hasAny(labels, ["RF:NAVWARN","RF:NAVTEX"]);
    const ci = hasAny(labels, ["OBJ:PORT","OBJ:VTS_WSV","OBJ:CABLE","OBJ:PIPELINE","OBJ:WINDFARM"]) || labels.includes("D:INFRA_CI");
    const rf = labels.includes("D:RF_SIGNAL") || anyLabelStarts(labels, ["RF:"]) || hasAny(labels, ["PAT:GNSS_JAM","PAT:GNSS_SPOOF"]);

    let evPts = 0;
    if (ais) { evPts += 4.5; ais_signal_events++; }
    if (adsb) { evPts += 4.0; adsb_signal_events++; }
    if (official) evPts += 1.5;
    if (ci) evPts += 1.2;
    if (rf) evPts += 1.3;
    if (ais && adsb) { evPts *= 1.8; coupled_signal_events++; }
    else if ((ais || adsb) && (official || ci || rf)) evPts *= 1.35;

    points += evPts * eventFactor;
  }

  const tjCorrelation = tjAuthorityCorrelations(regional, regionId);
  if (tjCorrelation.weighted_points > 0) {
    points += tjCorrelation.weighted_points;
    coupled_signal_events += tjCorrelation.matches.length;
  }

  return {
    score: clamp(Math.round((points / 38) * 100)),
    weighted_points: Number(points.toFixed(2)),
    regional_events: regional.length,
    regional_weighted_events: Number(regional.reduce((sum, e) => sum + (Number(e.score_factor) || 0), 0).toFixed(2)),
    ais_signal_events,
    adsb_signal_events,
    coupled_signal_events,
    tj_geo_authority_correlations: tjCorrelation.matches.length,
    tj_geo_authority_points: tjCorrelation.weighted_points,
    tj_geo_authority_matches: tjCorrelation.matches.slice(0, 10),
  };
}

function topSources(events) {
  const m = new Map();

  for (const e of events) {
    const key = sourceKey(e);
    m.set(key, (m.get(key) || 0) + 1);
  }

  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([source_id, count]) => ({ source_id, count }));
}

function domainCounts(events) {
  const m = new Map();

  for (const e of events) {
    const key = e.category || "D:UNKNOWN";
    m.set(key, (m.get(key) || 0) + 1);
  }

  return mapToSortedObject(m);
}

function regionCounts(events) {
  const m = new Map();

  for (const e of events) {
    const key = e.region || "REG:UNKNOWN";
    m.set(key, (m.get(key) || 0) + 1);
  }

  return mapToSortedObject(m);
}

function readExistingSnapshots(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeSnapshots(filePath, snapshots) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const out = snapshots.map((x) => JSON.stringify(x)).join("\n") + "\n";
  fs.writeFileSync(filePath, out, "utf8");
}

function writeLatest(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

async function main() {
  const now = new Date();
  const start = bucketStart(now, BUCKET_HOURS);
  const end = bucketEnd(start, BUCKET_HOURS);

  const { owner, repo } = parseRepo();
  console.log(`VOODOO snapshot start: ${nowIso()}`);
  console.log(`Repo: ${owner}/${repo}`);
  console.log(`Bucket: ${start.toISOString()} -> ${end.toISOString()}`);

  const issues = await listOpenIssues(owner, repo, ISSUE_PAGES);
  const events = issues.map(issueToEvent);

  const recent72 = events.filter((e) => {
    const d = parseDate(e.ts);
    return d && hoursAgo(d, now) <= 72;
  });

  const currentBucket = events.filter((e) => {
    const d = parseDate(e.ts);
    return d && d >= start && d < end;
  });

  const dedupeAll = dedupeEventList(events);
  const dedupe72 = dedupeEventList(recent72);
  const dedupeBucket = dedupeEventList(currentBucket);

  const capped72 = applySourceCaps(dedupe72.events);
  const cappedBucket = applySourceCaps(dedupeBucket.events);

  const socialRssBucket = currentBucket.filter(isSocialOrRss);
  const socialRss72 = recent72.filter(isSocialOrRss);
  const socialRssBucketDeduped = dedupeBucket.events.filter(isSocialOrRss);
  const socialRss72Deduped = dedupe72.events.filter(isSocialOrRss);

  const keywordCfg = loadKeywordConfig();

  const hybrid = scoreHybridWindow(capped72.events, Number(process.env.HYBRID_WINDOW_HOURS || 6), 72, now);
  const keyword = scoreKeywordBarometer(cappedBucket.events, keywordCfg);
  const govNorth = scoreGovernmentWeirdness(capped72.events, "north_sea");
  const govBaltic = scoreGovernmentWeirdness(capped72.events, "baltic_sea");

  const snapshot = {
    schema_version: 3,
    ts: now.toISOString(),
    bucket_start_utc: start.toISOString(),
    bucket_end_utc: end.toISOString(),
    bucket_hours: BUCKET_HOURS,
    source: {
      type: "github_issues",
      owner,
      repo,
      state: "open",
    },
    counts: {
      open_events_total: events.length,
      open_events_deduped_total: dedupeAll.events.length,
      recent_72h_events: recent72.length,
      recent_72h_deduped_events: dedupe72.events.length,
      recent_72h_source_capped_weighted_events: capped72.weighted_event_total,
      current_bucket_events: currentBucket.length,
      current_bucket_deduped_events: dedupeBucket.events.length,
      current_bucket_source_capped_weighted_events: cappedBucket.weighted_event_total,
      duplicate_events_total: dedupeAll.duplicate_count,
      duplicate_events_72h: dedupe72.duplicate_count,
      duplicate_events_bucket: dedupeBucket.duplicate_count,
      social_rss_events_72h: socialRss72.length,
      social_rss_deduped_events_72h: socialRss72Deduped.length,
      social_rss_events_bucket: socialRssBucket.length,
      social_rss_deduped_events_bucket: socialRssBucketDeduped.length,
      p0_suspect_72h: recent72.filter((e) => e.phase0_suspect).length,

      // Achtung: snapshot.mjs erkennt derzeit nur explizite Koordinaten im Issue-Text.
      // Gazetteer-/Text-Geocoding läuft im Worker und wird in Punkt 5 harmonisiert.
      geo_total: events.filter((e) => !!e.geo).length,
      geo_72h: recent72.filter((e) => !!e.geo).length,
      geo_count_method: "explicit_coordinates_or_controlled_candidates",
    },
    sensors: {
      hybrid_seismograph_pct: hybrid.score,
      hybrid_window_hours: hybrid.window_hours,
      hybrid_72h_peak_pct: hybrid.peak_score,
      hybrid_windows_pct: hybrid.windows,
      keyword_barometer_pct: keyword.score,
      government_weirdness: {
        north_sea_pct: govNorth.score,
        baltic_sea_pct: govBaltic.score,
      },
    },
    diagnostics: {
      scoring_input_note: "Sensor scores use deduped events plus source caps. Raw counts remain available for baseline analysis.",
      source_cap_profile: SOURCE_CAP_PROFILE,
      hybrid_weighted_points_72h: hybrid.weighted_points,
      hybrid_hourly_buckets_72h: hybrid.hourly_buckets,
      keyword_weighted_hits_bucket: keyword.weighted_hits,
      keyword_raw_hits_bucket: keyword.raw_hits,
      keyword_scored_events_bucket: keyword.scored_events,
      government_weirdness_north_sea_points: govNorth.weighted_points,
      government_weirdness_baltic_sea_points: govBaltic.weighted_points,
      government_weirdness_north_sea_events: govNorth.regional_events,
      government_weirdness_baltic_sea_events: govBaltic.regional_events,
      government_weirdness_north_sea_weighted_events: govNorth.regional_weighted_events,
      government_weirdness_baltic_sea_weighted_events: govBaltic.regional_weighted_events,
      government_weirdness_north_sea_tj_geo_authority_correlations: govNorth.tj_geo_authority_correlations,
      government_weirdness_baltic_sea_tj_geo_authority_correlations: govBaltic.tj_geo_authority_correlations,
      government_weirdness_north_sea_tj_geo_authority_points: govNorth.tj_geo_authority_points,
      government_weirdness_baltic_sea_tj_geo_authority_points: govBaltic.tj_geo_authority_points,
      government_weirdness_tj_geo_authority_matches: [
        ...(govNorth.tj_geo_authority_matches || []),
        ...(govBaltic.tj_geo_authority_matches || [])
      ].slice(0, 12),
      keyword_config_loaded: keyword.config_loaded,
      keyword_config_version: keyword.config_version ?? null,
      cold_start_note: "Scores are cold-start density values until a 90-day baseline exists.",
    },
    top_terms: keyword.top_terms,
    top_sources_72h: topSources(recent72),
    top_sources_72h_deduped: topSources(dedupe72.events),
    domain_counts_72h: domainCounts(recent72),
    domain_counts_72h_deduped: domainCounts(dedupe72.events),
    region_counts_72h: regionCounts(recent72),
    region_counts_72h_deduped: regionCounts(dedupe72.events),

    baseline_observations: {
      note: "Raw baseline observations for later 90-day normalization. Scores are not yet baseline-normalized.",
      source_kind_counts_bucket: sourceKindCounts(currentBucket),
      source_kind_counts_bucket_deduped: sourceKindCounts(dedupeBucket.events),
      source_kind_counts_72h: sourceKindCounts(recent72),
      source_kind_counts_72h_deduped: sourceKindCounts(dedupe72.events),
      source_domain_counts_bucket: sourceDomainCounts(currentBucket),
      source_domain_counts_bucket_deduped: sourceDomainCounts(dedupeBucket.events),
      source_domain_counts_72h: sourceDomainCounts(recent72),
      source_domain_counts_72h_deduped: sourceDomainCounts(dedupe72.events),
      source_region_counts_72h: sourceRegionCounts(recent72),
      source_region_counts_72h_deduped: sourceRegionCounts(dedupe72.events),
      duplicate_sources_bucket: dedupeBucket.duplicates_by_source,
      duplicate_sources_72h: dedupe72.duplicates_by_source,
      source_caps_bucket: cappedBucket.source_cap_summary,
      source_caps_72h: capped72.source_cap_summary,
    },
  };

  const cutoff = new Date(now.getTime() - SNAPSHOT_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const existing = readExistingSnapshots(SNAPSHOT_PATH)
    .filter((x) => {
      const d = parseDate(x.ts || x.bucket_start_utc);
      return d && d >= cutoff;
    })
    .filter((x) => x.bucket_start_utc !== snapshot.bucket_start_utc);

  existing.push(snapshot);
  existing.sort((a, b) => String(a.bucket_start_utc).localeCompare(String(b.bucket_start_utc)));

  writeSnapshots(SNAPSHOT_PATH, existing);
  writeLatest(LATEST_PATH, snapshot);

  console.log(`Snapshots stored: ${existing.length}`);
  console.log(`Latest written: ${LATEST_PATH}`);
  console.log(`NDJSON written: ${SNAPSHOT_PATH}`);
  console.log(`Hybrid: ${snapshot.sensors.hybrid_seismograph_pct}%`);
  console.log(`Keyword: ${snapshot.sensors.keyword_barometer_pct}%`);
  console.log(`Government-Weirdness North Sea: ${snapshot.sensors.government_weirdness.north_sea_pct}%`);
  console.log(`Government-Weirdness Baltic Sea: ${snapshot.sensors.government_weirdness.baltic_sea_pct}%`);
}

main().catch((err) => {
  console.error("FATAL snapshot error:");
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
