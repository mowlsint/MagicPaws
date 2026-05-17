#!/usr/bin/env node
/**
 * MAGIC PAWS – Log/Archive/Summary Builder v5.32 Social + Geo
 *
 * Runs in GitHub Actions every 6 hours.
 * - Fetches the Worker bundle (/api/bundle?fresh=1 by default)
 * - Merges new events with existing repository archive files
 * - Writes:
 *   data/logs/magicpaws_events_20d.json
 *   data/archive/magicpaws_YYYY-MM.jsonl
 *   data/archive/magicpaws_archive_manifest.json
 *   data/snapshots/magicpaws_daily_summary.json
 *   data/snapshots/magicpaws_sensor_latest.json
 *   data/snapshots/magicpaws_sensor_snapshots.ndjson
 *
 * No npm dependencies required. Node 20+ recommended.
 */

import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const WORKER_BASE = process.env.MAGIC_PAWS_WORKER_BASE || "https://voodoo-hybrid-api.mowlsint.workers.dev";
const BUNDLE_URL = process.env.MAGIC_PAWS_BUNDLE_URL || `${WORKER_BASE}/api/bundle?fresh=1`;
const ACTIVE_WINDOW_DAYS = Number(process.env.MAGIC_PAWS_ACTIVE_WINDOW_DAYS || 20);
const DAILY_SUMMARY_DAYS = Number(process.env.MAGIC_PAWS_DAILY_SUMMARY_DAYS || 365);
const SNAPSHOT_KEEP_LINES = Number(process.env.MAGIC_PAWS_SNAPSHOT_KEEP_LINES || 12000);
const GAZETTEER_JSON = path.join(ROOT, "config", "maritime_gazetteer.json");

const OUT = {
  logsDir: path.join(ROOT, "data", "logs"),
  archiveDir: path.join(ROOT, "data", "archive"),
  snapshotsDir: path.join(ROOT, "data", "snapshots"),
  active20d: path.join(ROOT, "data", "logs", "magicpaws_events_20d.json"),
  manifest: path.join(ROOT, "data", "archive", "magicpaws_archive_manifest.json"),
  dailySummary: path.join(ROOT, "data", "snapshots", "magicpaws_daily_summary.json"),
  sensorLatest: path.join(ROOT, "data", "snapshots", "magicpaws_sensor_latest.json"),
  sensorHistory: path.join(ROOT, "data", "snapshots", "magicpaws_sensor_snapshots.ndjson")
};

const KEYWORD_TIERS = {
  hard: [
    "sabotage", "sabotageverdacht", "диверсия", "диверсія", "sabotaż", "sabotaje", "sabotageactie",
    "espionage", "spionage", "spy ship", "spionageschiff", "reconnaissance", "surveillance", "разведка", "розвідка",
    "gnss jamming", "gnss spoofing", "gps jamming", "gps spoofing", "jamming", "spoofing", "глушение", "глушіння",
    "cable cut", "cable damage", "subsea cable", "seekabel", "kabelschaden", "kabelbruch", "pipeline damage", "pipeline leak", "pipe rupture",
    "underwater drone", "uuv", "auv", "seabed warfare", "seabed", "subsea", "unterwasser", "meeresboden",
    "ais spoof", "ais gap", "ais off", "dark vessel", "dark activity", "loitering", "sts", "ship-to-ship",
    "shadow fleet", "dark fleet", "sanctions evasion", "sanctions avoidance", "sanktionsumgehung", "sanktionsflotte"
  ],
  soft: [
    "unusual activity", "suspicious", "auffällig", "ungewöhnlich", "verdächtig", "anomalous", "incident", "disturbance", "disruption",
    "navwarn", "navtex", "navigational warning", "security zone", "exclusion zone", "übungsgebiet", "military exercise", "coast guard", "navy", "patrol",
    "drone", "uas", "uav", "drohne", "helicopter", "mpa", "isr", "sar", "rendezvous", "anchoring", "route deviation",
    "port disruption", "terminal outage", "cyber", "ransomware", "ot", "scada", "vts"
  ]
};

function normalizeText(s) {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function shortText(s, n = 1200) {
  const value = String(s ?? "").trim();
  return value.length > n ? `${value.slice(0, n - 1)}…` : value;
}

function cleanUrl(raw) {
  return String(raw || "").trim().replace(/^<|>$/g, "").replace(/[),.;]+$/g, "");
}

function isGithubIssueUrl(url) {
  return /github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(String(url || ""));
}

function parseDateMs(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function firstDateMs(...values) {
  for (const value of values) {
    const ms = parseDateMs(value);
    if (ms !== null) return ms;
  }
  return null;
}

function firstIsoDate(...values) {
  const ms = firstDateMs(...values);
  return ms === null ? null : new Date(ms).toISOString();
}

function summaryField(ev, field) {
  const txt = String(ev?.summary ?? "");
  const re = new RegExp(`${field}\\s*:\\s*([^\\n\\r]+)`, "i");
  return (txt.match(re) || [])[1]?.trim() || null;
}

function summaryZeitHeaderDate(ev) {
  const txt = String(ev?.summary ?? "");
  const re = /###\s*Zeit\s*\(UTC\)\s*\n\s*([^\n\r]+)/i;
  const m = txt.match(re);
  if (!m) return null;
  const value = m[1].trim();
  if (/^[a-z0-9_ -]+\s*:/i.test(value)) return null;
  return value;
}

function originalUrlFromEvent(ev) {
  const direct = [ev?.original_url, ev?.source_url, ev?.link]
    .map(cleanUrl)
    .find(u => /^https?:\/\//i.test(u) && !isGithubIssueUrl(u));
  if (direct) return direct;

  const txt = String(ev?.summary || "");
  const patterns = [
    /###\s*Link\s*\n\s*(https?:\/\/[^\s<>"']+)/i,
    /###\s*URL\s*\n\s*(https?:\/\/[^\s<>"']+)/i,
    /(?:^|\n)\s*Link\s*:\s*(https?:\/\/[^\s<>"']+)/i,
    /(?:^|\n)\s*Original(?:meldung|quelle| source)?\s*:\s*(https?:\/\/[^\s<>"']+)/i
  ];
  for (const re of patterns) {
    const m = txt.match(re);
    if (m?.[1]) {
      const u = cleanUrl(m[1]);
      if (/^https?:\/\//i.test(u) && !isGithubIssueUrl(u)) return u;
    }
  }

  const urls = txt.match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const raw of urls) {
    const u = cleanUrl(raw);
    if (/^https?:\/\//i.test(u) && !isGithubIssueUrl(u)) return u;
  }
  return null;
}

function getEventChronologyMs(ev) {
  return firstDateMs(
    ev?.chronology_ts,
    ev?.source_published_at,
    ev?.sourcePublishedAt,
    ev?.published_at,
    ev?.publishedAt,
    ev?.source_hint?.source_published_at,
    ev?.source_hint?.sourcePublishedAt,
    summaryField(ev, "source_published_at"),
    summaryField(ev, "published_at"),
    summaryField(ev, "published"),
    summaryZeitHeaderDate(ev),
    ev?.ts
  ) ?? 0;
}

function inferSourceHint(ev) {
  const s = String(ev?.summary ?? "");
  const existing = ev?.source_hint ?? {};
  const source = s.match(/###\s*Quelle\s*\n([^\n\r]+)/i);
  const platform = s.match(/###\s*Plattform\s*\n([^\n\r]+)/i);
  const link = s.match(/###\s*Link\s*\n([^\n\r]+)/i);
  const sourcePublishedAt = firstIsoDate(
    existing.source_published_at,
    existing.sourcePublishedAt,
    ev?.source_published_at,
    ev?.sourcePublishedAt,
    summaryField(ev, "source_published_at"),
    summaryField(ev, "published_at"),
    summaryZeitHeaderDate(ev)
  );
  const ingestedAt = firstIsoDate(
    existing.ingested_at,
    existing.ingestedAt,
    ev?.ingested_at,
    ev?.ingestedAt,
    summaryField(ev, "ingested_at"),
    summaryField(ev, "ingest_run"),
    ev?.ts
  );
  return {
    source: existing.source ?? (source ? source[1].trim() : null),
    platform: existing.platform ?? (platform ? platform[1].trim() : null),
    link: existing.link ?? (link ? link[1].trim() : null),
    source_published_at: sourcePublishedAt,
    ingested_at: ingestedAt
  };
}

function inferReportCategory(ev) {
  const labels = ev?.labels ?? [];
  const cat = ev?.category ?? "";
  if (cat === "D:CYBER_OT") return "Hafen/KRITIS/Cyber/operative Störungen";
  if (cat === "D:INFRA_CI") return "Maritime KRITIS / Offshore-Infrastruktur";
  if (cat === "D:RF_SIGNAL" || labels.some(l => String(l).startsWith("RF:"))) return "RF/GNSS/NAVWARN";
  if (cat === "D:DRONE_UAS") return "Drohnen / UxV";
  if (cat === "D:AIR_ACTIVITY") return "Luftaktivität / ISR / SAR";
  if (cat === "D:AIS_TRACK") return "AIS / Schiffsmuster / Schattenflotte";
  if (cat === "D:SECURITY_CRIME") return "Maritime Crime / Security";
  if (cat === "D:INCIDENT") return "Zwischenfälle / Safety / Störungen";
  if (cat === "D:SATELLITE") return "Satellit / Fernerkundung";
  return "News / Intelligence Hinweise";
}

function inferGreybookRubric(ev) {
  const labels = ev?.labels ?? [];
  const cat = ev?.category ?? "";
  const text = `${ev?.title ?? ""} ${ev?.summary ?? ""} ${labels.join(" ")}`;
  if (cat === "D:DRONE_UAS" || /\b(drone|drohne|uas|uav|usv|uuv|auv)\b/i.test(text)) return "Drohnen";
  if (cat === "D:CYBER_OT" || /\b(cyber|ransomware|scada|ot|vts|terminal operating system)\b/i.test(text)) return "Cyber- und IT-Sicherheit";
  if (labels.includes("V:SHADOW_FLEET") || labels.includes("V:SANCTIONS_EVASION") || /shadow fleet|dark fleet|sanktionsflotte|sanctions/i.test(text)) return "Schattenflotte/Sanktionsflotte";
  if (cat === "D:RF_SIGNAL" || cat === "D:AIR_ACTIVITY" || cat === "D:INFRA_CI" || labels.includes("P0:SUSPECT")) return "Maritime Security/Hybride Bedrohungen";
  if (/russia|russisch|china|iran|black sea|schwarzes meer|nato|navy|kriegsschiff|warship/i.test(text)) return "maritime Geopolitik";
  return "Unreleased but self-confirmed";
}


// v5.32: cautious post-processor geolocation for archived events.
// Purpose: do not wait for the Worker/ingest to pin obvious maritime places, but avoid person-name false positives.
const UNSAFE_GEO_ALIASES = new Set([
  "channel", "sound", "belt", "bay", "port", "strait", "the gulf", "the sound",
  "jose", "santos", "ford", "anson", "storis", "clear", "union", "delta", "victoria",
  "george", "washington", "lincoln", "enterprise", "freedom", "independence"
]);

const MARITIME_CONTEXT_RE = /\b(ship|ships|shipping|maritime|naval|navy|warship|frigate|submarine|submarines|carrier|tanker|cargo|container|port|terminal|harbour|harbor|strait|gulf|sea|ocean|coast|coastguard|coast guard|vessel|vessels|fleet|convoy|transit|ais|navtex|navwarn|gnss|piracy|seabed|cable|pipeline|offshore|fishing|fishermen|fisheries)\b/i;

const CONTROLLED_GEO_RULES = [
  {
    id: "port_gibraltar", matched_name: "Gibraltar", lat: 36.1408, lon: -5.3536, radius_km: 12,
    regions: ["REG:STRAIT_GIBRALTAR", "REG:MEDITERRANEAN", "REG:BISCAY_ATLANTIC_APPROACHES"],
    patterns: [/\bgibraltar\b/i],
    context: /\b(submarine|submarines|naval|navy|warship|vessel|ship|port|strait|gibraltar strait|transit|maritime|fleet|carrier|tanker)\b/i
  },
  {
    id: "port_djibouti", matched_name: "Djibouti", lat: 11.6040, lon: 43.1450, radius_km: 20,
    regions: ["REG:HORN_OF_AFRICA", "REG:GULF_OF_ADEN", "REG:RED_SEA"],
    patterns: [/\bdjibouti\b/i],
    context: /\b(ship|shipping|naval|navy|fleet|port|vessel|maritime|gulf of aden|goa|red sea|frigate|piracy|base|chokepoint)\b/i
  },
  {
    id: "gulf_of_aden", matched_name: "Gulf of Aden", lat: 12.3, lon: 48.5, radius_km: 520,
    regions: ["REG:GULF_OF_ADEN", "REG:HORN_OF_AFRICA", "REG:INDIAN_OCEAN"],
    patterns: [/\bgulf of aden\b/i, /\bGOA\b/],
    context: /\b(djibouti|aden|somalia|yemen|red sea|bab el|mandeb|frigate|naval|navy|piracy|shipping|vessel|maritime|CdeG|gulf of aden|goa)\b/i
  },
  {
    id: "gulf_of_oman", matched_name: "Gulf of Oman", lat: 24.7, lon: 58.5, radius_km: 350,
    regions: ["REG:GULF_OF_OMAN", "REG:ARABIAN_SEA", "REG:STRAIT_HORMUZ"],
    patterns: [/\bgulf of oman\b/i, /\bGOO\b/],
    context: /\b(hormuz|oman|iran|uae|emirates|arabian sea|tanker|shipping|vessel|naval|navy|maritime|gulf of oman|goo)\b/i
  },
  {
    id: "bering_sea", matched_name: "Bering Sea", lat: 58.8, lon: -177.0, radius_km: 900,
    regions: ["REG:HIGH_NORTH_ARCTIC", "REG:BERING_SEA", "REG:PACIFIC"],
    patterns: [/\bbering sea\b/i],
    context: /\b(coast guard|icebreaker|patrol|deployment|vessel|ship|maritime|fishing|arctic|sea)\b/i
  },
  {
    id: "port_norfolk_us", matched_name: "Norfolk", lat: 36.9467, lon: -76.3300, radius_km: 18,
    regions: ["REG:US_EAST_COAST", "REG:ATLANTIC_WEST"],
    patterns: [/\bnorfolk\b/i],
    context: /\b(uss|us navy|navy|naval|carrier|warship|pier|submarine|deployment|fleet|cvn|vessel|ship)\b/i
  },
  {
    id: "port_long_beach", matched_name: "Long Beach", lat: 33.7542, lon: -118.2165, radius_km: 20,
    regions: ["REG:US_WEST_COAST", "REG:PACIFIC"],
    patterns: [/\blong beach\b/i],
    context: /\b(port|cargo|container|terminal|shipping|supply chain|vessel|ship|maritime)\b/i
  }
];

function stripHtmlish(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z0-9#]+;/gi, " ");
}

function eventGeoText(ev) {
  return stripHtmlish(`${ev?.title ?? ""}\n${ev?.summary ?? ""}\n${(ev?.labels ?? []).join(" ")}`);
}

function normalizeExistingGeo(geo) {
  if (!geo) return null;
  const lat = Number(geo.lat);
  const lon = Number(geo.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { ...geo, lat, lon, display_on_map: geo.display_on_map !== false };
}

function parseExplicitGeo(ev) {
  const text = eventGeoText(ev).replace(/(\d),(\d)/g, "$1.$2");
  const patterns = [
    /(?:^|\b)(?:geo|coords?|coordinates|position|pos|lat\s*\/\s*lon)\s*[:=]?\s*(-?\d{1,2}\.\d+)\s*[,;\s]+\s*(-?\d{1,3}\.\d+)/i,
    /\blat\s*[:=]\s*(-?\d{1,2}\.\d+)\s*(?:,|;|\s)+lon\s*[:=]\s*(-?\d{1,3}\.\d+)/i,
    /(^|\s)(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?=\s|$)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const nums = m.slice(1).filter(x => /^-?\d/.test(String(x)));
    const lat = Number(nums[0]);
    const lon = Number(nums[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return {
        lat,
        lon,
        precision: "exact",
        method: "explicit_coordinate_text",
        matched_name: "Explicit coordinates",
        matched_id: "explicit_coordinate",
        radius_km: null,
        confidence: "high",
        geo_role: "event_location",
        display_on_map: true,
        regions: []
      };
    }
  }
  return null;
}

function geoFromRule(rule, confidence = "medium_high") {
  return {
    lat: rule.lat,
    lon: rule.lon,
    precision: rule.radius_km && rule.radius_km > 25 ? "area" : "port",
    method: "controlled_text_rule",
    matched_name: rule.matched_name,
    matched_id: rule.id,
    radius_km: rule.radius_km ?? null,
    confidence,
    geo_role: rule.radius_km && rule.radius_km > 25 ? "topic_area" : "event_location_or_topic_area",
    display_on_map: true,
    regions: rule.regions ?? []
  };
}

function inferGeoFromControlledRules(ev) {
  const text = eventGeoText(ev);
  for (const rule of CONTROLLED_GEO_RULES) {
    if (!rule.patterns.some(re => re.test(text))) continue;
    if (rule.context && !rule.context.test(text)) continue;
    return geoFromRule(rule, rule.radius_km && rule.radius_km > 100 ? "medium" : "medium_high");
  }
  return null;
}

function loadGazetteerPlaces() {
  try {
    if (!fsSync.existsSync(GAZETTEER_JSON)) return [];
    const parsed = JSON.parse(fsSync.readFileSync(GAZETTEER_JSON, "utf8"));
    return Array.isArray(parsed?.places) ? parsed.places : [];
  } catch (err) {
    console.warn(`[magicpaws] Gazetteer not loaded: ${err.message}`);
    return [];
  }
}

const GAZETTEER_PLACES = loadGazetteerPlaces();

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function placeAliases(place) {
  const aliases = [];
  for (const values of Object.values(place?.aliases ?? {})) {
    if (Array.isArray(values)) aliases.push(...values);
  }
  aliases.push(place?.canonical_name, place?.id);
  return [...new Set(aliases.filter(Boolean).map(x => String(x).trim()).filter(Boolean))];
}

function phraseHit(textNorm, alias) {
  const a = normalizeText(alias).replace(/[_/.,:;()\[\]{}]+/g, " ").replace(/\s+/g, " ").trim();
  if (!a || a.length < 3) return false;
  if (UNSAFE_GEO_ALIASES.has(a)) return false;
  const pattern = a.split(" ").map(escapeRegExp).join("\\s+");
  const re = new RegExp(`(?:^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "i");
  return re.test(textNorm);
}

function inferGeoFromGazetteer(ev) {
  if (!GAZETTEER_PLACES.length) return { geo: null, candidates: [] };
  const rawText = eventGeoText(ev);
  const titleNorm = normalizeText(ev?.title ?? "").replace(/[_/.,:;()\[\]{}]+/g, " ").replace(/\s+/g, " ");
  const textNorm = normalizeText(rawText).replace(/[_/.,:;()\[\]{}]+/g, " ").replace(/\s+/g, " ");
  const hasMaritimeContext = MARITIME_CONTEXT_RE.test(rawText);
  const hits = [];

  for (const place of GAZETTEER_PLACES) {
    for (const alias of placeAliases(place)) {
      const aliasNorm = normalizeText(alias).replace(/[_/.,:;()\[\]{}]+/g, " ").replace(/\s+/g, " ").trim();
      if (!aliasNorm || UNSAFE_GEO_ALIASES.has(aliasNorm)) continue;
      if (aliasNorm.length < 5 && !hasMaritimeContext) continue;
      if (!phraseHit(textNorm, aliasNorm)) continue;
      const inTitle = phraseHit(titleNorm, aliasNorm);
      const generic = aliasNorm.split(/\s+/).length === 1 && aliasNorm.length < 7;
      if (generic && !hasMaritimeContext) continue;
      const placeType = String(place.type || "");
      let score = aliasNorm.length + (inTitle ? 25 : 0);
      if (/strait|sea_area|port|island|chokepoint/i.test(placeType)) score += 10;
      if (generic) score -= 8;
      hits.push({ place, alias, aliasNorm, inTitle, score });
      break;
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const candidates = hits.slice(0, 6).map(h => ({
    matched_id: h.place.id,
    matched_name: h.place.canonical_name,
    matched_alias: h.alias,
    lat: Number(h.place.center?.lat),
    lon: Number(h.place.center?.lon),
    radius_km: h.place.radius_km ?? null,
    precision: h.place.precision ?? (String(h.place.type || "").includes("port") ? "port" : "area"),
    regions: h.place.regions ?? [],
    score: h.score,
    in_title: h.inTitle
  })).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));

  if (!candidates.length) return { geo: null, candidates };
  const top = candidates[0];
  const second = candidates[1];
  if (second && top.score < second.score + 18) return { geo: null, candidates };

  return {
    geo: {
      lat: top.lat,
      lon: top.lon,
      precision: top.precision,
      method: "gazetteer_alias_archive_postprocess",
      matched_name: top.matched_name,
      matched_alias: top.matched_alias,
      matched_id: top.matched_id,
      radius_km: top.radius_km,
      confidence: top.precision === "port" ? "medium_high" : "medium",
      geo_role: top.precision === "port" ? "event_location_or_topic_area" : "topic_area",
      display_on_map: true,
      regions: top.regions
    },
    candidates
  };
}

function inferGeoBundle(ev) {
  const existing = normalizeExistingGeo(ev?.geo);
  if (existing) return { geo: existing, candidates: Array.isArray(ev?.geo_candidates) ? ev.geo_candidates : [], inferred: false };
  const explicit = parseExplicitGeo(ev);
  if (explicit) return { geo: explicit, candidates: [], inferred: true };
  const controlled = inferGeoFromControlledRules(ev);
  if (controlled) return { geo: controlled, candidates: [controlled], inferred: true };
  const gaz = inferGeoFromGazetteer(ev);
  return { geo: gaz.geo, candidates: gaz.candidates, inferred: Boolean(gaz.geo) };
}

function inferSourceType(ev, sourceHint = inferSourceHint(ev)) {
  const labels = Array.isArray(ev?.labels) ? ev.labels : [];
  const platform = normalizeText(sourceHint?.platform || "");
  const source = normalizeText(sourceHint?.source || "");
  const title = normalizeText(ev?.title || "");
  const url = normalizeText(sourceHint?.link || ev?.original_url || ev?.source_url || ev?.link || "");
  const text = `${platform} ${source} ${title} ${url} ${labels.join(" ").toLowerCase()}`;
  if (/social[_ -]?bsky|bluesky|bsky/.test(text)) return "social_bsky";
  if (labels.includes("SRC:SOCIAL") || /\bsocial[_ -]?x\b|\bx \(|\[x\]|nitter|twitter|x\.com/.test(text)) return "social_x";
  if (/\brss\b|feedburner|\.rss|\/feed/.test(text)) return "rss";
  if (labels.includes("SRC:OFFICIAL")) return "official";
  if (labels.includes("SRC:MEDIA")) return "media";
  return "other";
}

function eventArchiveKey(ev) {
  const directUrl = cleanUrl(ev?.url || ev?.original_url || ev?.source_url || ev?.link || originalUrlFromEvent(ev) || "");
  if (directUrl) return `url:${directUrl.toLowerCase()}`;
  if (ev?.id) return `id:${ev.id}`;
  if (ev?.number) return `issue:${ev.number}`;
  const ms = getEventChronologyMs(ev) || parseDateMs(ev?.ts) || 0;
  return `txt:${normalizeText((ev?.title || "").slice(0, 180))}:${ms}`;
}

function compactEvent(ev) {
  const sourceHint = inferSourceHint(ev);
  const sourceType = inferSourceType(ev, sourceHint);
  const geoBundle = inferGeoBundle(ev);
  const geo = geoBundle.geo;
  let labels = Array.isArray(ev?.labels) ? [...ev.labels] : [];

  if (geo) {
    // MAP:NO is useful for generic source defaults, but should not suppress explicit/controlled inferred places.
    labels = labels.filter(l => l !== "MAP:NO");
    if (geoBundle.inferred && !labels.includes("MAP:INFERRED")) labels.push("MAP:INFERRED");
    for (const r of geo.regions || []) if (r && !labels.includes(r)) labels.push(r);
  }

  const chronologyMs = getEventChronologyMs(ev);
  const originalRegion = ev?.region ?? null;
  const inferredRegion = geo?.regions?.[0] ?? null;
  const region = inferredRegion && (!originalRegion || originalRegion === "REG:OTHER" || geoBundle.inferred) ? inferredRegion : originalRegion;

  return {
    archive_key: ev?.archive_key || eventArchiveKey(ev),
    number: ev?.number ?? null,
    id: ev?.id ?? null,
    ts: ev?.ts ?? null,
    chronology_ts: chronologyMs ? new Date(chronologyMs).toISOString() : null,
    issue_created_at: ev?.issue_created_at ?? ev?.ts ?? null,
    source_published_at: sourceHint.source_published_at ?? null,
    ingested_at: sourceHint.ingested_at ?? null,
    title: ev?.title ?? "",
    url: ev?.url ?? null,
    original_url: originalUrlFromEvent(ev) || ev?.original_url || ev?.source_url || ev?.link || null,
    labels,
    source_type: sourceType,
    category: ev?.category ?? null,
    region,
    severity: ev?.severity ?? null,
    confidence: ev?.confidence ?? null,
    phase0: ev?.phase0 ?? null,
    geo,
    geo_candidates: geoBundle.candidates?.length ? geoBundle.candidates : undefined,
    geo_inferred: geoBundle.inferred || undefined,
    source_hint: sourceHint,
    report_category: inferReportCategory(ev),
    greybook_rubric: inferGreybookRubric(ev),
    summary: shortText(ev?.summary ?? "", 1200)
  };
}

function scoreEventForHybrid(e) {
  const labels = Array.isArray(e?.labels) ? e.labels : [];
  const sev = e?.severity ?? "SEV:1";
  const conf = e?.confidence ?? "CONF:LOW";
  const sevW = sev === "SEV:4" ? 9 : sev === "SEV:3" ? 6 : sev === "SEV:2" ? 3 : 1;
  const confW = conf === "CONF:HIGH" ? 1.2 : conf === "CONF:MED" ? 1.0 : 0.8;
  let v = sevW * confW;
  if (e?.phase0?.suspect || labels.includes("P0:SUSPECT")) v *= 1.6;
  if (["OBJ:CABLE", "OBJ:PIPELINE", "OBJ:WINDFARM", "OBJ:PORT", "OBJ:VTS_WSV"].some(x => labels.includes(x))) v *= 1.25;
  if (["PAT:LOITERING", "PAT:STS_SUSPECT", "PAT:AIS_GAP", "PAT:DARK_ACTIVITY", "PAT:SURVEYING", "PAT:ROUTE_DEVIATION", "PAT:GNSS_JAM", "PAT:GNSS_SPOOF", "RF:GNSS_JAM", "RF:GNSS_SPOOF"].some(x => labels.includes(x))) v *= 1.20;
  if (["V:SHADOW_FLEET", "V:RUS_RESEARCH", "V:RUS_WARSHIP"].some(x => labels.includes(x))) v *= 1.15;
  return v;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function daysAgoMs(ms, now = Date.now()) {
  return (now - ms) / (1000 * 60 * 60 * 24);
}

function scorePhaseZero(events, now = Date.now()) {
  const recent = events.filter(e => {
    const ms = getEventChronologyMs(e);
    return ms && daysAgoMs(ms, now) <= 7;
  });
  const points = recent.reduce((sum, ev) => sum + scoreEventForHybrid(ev), 0);
  return clamp(Math.round((points / 90) * 100), 0, 100);
}

function scoreAuthorityWeirdness(events, regionMode, now = Date.now()) {
  const regionLabels = regionMode === "north" ? ["REG:NORTH_SEA", "REG:GER_BIGHT"] : ["REG:BALTIC_SEA", "REG:BALTIC"];
  const recent = events.filter(e => {
    const ms = getEventChronologyMs(e);
    const labels = Array.isArray(e?.labels) ? e.labels : [];
    const inWindow = ms && daysAgoMs(ms, now) <= 7;
    const regionHit = regionLabels.includes(e?.region) || labels.some(l => regionLabels.includes(l));
    return inWindow && regionHit;
  });
  let w = 0;
  const seen = new Set();
  for (const e of recent) {
    const labels = Array.isArray(e?.labels) ? e.labels : [];
    const key = e?.url || e?.id || e?.number || e?.archive_key || e?.title;
    if (seen.has(key)) continue;
    seen.add(key);
    const sev = e?.severity ?? "SEV:1";
    const conf = e?.confidence ?? "CONF:LOW";
    const sevW = sev === "SEV:4" ? 7 : sev === "SEV:3" ? 5 : sev === "SEV:2" ? 2.5 : 1;
    const confW = conf === "CONF:HIGH" ? 1.1 : conf === "CONF:MED" ? 1.0 : 0.85;
    const official = labels.includes("SRC:OFFICIAL");
    const authorityVessel = labels.some(l => String(l).startsWith("V:AUTH_") || ["V:SAR_UNIT", "V:RUS_GOV", "V:RUS_WARSHIP", "V:RUS_AUXILIARY", "V:RUS_RESEARCH"].includes(l));
    const air = labels.includes("D:AIR_ACTIVITY");
    const sar = labels.includes("D:SAR") || labels.includes("V:SAR_UNIT");
    const navwarn = labels.includes("RF:NAVWARN") || labels.includes("RF:NAVTEX");
    const rf = labels.includes("D:RF_SIGNAL") || labels.some(l => String(l).startsWith("RF:"));
    const ci = ["OBJ:PORT", "OBJ:VTS_WSV", "OBJ:CABLE", "OBJ:PIPELINE", "OBJ:WINDFARM"].some(x => labels.includes(x));
    let evW = sevW * confW;
    if (official) evW *= 1.20;
    if (authorityVessel) evW *= 1.55;
    if (air) evW *= 1.35;
    if (sar) evW *= 1.20;
    if (navwarn) evW *= 0.85;
    if (rf) evW *= 1.20;
    if (ci) evW *= 1.15;
    w += evW;
  }
  return clamp(Math.round((w / 45) * 100), 0, 100);
}

function countBy(values) {
  const out = {};
  for (const v of values.filter(Boolean)) out[v] = (out[v] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function topKeywordsForEvents(events, max = 10) {
  const scores = new Map();
  const keywords = [...KEYWORD_TIERS.hard, ...KEYWORD_TIERS.soft];
  for (const ev of events) {
    const text = normalizeText(`${ev?.title || ""} ${ev?.summary || ""} ${(ev?.labels || []).join(" ")}`);
    for (const kw of keywords) {
      const nk = normalizeText(kw);
      if (nk && text.includes(nk)) scores.set(kw, (scores.get(kw) || 0) + 1);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([keyword, count]) => ({ keyword, count }));
}

function buildDailySummaries(events, days = DAILY_SUMMARY_DAYS, now = Date.now()) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const groups = new Map();
  for (const ev of events) {
    const ms = getEventChronologyMs(ev);
    if (!ms || ms < cutoff) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(ev);
  }

  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, dayEvents]) => {
    const hybridRaw = dayEvents.reduce((sum, ev) => sum + scoreEventForHybrid(ev), 0);
    const northEvents = dayEvents.filter(ev => {
      const labels = ev.labels || [];
      return ev.region === "REG:NORTH_SEA" || ev.region === "REG:GER_BIGHT" || labels.includes("REG:NORTH_SEA") || labels.includes("REG:GER_BIGHT");
    });
    const balticEvents = dayEvents.filter(ev => {
      const labels = ev.labels || [];
      return ev.region === "REG:BALTIC_SEA" || ev.region === "REG:BALTIC" || labels.includes("REG:BALTIC_SEA") || labels.includes("REG:BALTIC");
    });
    return {
      date,
      events_total: dayEvents.length,
      p0_suspect: dayEvents.filter(ev => ev.phase0?.suspect || (ev.labels || []).includes("P0:SUSPECT")).length,
      geo_events: dayEvents.filter(ev => !!ev.geo).length,
      social_events: dayEvents.filter(ev => String(ev.source_type || "").startsWith("social") || (ev.labels || []).includes("SRC:SOCIAL")).length,
      social_geo_events: dayEvents.filter(ev => !!ev.geo && (String(ev.source_type || "").startsWith("social") || (ev.labels || []).includes("SRC:SOCIAL"))).length,
      rss_media_events: dayEvents.filter(ev => ["rss", "media"].includes(ev.source_type) || (ev.labels || []).includes("SRC:MEDIA")).length,
      top_domains: countBy(dayEvents.map(ev => ev.category)),
      top_regions: countBy(dayEvents.map(ev => ev.region)),
      severity: countBy(dayEvents.map(ev => ev.severity)),
      hybrid_index_proxy: clamp(Math.round((hybridRaw / 70) * 100), 0, 100),
      government_weirdness_proxy: {
        north_sea: clamp(Math.round((northEvents.reduce((sum, ev) => sum + scoreEventForHybrid(ev), 0) / 35) * 100), 0, 100),
        baltic_sea: clamp(Math.round((balticEvents.reduce((sum, ev) => sum + scoreEventForHybrid(ev), 0) / 35) * 100), 0, 100)
      },
      top_keywords: topKeywordsForEvents(dayEvents, 8)
    };
  });
}

function isSocialOrRss(e) {
  const labels = e?.labels ?? [];
  const text = normalizeText(`${e?.summary ?? ""} ${e?.title ?? ""}`);
  return labels.includes("SRC:SOCIAL") || labels.includes("SRC:MEDIA") || text.includes("### plattform\nrss") || text.includes("platform: rss");
}

function keywordHits(text) {
  const t = normalizeText(text);
  let hard = 0;
  let soft = 0;
  for (const kw of KEYWORD_TIERS.hard) if (t.includes(normalizeText(kw))) hard++;
  for (const kw of KEYWORD_TIERS.soft) if (t.includes(normalizeText(kw))) soft++;
  return { hard, soft, score: hard * 3 + soft };
}

function buildKeywordBuckets(events, now = Date.now()) {
  const bucketMs = 3 * 60 * 60 * 1000;
  const bucketCount = 24;
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({ idx: i, score: 0, hits: 0, sources: new Set() }));
  const dedupe = new Set();
  for (const e of events) {
    if (!isSocialOrRss(e)) continue;
    const eventMs = getEventChronologyMs(e);
    if (!eventMs) continue;
    const age = now - eventMs;
    if (age < 0 || age > bucketMs * bucketCount) continue;
    const key = e.url || e.id || e.number || e.archive_key || `${e.title}${e.ts || ""}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const b = bucketCount - 1 - Math.floor(age / bucketMs);
    if (b < 0 || b >= bucketCount) continue;
    const kh = keywordHits(`${e.title ?? ""} ${e.summary ?? ""} ${(e.labels ?? []).join(" ")}`);
    if (kh.score <= 0) continue;
    buckets[b].score += kh.score;
    buckets[b].hits += kh.hard + kh.soft;
    buckets[b].sources.add((e.labels ?? []).includes("SRC:SOCIAL") ? "social" : "rss/media");
  }
  return buckets.map(b => ({ ...b, sources: b.sources.size }));
}

function buildSensorSnapshot(events, generatedAt = new Date()) {
  const now = generatedAt.getTime();
  const keywordBuckets = buildKeywordBuckets(events, now);
  const keywordScore = keywordBuckets.reduce((sum, b) => sum + b.score, 0);
  const keywordHitsTotal = keywordBuckets.reduce((sum, b) => sum + b.hits, 0);
  const keywordBarometerPct = clamp(Math.round((keywordScore / 130) * 100), 0, 100);
  const events72h = events.filter(e => {
    const ms = getEventChronologyMs(e);
    return ms && now - ms >= 0 && now - ms <= 72 * 60 * 60 * 1000;
  });
  const snapshotKeyDate = new Date(generatedAt);
  snapshotKeyDate.setUTCMinutes(0, 0, 0);
  snapshotKeyDate.setUTCHours(Math.floor(snapshotKeyDate.getUTCHours() / 6) * 6);
  return {
    snapshot_schema: "MAGIC_PAWS_SENSOR_SNAPSHOT_v1",
    snapshot_key: snapshotKeyDate.toISOString(),
    generated_at: generatedAt.toISOString(),
    source: {
      worker_base: WORKER_BASE,
      bundle_url: BUNDLE_URL
    },
    counts: {
      events_total_archive: events.length,
      events_72h: events72h.length,
      p0_suspect_72h: events72h.filter(e => e?.phase0?.suspect || (e?.labels || []).includes("P0:SUSPECT")).length,
      geo_72h: events72h.filter(e => !!e.geo).length,
      social_72h: events72h.filter(e => String(e.source_type || "").startsWith("social") || (e.labels || []).includes("SRC:SOCIAL")).length,
      social_geo_72h: events72h.filter(e => !!e.geo && (String(e.source_type || "").startsWith("social") || (e.labels || []).includes("SRC:SOCIAL"))).length,
      rss_media_72h: events72h.filter(e => ["rss", "media"].includes(e.source_type) || (e.labels || []).includes("SRC:MEDIA")).length
    },
    sensors: {
      hybrid_index_pct: scorePhaseZero(events, now),
      government_weirdness: {
        north_sea_pct: scoreAuthorityWeirdness(events, "north", now),
        baltic_sea_pct: scoreAuthorityWeirdness(events, "baltic", now)
      },
      keyword_barometer_pct: keywordBarometerPct,
      keyword_hits_72h: keywordHitsTotal
    },
    density: {
      domains_72h: countBy(events72h.map(e => e.category)),
      regions_72h: countBy(events72h.map(e => e.region)),
      top_keywords_72h: topKeywordsForEvents(events72h, 12)
    }
  };
}

async function ensureDirs() {
  await Promise.all([OUT.logsDir, OUT.archiveDir, OUT.snapshotsDir].map(dir => fs.mkdir(dir, { recursive: true })));
}

async function readJsonIfExists(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function readJsonlIfExists(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function readExistingArchiveEvents() {
  const events = [];

  const active = await readJsonIfExists(OUT.active20d, null);
  if (Array.isArray(active?.events)) events.push(...active.events);

  try {
    const names = await fs.readdir(OUT.archiveDir);
    for (const name of names) {
      if (!/^magicpaws_\d{4}-\d{2}\.jsonl$/.test(name)) continue;
      const fileEvents = await readJsonlIfExists(path.join(OUT.archiveDir, name));
      events.push(...fileEvents);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  return events;
}

async function fetchBundle() {
  const headers = { "User-Agent": "MagicPaws-LogArchive-GitHubAction/1.0" };
  if (process.env.MAGIC_PAWS_BUNDLE_BEARER_TOKEN) headers.Authorization = `Bearer ${process.env.MAGIC_PAWS_BUNDLE_BEARER_TOKEN}`;
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }

  const res = await fetch(BUNDLE_URL, { headers, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bundle fetch failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Bundle response was not valid JSON: ${err.message}; head=${text.slice(0, 300)}`);
  }
  if (data?.ok === false) throw new Error(data.error || data.message || "bundle returned ok=false");
  return data;
}

function mergeEvents(...eventLists) {
  const byKey = new Map();
  for (const list of eventLists) {
    for (const raw of Array.isArray(list) ? list : []) {
      const c = compactEvent(raw);
      const key = c.archive_key || eventArchiveKey(c);
      const previous = byKey.get(key);
      if (!previous || getEventChronologyMs(c) >= getEventChronologyMs(previous)) {
        byKey.set(key, c);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => getEventChronologyMs(b) - getEventChronologyMs(a));
}

function groupByMonth(events) {
  const groups = new Map();
  for (const ev of events) {
    const ms = getEventChronologyMs(ev) || Date.now();
    const month = new Date(ms).toISOString().slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(ev);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function writeJsonl(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = events
    .sort((a, b) => getEventChronologyMs(b) - getEventChronologyMs(a))
    .map(ev => JSON.stringify(ev));
  await fs.writeFile(file, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

async function updateSensorHistory(snapshot) {
  let lines = [];
  try {
    lines = (await fs.readFile(OUT.sensorHistory, "utf8")).split(/\r?\n/).filter(Boolean);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const byKey = new Map();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      byKey.set(obj.snapshot_key || obj.generated_at || String(byKey.size), obj);
    } catch (_err) {
      // Drop corrupt lines rather than poisoning the archive forever.
    }
  }
  byKey.set(snapshot.snapshot_key, snapshot);
  const next = [...byKey.values()]
    .sort((a, b) => String(a.snapshot_key || a.generated_at).localeCompare(String(b.snapshot_key || b.generated_at)))
    .slice(-SNAPSHOT_KEEP_LINES)
    .map(obj => JSON.stringify(obj));
  await fs.writeFile(OUT.sensorHistory, `${next.join("\n")}${next.length ? "\n" : ""}`, "utf8");
}

async function main() {
  await ensureDirs();
  const generatedAt = new Date();
  console.log(`[magicpaws] Fetching bundle: ${BUNDLE_URL}`);
  const bundle = await fetchBundle();
  const liveEvents = Array.isArray(bundle.events) ? bundle.events : [];
  console.log(`[magicpaws] Live events from Worker: ${liveEvents.length}`);

  const existingEvents = await readExistingArchiveEvents();
  console.log(`[magicpaws] Existing repository events: ${existingEvents.length}`);

  const merged = mergeEvents(existingEvents, liveEvents);
  const activeCutoff = generatedAt.getTime() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const activeEvents = merged.filter(ev => {
    const ms = getEventChronologyMs(ev);
    return ms && ms >= activeCutoff;
  });
  const dailySummary = buildDailySummaries(merged, DAILY_SUMMARY_DAYS, generatedAt.getTime());
  const sensorSnapshot = buildSensorSnapshot(merged, generatedAt);

  await writeJson(OUT.active20d, {
    schema: "MAGIC_PAWS_EVENTS_20D_v1",
    generated_at: generatedAt.toISOString(),
    worker_base: WORKER_BASE,
    source: bundle.source ?? null,
    bundle_generated_at: bundle.generated_at ?? null,
    window: {
      days: ACTIVE_WINDOW_DAYS,
      cutoff_utc: new Date(activeCutoff).toISOString()
    },
    counts: {
      live_events_from_worker: liveEvents.length,
      archive_events_total: merged.length,
      active_events: activeEvents.length,
      active_geo_events: activeEvents.filter(e => !!e.geo).length,
      active_social_events: activeEvents.filter(e => String(e.source_type || "").startsWith("social") || (e.labels || []).includes("SRC:SOCIAL")).length,
      active_social_geo_events: activeEvents.filter(e => !!e.geo && (String(e.source_type || "").startsWith("social") || (e.labels || []).includes("SRC:SOCIAL"))).length
    },
    events: activeEvents
  });

  const manifestMonths = [];
  for (const [month, events] of groupByMonth(merged)) {
    const filename = `magicpaws_${month}.jsonl`;
    const file = path.join(OUT.archiveDir, filename);
    await writeJsonl(file, events);
    const sortedMs = events.map(getEventChronologyMs).filter(Boolean).sort((a, b) => a - b);
    manifestMonths.push({
      month,
      file: `data/archive/${filename}`,
      count: events.length,
      first_utc: sortedMs.length ? new Date(sortedMs[0]).toISOString() : null,
      last_utc: sortedMs.length ? new Date(sortedMs[sortedMs.length - 1]).toISOString() : null
    });
  }

  await writeJson(OUT.manifest, {
    schema: "MAGIC_PAWS_ARCHIVE_MANIFEST_v1",
    generated_at: generatedAt.toISOString(),
    worker_base: WORKER_BASE,
    total_events: merged.length,
    total_geo_events: merged.filter(e => !!e.geo).length,
    total_social_events: merged.filter(e => String(e.source_type || "").startsWith("social") || (e.labels || []).includes("SRC:SOCIAL")).length,
    total_social_geo_events: merged.filter(e => !!e.geo && (String(e.source_type || "").startsWith("social") || (e.labels || []).includes("SRC:SOCIAL"))).length,
    active_window_days: ACTIVE_WINDOW_DAYS,
    daily_summary_days: DAILY_SUMMARY_DAYS,
    months: manifestMonths.sort((a, b) => b.month.localeCompare(a.month))
  });

  await writeJson(OUT.dailySummary, {
    schema: "MAGIC_PAWS_DAILY_SUMMARY_v1",
    generated_at: generatedAt.toISOString(),
    worker_base: WORKER_BASE,
    days: dailySummary.length,
    summary_window_days: DAILY_SUMMARY_DAYS,
    daily_summary: dailySummary
  });

  await writeJson(OUT.sensorLatest, sensorSnapshot);
  await updateSensorHistory(sensorSnapshot);

  console.log(`[magicpaws] Wrote active=${activeEvents.length}, archive_total=${merged.length}, daily_days=${dailySummary.length}`);
  console.log(`[magicpaws] Latest sensor snapshot: ${sensorSnapshot.snapshot_key}`);
}

main().catch(err => {
  console.error("[magicpaws] FAILED", err);
  process.exit(1);
});
