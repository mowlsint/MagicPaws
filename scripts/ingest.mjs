/**
 * MAGIC PAWS // MARITIME PHASE ZERO
 * ingest.mjs
 *
 * Reads config/sources.yml and creates GitHub issues from RSS/Atom feeds
 * and optional social bridge sources.
 *
 * Requirements in GitHub Action:
 *   npm install yaml fast-xml-parser
 *
 * Required env:
 *   GITHUB_TOKEN
 *
 * Optional env:
 *   GITHUB_REPOSITORY      normally set by GitHub Actions, e.g. mowlsint/MagicPaws
 *   SOURCES_FILE           default: config/sources.yml
 *   SOCIAL_BRIDGE_BASE     fallback for social_x/social_bsky bridge_path
 *   MAX_ITEMS_PER_SOURCE   fallback default: 15
 *   MAX_RSS_ITEMS_PER_SOURCE fallback for RSS sources; default follows MAX_ITEMS_PER_SOURCE
 *   MAX_SOCIAL_ITEMS_PER_SOURCE fallback for social sources; default 30
 *   DEFAULT_LOOKBACK_HOURS optional age gate for all sources without source.lookback_hours
 *   MAX_EXISTING_ISSUES    fallback default: 1000
 *   DRY_RUN                "1" = do not create issues
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import YAML from "yaml";
import { XMLParser } from "fast-xml-parser";

const VERSION = 'MAGIC PAWS ingest v5.33 "TJ Geo + Gov Weirdness Correlation Metadata"';

const SOURCES_FILE = process.env.SOURCES_FILE || "config/sources.yml";
const DEFAULT_SOCIAL_BRIDGE_BASE =
  process.env.SOCIAL_BRIDGE_BASE ||
  "https://voodoo-social-bridge.mowlsint.workers.dev";

const MAX_ITEMS_PER_SOURCE = Number(process.env.MAX_ITEMS_PER_SOURCE || 15);
const MAX_RSS_ITEMS_PER_SOURCE = Number(process.env.MAX_RSS_ITEMS_PER_SOURCE || MAX_ITEMS_PER_SOURCE);
const MAX_SOCIAL_ITEMS_PER_SOURCE = Number(process.env.MAX_SOCIAL_ITEMS_PER_SOURCE || 30);
const DEFAULT_LOOKBACK_HOURS = Number(process.env.DEFAULT_LOOKBACK_HOURS || 0);
const MAX_EXISTING_ISSUES = Number(process.env.MAX_EXISTING_ISSUES || 1000);
const DRY_RUN = process.env.DRY_RUN === "1";

const NTFY_ENABLED = String(process.env.NTFY_ENABLED || "").toLowerCase() === "true" || process.env.NTFY_ENABLED === "1";
const NTFY_URL = String(process.env.NTFY_URL || "").trim().replace(/^["\'`]+|["\'`]+$/g, "").trim();
const NTFY_TOKEN = String(process.env.NTFY_TOKEN || "").trim().replace(/^["\'`]+|["\'`]+$/g, "").trim();
const NTFY_MIN_LEVEL = String(process.env.NTFY_MIN_LEVEL || "HIGH").toUpperCase();
// Source-level fetch/item errors should not make the whole hourly GitHub Action red by default.
// Set FAIL_ON_SOURCE_ERRORS=1 only when you explicitly want strict CI behavior.
const FAIL_ON_SOURCE_ERRORS = process.env.FAIL_ON_SOURCE_ERRORS === "1";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "mowlsint/MagicPaws";
const [OWNER, REPO] = GITHUB_REPOSITORY.split("/");

if (!OWNER || !REPO) {
  throw new Error(`Invalid GITHUB_REPOSITORY: ${GITHUB_REPOSITORY}`);
}

if (!GITHUB_TOKEN && !DRY_RUN) {
  throw new Error("GITHUB_TOKEN missing. Set it in the GitHub Action env.");
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: false
});

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sha256Short(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function asPlainText(value) {
  if (value == null) return "";

  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value.map(asPlainText).filter(Boolean).join(" ").trim();
  }

  if (typeof value === "object") {
    return String(
      value["#cdata"] ??
      value["#text"] ??
      value._text ??
      value.text ??
      value.value ??
      value.href ??
      ""
    ).trim();
  }

  return String(value).trim();
}

function stripHtml(value) {
  return asPlainText(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function truncate(value, max = 4000) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return text.slice(0, max - 20).trimEnd() + "\n\n[…gekürzt]";
}

function normalizeUrl(url) {
  const raw = asPlainText(url);
  if (!raw) return "";

  try {
    const u = new URL(raw);

    const removeParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "igshid"
    ];

    for (const p of removeParams) u.searchParams.delete(p);

    u.hash = "";
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function toIsoDateOrNull(value) {
  const raw = asPlainText(value);
  if (!raw) return null;

  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;

  return d.toISOString();
}

function pickSourcePublishedAt(item) {
  return (
    toIsoDateOrNull(item?.source_published_at) ||
    toIsoDateOrNull(item?.published_at) ||
    toIsoDateOrNull(item?.publishedAt) ||
    toIsoDateOrNull(item?.pubDate) ||
    toIsoDateOrNull(item?.pubdate) ||
    toIsoDateOrNull(item?.isoDate) ||
    toIsoDateOrNull(item?.published) ||
    toIsoDateOrNull(item?.updated) ||
    toIsoDateOrNull(item?.date) ||
    toIsoDateOrNull(item?.created) ||
    toIsoDateOrNull(item?.created_at) ||
    toIsoDateOrNull(item?.timestamp) ||
    toIsoDateOrNull(item?.ts) ||
    toIsoDateOrNull(item?.["dc:date"]) ||
    toIsoDateOrNull(item?.["atom:updated"]) ||
    null
  );
}

function yamlScalarArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map(x => x.trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (values || [])
        .map(x => String(x || "").trim())
        .filter(Boolean)
    )
  );
}

function sourceType(sourceOrType) {
  const value = typeof sourceOrType === "string" ? sourceOrType : sourceOrType?.type;
  return String(value || "").trim().toLowerCase();
}

function isRssType(type) {
  const t = sourceType(type);
  return ["rss", "atom", "feed"].includes(t);
}

function isSocialType(type) {
  const t = sourceType(type);
  return ["social_x", "x", "twitter", "social_bsky", "bsky", "bluesky"].includes(t);
}

function isBskyType(type) {
  const t = sourceType(type);
  return ["social_bsky", "bsky", "bluesky"].includes(t);
}

function isXType(type) {
  const t = sourceType(type);
  return ["social_x", "x", "twitter"].includes(t);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function itemAgeHours(item, nowMs = Date.now()) {
  const iso = pickSourcePublishedAt(item);
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (nowMs - ms) / 36e5);
}


// -----------------------------------------------------------------------------
// Geo / route evidence helpers for route-source social posts
// -----------------------------------------------------------------------------
const ROUTE_GAZETTEER = [
  { id:"port_ust_luga", name:"Ust-Luga", lat:59.67, lon:28.26, aliases:["ust-luga","ust luga","port of ust-luga","port ust-luga","ust-luga terminal"], regions:["REG:BALTIC","REG:GULF_OF_FINLAND","REG:RUSSIA_BALTIC"], type:"port" },
  { id:"strait_gibraltar", name:"Strait of Gibraltar", lat:35.96, lon:-5.55, aliases:["strait of gibraltar","gibraltar strait","gibraltar"], regions:["REG:MEDITERRANEAN","REG:STRAIT_GIBRALTAR"], type:"strait" },
  { id:"suez_canal", name:"Suez Canal", lat:29.97, lon:32.55, aliases:["suez canal","suez","port said","suez anchorage"], regions:["REG:SUEZ","REG:RED_SEA","REG:MEDITERRANEAN"], type:"chokepoint" },
  { id:"bab_el_mandeb", name:"Bab el-Mandeb", lat:12.61, lon:43.33, aliases:["bab el-mandeb","bab al-mandab","bab el mandeb","bab al mandab"], regions:["REG:BAB_EL_MANDEB","REG:RED_SEA"], type:"strait" },
  { id:"strait_hormuz", name:"Strait of Hormuz", lat:26.57, lon:56.25, aliases:["strait of hormuz","hormuz strait","hormuz"], regions:["REG:PERSIAN_GULF","REG:STRAIT_HORMUZ"], type:"strait" },
  { id:"gulf_of_oman", name:"Gulf of Oman", lat:24.8, lon:58.4, aliases:["gulf of oman","goo"], regions:["REG:GULF_OF_OMAN"], type:"sea_area" },
  { id:"gulf_of_aden", name:"Gulf of Aden", lat:12.5, lon:48.0, aliases:["gulf of aden","goa"], regions:["REG:GULF_OF_ADEN"], type:"sea_area" },
  { id:"malacca_strait", name:"Malacca Strait", lat:3.0, lon:100.5, aliases:["malacca strait","strait of malacca","malacca"], regions:["REG:MALACCA_STRAIT"], type:"strait" },
  { id:"singapore_strait", name:"Singapore Strait", lat:1.2, lon:103.75, aliases:["singapore strait","strait of singapore","singapore"], regions:["REG:SINGAPORE_STRAIT"], type:"strait" },
  { id:"port_skagen", name:"Skagen", lat:57.72, lon:10.59, aliases:["skagen"], regions:["REG:NORTH_SEA","REG:SKAGERRAK","REG:DANISH_STRAITS"], type:"port_chokepoint" },
  { id:"kattegat", name:"Kattegat", lat:57.0, lon:11.5, aliases:["kattegat"], regions:["REG:KATTEGAT","REG:DANISH_STRAITS"], type:"sea_area" },
  { id:"oresund", name:"Øresund", lat:55.9, lon:12.75, aliases:["øresund","oresund","oeresund","the sound"], regions:["REG:ORESUND","REG:BALTIC","REG:DANISH_STRAITS"], type:"strait" },
  { id:"bornholm", name:"Bornholm", lat:55.12, lon:14.92, aliases:["bornholm"], regions:["REG:BALTIC"], type:"island_area" },
  { id:"gotland", name:"Gotland", lat:57.5, lon:18.55, aliases:["gotland"], regions:["REG:BALTIC","REG:GOTLAND_SEA"], type:"island_area" },
  { id:"port_rotterdam", name:"Rotterdam", lat:51.948, lon:4.142, aliases:["rotterdam","port of rotterdam","maasvlakte"], regions:["REG:NORTH_SEA"], type:"port" },
  { id:"port_antwerp", name:"Antwerp", lat:51.286, lon:4.315, aliases:["antwerp","antwerpen","port of antwerp","antwerp-bruges"], regions:["REG:NORTH_SEA","REG:CHANNEL"], type:"port" },
  { id:"port_fujairah", name:"Fujairah", lat:25.18, lon:56.36, aliases:["fujairah","port of fujairah","fujairah anchorage"], regions:["REG:GULF_OF_OMAN","REG:PERSIAN_GULF"], type:"port" },
  { id:"port_algeciras", name:"Algeciras", lat:36.14, lon:-5.44, aliases:["algeciras","port of algeciras"], regions:["REG:STRAIT_GIBRALTAR","REG:MEDITERRANEAN"], type:"port" },
  { id:"port_tanger_med", name:"Tanger Med", lat:35.89, lon:-5.51, aliases:["tanger med","tangier med","port of tanger med"], regions:["REG:STRAIT_GIBRALTAR","REG:MEDITERRANEAN"], type:"port" },
  { id:"port_santos", name:"Santos", lat:-23.96, lon:-46.31, aliases:["santos","port of santos"], regions:["REG:SOUTH_AMERICA_EAST"], type:"port", requireContext:["port","container","cocaine","shipping","vessel","ship","terminal"] },
  { id:"port_cartagena_colombia", name:"Cartagena (Colombia)", lat:10.40, lon:-75.53, aliases:["cartagena colombia","cartagena de indias","port of cartagena"], regions:["REG:CARIBBEAN","REG:SOUTH_AMERICA_NORTH"], type:"port", requireContext:["colombia","port","container","cocaine","caribbean","vessel","ship"] },
  { id:"port_guayaquil", name:"Guayaquil", lat:-2.27, lon:-79.91, aliases:["guayaquil","port of guayaquil"], regions:["REG:SOUTH_AMERICA_WEST"], type:"port" },
  { id:"port_abidjan", name:"Abidjan", lat:5.26, lon:-4.02, aliases:["abidjan","port of abidjan"], regions:["REG:GULF_OF_GUINEA"], type:"port" },
  { id:"port_tema", name:"Tema", lat:5.64, lon:0.01, aliases:["tema","port of tema"], regions:["REG:GULF_OF_GUINEA"], type:"port" },
  { id:"port_lome", name:"Lomé", lat:6.13, lon:1.28, aliases:["lomé","lome","port of lome","port of lomé"], regions:["REG:GULF_OF_GUINEA"], type:"port" }
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function geoValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function dmsToDecimal(deg, min = 0, sec = 0, hemi = "") {
  let v = Number(deg) + Number(min || 0) / 60 + Number(sec || 0) / 3600;
  if (/S|W/i.test(hemi)) v *= -1;
  return v;
}

function extractCoordinatePairs(text) {
  const t = String(text || "").replace(/(\d),(\d)/g, "$1.$2");
  const out = [];
  const seen = new Set();
  function add(lat, lon, raw, method = "explicit_coordinate") {
    lat = Number(lat); lon = Number(lon);
    if (!geoValidLatLon(lat, lon)) return;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ lat, lon, raw: String(raw || "").slice(0, 120), method, confidence:"high", precision:"exact" });
  }

  const latLon = /(?:geo|position|pos|lat\/?lon|lat\s*[,=])?\s*[:=]?\s*(-?\d{1,2}\.\d{3,})\s*[,; ]\s*(?:lon\s*[:=]\s*)?(-?\d{1,3}\.\d{3,})/gi;
  for (const m of t.matchAll(latLon)) add(m[1], m[2], m[0]);

  const named = /lat(?:itude)?\s*[:=]\s*(-?\d{1,2}\.\d+)\D{1,30}lon(?:gitude)?\s*[:=]\s*(-?\d{1,3}\.\d+)/gi;
  for (const m of t.matchAll(named)) add(m[1], m[2], m[0]);

  const dm = /(\d{1,2})[°\s-]+(\d{1,2}(?:\.\d+)?)\s*([NS])\b[^\dNSWE]{0,16}(\d{1,3})[°\s-]+(\d{1,2}(?:\.\d+)?)\s*([EW])\b/gi;
  for (const m of t.matchAll(dm)) add(dmsToDecimal(m[1], m[2], 0, m[3]), dmsToDecimal(m[4], m[5], 0, m[6]), m[0], "dm_coordinate");

  const dms = /(\d{1,2})[°\s]+(\d{1,2})['’\s]+(\d{1,2}(?:\.\d+)?)?["”]?\s*([NS])\b[^\dNSWE]{0,16}(\d{1,3})[°\s]+(\d{1,2})['’\s]+(\d{1,2}(?:\.\d+)?)?["”]?\s*([EW])\b/gi;
  for (const m of t.matchAll(dms)) add(dmsToDecimal(m[1], m[2], m[3] || 0, m[4]), dmsToDecimal(m[5], m[6], m[7] || 0, m[8]), m[0], "dms_coordinate");

  // Morse/weather-position shorthand often appears as DDMMN DDDMME, DD MM N DDD MM E,
  // or N DD MM E DDD MM. Treat minute-level positions as plausible vessel positions.
  const compactDm = /\b(\d{2})(\d{2}(?:\.\d+)?)\s*([NS])\b[^\dNSWE]{0,18}\b(\d{3})(\d{2}(?:\.\d+)?)\s*([EW])\b/gi;
  for (const m of t.matchAll(compactDm)) add(dmsToDecimal(m[1], m[2], 0, m[3]), dmsToDecimal(m[4], m[5], 0, m[6]), m[0], "morse_weather_dm_coordinate");

  const spacedDm = /\b(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([NS])\b[^\dNSWE]{0,18}\b(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\s*([EW])\b/gi;
  for (const m of t.matchAll(spacedDm)) add(dmsToDecimal(m[1], m[2], 0, m[3]), dmsToDecimal(m[4], m[5], 0, m[6]), m[0], "morse_weather_spaced_dm_coordinate");

  const hemiFirstDm = /\b([NS])\s*(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\b[^\dNSWE]{0,18}\b([EW])\s*(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\b/gi;
  for (const m of t.matchAll(hemiFirstDm)) add(dmsToDecimal(m[2], m[3], 0, m[1]), dmsToDecimal(m[5], m[6], 0, m[4]), m[0], "morse_weather_hemi_first_dm_coordinate");

  return out.slice(0, 16);
}

function suppressPlaceFalsePositive(place, textLower) {
  if (place.id === "port_hull" || place.name?.toLowerCase() === "hull") {
    if (/\b(ship|vessel|carrier|tanker|bulk carrier|container ship|lpg carrier)\b.{0,24}\bhull\b|\bhull\b.{0,30}\b(attached|damage|breach|ship|vessel|carrier|tanker)\b/i.test(textLower)) return true;
  }
  if (Array.isArray(place.requireContext) && place.requireContext.length) {
    return !place.requireContext.some(c => textLower.includes(String(c).toLowerCase()));
  }
  return false;
}

function extractPlaceHits(text) {
  const raw = String(text || "");
  const low = raw.toLowerCase();
  const hits = [];
  const seen = new Set();
  for (const place of ROUTE_GAZETTEER) {
    if (suppressPlaceFalsePositive(place, low)) continue;
    for (const alias of place.aliases || []) {
      const a = String(alias || "").toLowerCase();
      if (!a || a.length < 3) continue;
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(a)}([^a-z0-9]|$)`, "i");
      if (!re.test(raw)) continue;
      if (seen.has(place.id)) continue;
      seen.add(place.id);
      const portContext = /\b(port|terminal|anchorage|arriv|depart|sail|transit|passed|heading|destination|eta|ais|vessel|ship|tanker|carrier|warship|naval|fleet|lng|lpg|oil|shadow|sanction)/i.test(raw);
      hits.push({
        matched_id: place.id,
        matched_name: place.name,
        matched_alias: alias,
        lat: place.lat,
        lon: place.lon,
        radius_km: place.type === "port" ? 18 : 60,
        precision: place.type === "port" ? "port" : "area",
        method: "controlled_gazetteer",
        confidence: portContext ? "medium_high" : "medium",
        geo_role: "event_location_or_topic_area",
        display_on_map: true,
        regions: place.regions || [],
        score: portContext ? 90 : 70
      });
    }
  }
  return hits.sort((a,b) => (b.score||0)-(a.score||0)).slice(0, 8);
}

function roleForWaypoint(text, hit, index, total) {
  const low = String(text || "").toLowerCase();
  const name = String(hit.matched_alias || hit.matched_name || "").toLowerCase();
  const near = new RegExp(`(?:from|depart(?:ed|ing)?|left)\\s+(?:the\\s+)?${escapeRegex(name)}|${escapeRegex(name)}.{0,35}(?:depart|left|sailed)`, "i");
  if (near.test(low)) return "origin";
  const dest = new RegExp(`(?:to|towards|toward|heading\\s+to|destination|dest)\\s+(?:the\\s+)?${escapeRegex(name)}|${escapeRegex(name)}.{0,35}(?:destination|eta|arrival|arriv)`, "i");
  if (dest.test(low)) return "destination";
  if (/\bvia\b|\bpassed\b|\btransit/.test(low)) return "via";
  if (total > 1 && index === 0) return "origin_or_first_reported";
  if (total > 1 && index === total - 1) return "destination_or_last_reported";
  return "candidate_anchor";
}

function extractGeoEvidence(text, item = {}, source = {}) {
  const fullText = [text, item?.title, item?.summary, item?.description].filter(Boolean).join("\n");
  const coordinates = extractCoordinatePairs(fullText);
  const candidates = extractPlaceHits(fullText);
  const routeSource = Boolean(source.route_source || source.routeSource || yamlScalarArray(source.labels).includes("PAT:ROUTE_OBSERVED") || yamlScalarArray(source.labels).includes("D:AIS_TRACK"));
  const waypoints = [];

  if (coordinates.length >= 2) {
    for (const [i, c] of coordinates.entries()) waypoints.push({ name:`Coordinate ${i+1}`, lat:c.lat, lon:c.lon, role:i === 0 ? "origin_or_first_reported" : i === coordinates.length-1 ? "destination_or_last_reported" : "via", method:c.method, confidence:c.confidence });
  } else if (routeSource && candidates.length >= 2) {
    candidates.slice(0, 5).forEach((c, i) => waypoints.push({ name:c.matched_name, id:c.matched_id, lat:c.lat, lon:c.lon, role:roleForWaypoint(fullText, c, i, candidates.length), method:c.method, confidence:c.confidence }));
  }

  let geo = null;
  if (coordinates.length) {
    const c = coordinates[0];
    geo = { lat:c.lat, lon:c.lon, precision:c.precision, method:c.method, matched_name:"explicit coordinate", matched_id:null, radius_km:null, confidence:c.confidence, geo_role:"event_location", display_on_map:true };
  } else if (routeSource && candidates.length === 1 && candidates[0].score >= 85) {
    const c = candidates[0];
    geo = { lat:c.lat, lon:c.lon, precision:c.precision, method:"controlled_port_promotion", matched_name:c.matched_name, matched_id:c.matched_id, radius_km:c.radius_km, confidence:c.confidence, geo_role:"event_location_or_topic_area", display_on_map:true };
  } else if (routeSource && waypoints.length) {
    const w = waypoints[0];
    geo = { lat:w.lat, lon:w.lon, precision:"route_waypoint", method:"social_route_waypoint", matched_name:w.name, matched_id:w.id || null, radius_km:null, confidence:w.confidence || "medium_high", geo_role:"event_location_or_topic_area", display_on_map:true };
  }

  const route = waypoints.length >= 2 ? {
    type:"LineString",
    coordinates: waypoints.map(w => [Number(w.lon), Number(w.lat)]),
    waypoints,
    method: coordinates.length >= 2 ? "explicit_coordinate_route" : "controlled_text_route",
    confidence: coordinates.length >= 2 ? "high" : "medium_high",
    display_on_map: true,
    inferred: coordinates.length < 2
  } : null;

  return { geo, coordinates, geo_candidates: candidates, route, hasMap: Boolean(geo || route || candidates.length) };
}

function itemWithinLookback(source, item) {
  const explicit = numberOrNull(source.lookback_hours ?? source.lookbackHours);
  const fallback = DEFAULT_LOOKBACK_HOURS > 0 ? DEFAULT_LOOKBACK_HOURS : null;
  const lookback = explicit ?? fallback;
  if (!lookback || lookback <= 0) return true;

  const age = itemAgeHours(item);
  if (age === null) {
    // Keep undated items unless the source explicitly forbids backfill.
    return source.allow_backfill === false ? false : true;
  }

  return age <= lookback;
}

function maxItemsForSource(source) {
  const explicit = numberOrNull(source.max_items ?? source.max_items_per_run ?? source.limit);
  if (explicit !== null && explicit > 0) return explicit;
  if (isSocialType(source)) return MAX_SOCIAL_ITEMS_PER_SOURCE;
  if (isRssType(source)) return MAX_RSS_ITEMS_PER_SOURCE;
  return MAX_ITEMS_PER_SOURCE;
}

function safeIssueTitle(title, prefix = "") {
  const t = stripHtml(title).replace(/\s+/g, " ").trim() || "Untitled maritime source item";
  const full = `${prefix}${t}`.trim();
  return full.length <= 240 ? full : full.slice(0, 237).trimEnd() + "…";
}

function labelColorFor(label) {
  if (label.startsWith("SRC:")) return "7057ff";
  if (label.startsWith("D:")) return "d93f0b";
  if (label.startsWith("REG:")) return "0e8a16";
  if (label.startsWith("CONF:")) return "5319e7";
  if (label.startsWith("SEV:")) return "fbca04";
  if (label.startsWith("MAP:")) return "cfd3d7";
  if (label.startsWith("DECAY:")) return "bfdadc";
  if (label.startsWith("SCORE:")) return "1d76db";
  if (label.startsWith("ALERT:")) return label === "ALERT:CRITICAL" ? "b60205" : (label === "ALERT:HIGH" ? "d93f0b" : "fbca04");
  if (label.startsWith("V:")) return "0052cc";
  if (label.startsWith("PAT:")) return "006b75";
  return "ededed";
}


function addInferredVesselContextLabels(labels, source = {}, item = {}) {
  const out = Array.isArray(labels) ? [...labels] : [];
  const hay = `${item?.title || ""}
${item?.text || ""}
${item?.summary || ""}
${item?.description || ""}
${source?.id || ""}
${source?.name || ""}`.toLowerCase();
  const add = (label) => { if (label && !out.includes(label)) out.push(label); };

  const russian = /(russian|russia|rus\.?|rf|росси|россий|ru navy|russian navy|black sea fleet|baltic fleet)/i.test(hay);
  const research = /(research|survey|hydrographic|oceanographic|oceanology|scientific|spy ship|intelligence ship|sigint|ag[iy]|yantar|sibiryakov|evgeniy churov|churov)/i.test(hay);
  const auxiliary = /(auxiliary|support ship|tug|salvage|rescue tug|naval auxiliary|fleet oiler|special purpose)/i.test(hay);
  const warship = /(warship|frigate|corvette|destroyer|submarine|naval vessel|navy vessel|missile ship)/i.test(hay);
  const sanctions = /(shadow fleet|sanctioned|sanctions|dark fleet|pre-sanction|pre sanction|sovcomflot|sts)/i.test(hay);

  if (russian && research) { add("V:RUS_RESEARCH"); add("V:SURVEY"); }
  if (russian && auxiliary) add("V:RUS_AUXILIARY");
  if (russian && warship) add("V:RUS_WARSHIP");
  if (russian && /(government|state|navy|naval|coast guard|border guard|fsi|fsb)/i.test(hay)) add("V:RUS_GOV");
  if (research && /(intelligence|sigint|spy|surveillance|reconnaissance)/i.test(hay)) add("V:INTELLIGENCE");
  if (sanctions) add("V:SANCTIONS_EVASION");

  return uniqueStrings(out);
}

function normalizeLabels(source, item = {}, config = {}) {
  const defaultLabels = [
    ...yamlScalarArray(config?.defaults?.base_labels),
    ...yamlScalarArray(config?.defaults?.labels)
  ];
  const sourceLabels = [
    ...yamlScalarArray(source.base_labels),
    ...yamlScalarArray(source.labels)
  ];
  const itemLabels = yamlScalarArray(item.labels);

  let labels = [
    ...defaultLabels,
    ...sourceLabels,
    ...itemLabels
  ];

  const type = sourceType(source);

  // Social sources should be recognizable in the dashboard even when the YAML
  // source forgot SRC:SOCIAL. This also enables source filters and archive KPIs.
  if (isSocialType(type) && !labels.includes("SRC:SOCIAL")) labels.push("SRC:SOCIAL");
  if (isXType(type) && !labels.includes("SRC:X")) labels.push("SRC:X");
  if (isBskyType(type) && !labels.includes("SRC:BSKY")) labels.push("SRC:BSKY");
  if (isRssType(type) && !labels.some(l => l === "SRC:MEDIA" || l === "SRC:OFFICIAL" || l === "SRC:OSINT")) {
    labels.push("SRC:MEDIA");
  }

  if (source.region_hint && !labels.some(l => l.startsWith("REG:"))) {
    labels.push(String(source.region_hint));
  }

  if (!labels.some(l => l.startsWith("SRC:"))) labels.push("SRC:OSINT");
  if (!labels.some(l => l.startsWith("D:"))) labels.push(config?.defaults?.domain_fallback || "D:NEWS_INTEL");
  if (!labels.some(l => l.startsWith("CONF:"))) labels.push(config?.defaults?.confidence_fallback || "CONF:LOW");
  if (!labels.some(l => l.startsWith("SEV:"))) labels.push(config?.defaults?.severity_fallback || "SEV:1");

  labels = addInferredVesselContextLabels(labels, source, item);
  return uniqueStrings(labels);
}

function makeIngestId(source, item) {
  const stable = [
    source.id || source.name || "source",
    normalizeUrl(item.link || item.url || item.guid || item.id || ""),
    asPlainText(item.guid || item.id || ""),
    asPlainText(item.title || ""),
    pickSourcePublishedAt(item) || ""
  ].join("|");

  return `${source.id || "source"}:${sha256Short(stable, 20)}`;
}


function sourceGeoMetadata(source = {}) {
  return {
    source_id: source.id || null,
    source_profile: source.source_profile || source.sourceProfile || null,
    map_enabled: source.map_enabled === undefined ? null : Boolean(source.map_enabled),
    geo_priority: source.geo_priority || source.geoPriority || null,
    route_source: Boolean(source.route_source || source.routeSource),
    government_weirdness_source: Boolean(source.government_weirdness_source || source.governmentWeirdnessSource),
    gov_weirdness_correlation: source.gov_weirdness_correlation || source.govWeirdnessCorrelation || null,
    position_reliability: source.position_reliability || null,
    position_basis: source.position_basis || null,
    geo_interpretation: source.geo_interpretation || null
  };
}

function makeBody({ source, item, link, title, text, labels, ingestId, sourcePublishedAt, ingestedAt, geoEvidence = null, priorityAlert = null }) {
  const platform =
    source.platform ||
    source.type ||
    item.platform ||
    "unknown";

  const sourceLine = `${source.name || source.id || "Unknown source"} (${source.id || "no_id"})`;

  return [
    `<!-- MAGIC_PAWS_INGEST_ID:${ingestId} -->`,
    `<!-- VOODOO_INGEST_ID:${ingestId} -->`,
    "",
    "### Text",
    truncate(text || title || "", 5000),
    "",
    "### Zeit (UTC)",
    `source_published_at: ${sourcePublishedAt || ""}`,
    `ingested_at: ${ingestedAt}`,
    "",
    "### Quelle",
    sourceLine,
    "",
    "### Plattform",
    String(platform),
    "",
    "### Link",
    link || "",
    "",
    ...(geoEvidence?.geo ? [
      "### Geo",
      `Geo: ${Number(geoEvidence.geo.lat).toFixed(5)}, ${Number(geoEvidence.geo.lon).toFixed(5)}`,
      `method: ${geoEvidence.geo.method || "unknown"}`,
      `confidence: ${geoEvidence.geo.confidence || "unknown"}`,
      `matched_name: ${geoEvidence.geo.matched_name || ""}`,
      `matched_id: ${geoEvidence.geo.matched_id || ""}`,
      `role: ${geoEvidence.geo.geo_role || "event_location"}`,
      ""
    ] : []),
    ...((geoEvidence?.geo_candidates || []).length ? [
      "### Geo Candidates",
      JSON.stringify(geoEvidence.geo_candidates, null, 2),
      ""
    ] : []),
    ...(geoEvidence?.route ? [
      "### Route",
      `route_detected: true`,
      `method: ${geoEvidence.route.method}`,
      `confidence: ${geoEvidence.route.confidence}`,
      JSON.stringify(geoEvidence.route, null, 2),
      ""
    ] : []),
    ...(geoEvidence?.hasMap ? [
      "### Geo JSON",
      JSON.stringify({
        geo: geoEvidence.geo,
        geo_candidates: geoEvidence.geo_candidates || [],
        route: geoEvidence.route || null,
        source_geo_metadata: sourceGeoMetadata(source)
      }, null, 2),
      ""
    ] : []),
    ...(priorityAlert && priorityAlert.level && priorityAlert.level !== "NONE" ? [
      "### Priority Alert",
      `level: ${priorityAlert.level}`,
      `score: ${priorityAlert.score}`,
      `reasons: ${(priorityAlert.reasons || []).join("; ")}`,
      "",
    ] : []),
    "### Auto-Labels",
    labels.join(", "),
    "",
    "---",
    `ingest_version: ${VERSION}`
  ].join("\n");
}


// -----------------------------------------------------------------------------
// Priority alerting / ntfy push
// -----------------------------------------------------------------------------
const ALERT_RANK = { NONE: 0, WATCH: 1, HIGH: 2, CRITICAL: 3 };

function alertRank(level) {
  return ALERT_RANK[String(level || "NONE").toUpperCase()] || 0;
}

function alertMinRank() {
  return alertRank(NTFY_MIN_LEVEL || "HIGH") || ALERT_RANK.HIGH;
}

function textHasAny(text, patterns) {
  return (patterns || []).some((p) => p.test(text));
}

function classifyPriorityAlert({ title = "", text = "", labels = [], geoEvidence = null, source = {}, link = "" }) {
  const raw = `${title}\n${text}\n${labels.join(" ")}\n${source?.name || ""}\n${source?.id || ""}\n${link || ""}`;
  const t = raw.toLowerCase();
  const reasons = [];
  let score = 0;

  const add = (points, reason) => {
    score += points;
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  const explosive = /\b(mine|mines|limpet mine|naval mine|sea mine|explosive device|explosive|ied|bomb|munition|unexploded ordnance|uxo|sprengsatz|sprengstoff|haftmine|seemine|mine attached)\b/i;
  const hardIncident = /\b(sabotage|terrorist attack|attempted attack|attack|arson|explosion|blast|collision|grounding|fire|sinking|hijack|kidnap|armed robbery|boarding|interdiction|seizure)\b/i;
  const ci = /\b(subsea|seabed|cable|pipeline|lng|lpg|gas terminal|oil terminal|offshore|wind farm|windfarm|platform|terminal|port|harbour|harbor|hafen|kritis|critical infrastructure)\b/i;
  const vessel = /\b(vessel|ship|tanker|carrier|cargo|container ship|bulk carrier|warship|frigate|patrol vessel|lpg carrier|lng carrier|schiff|frachter|tanker)\b/i;
  const routeAis = /\b(ais gap|ais off|dark vessel|dark activity|loitering|ship-to-ship|\bsts\b|rendezvous|route deviation|spoofing|jamming|gnss|gps)\b/i;
  const navwarnVital = /\b(navtex|navwarn|navigational warning|mine|explosive|obstruction|hazard|restricted area|exclusion zone|firing exercise|military exercise|cable|pipeline|wreck|drifting object)\b/i;
  const strategicPlace = /\b(ust[-\s]?luga|primorsk|gulf of finland|baltic|north sea|german bight|skagen|kattegat|bornholm|gotland|gibraltar|suez|bab el[-\s]?mandeb|hormuz|black sea|red sea|kerch|novorossiysk)\b/i;

  if (explosive.test(raw)) add(5, "Explosivmittel/Minenbezug");
  if (hardIncident.test(raw)) add(4, "harter Sicherheitsvorfall");
  if (ci.test(raw)) add(2, "KRITIS-/Hafen-/Energiebezug");
  if (vessel.test(raw)) add(2, "Schiffsbezug");
  if (routeAis.test(raw)) add(2, "AIS-/Route-/GNSS-Muster");
  if (navwarnVital.test(raw)) add(1, "NAVTEX/NAVWARN- oder nautischer Gefahrenbezug");
  if (strategicPlace.test(raw)) add(2, "strategischer maritimer Raum");

  if (labels.includes("D:SECURITY_CRIME")) add(2, "Security-Crime-Label");
  if (labels.includes("D:INFRA_CI")) add(2, "KRITIS-Label");
  if (labels.includes("D:RF_SIGNAL")) add(1, "RF/GNSS-Label");
  if (labels.includes("D:AIS_TRACK")) add(1, "AIS-/Track-Label");
  if (labels.includes("P0:SUSPECT")) add(2, "P0:SUSPECT");
  if (labels.includes("CONF:HIGH")) add(2, "hohe Konfidenz");
  else if (labels.includes("CONF:MED")) add(1, "mittlere Konfidenz");
  if (labels.includes("SEV:3") || labels.includes("SEV:4")) add(2, "erhöhte Severity");
  else if (labels.includes("SEV:2")) add(1, "mittlere Severity");

  if (geoEvidence?.geo || (geoEvidence?.geo_candidates || []).length) add(1, "georeferenzierbar");

  // Critical override: mines/explosives plus vessel/port/CI should never drown in normal RSS.
  const criticalOverride = explosive.test(raw) && (vessel.test(raw) || ci.test(raw) || strategicPlace.test(raw));
  let level = "NONE";
  if (criticalOverride || score >= 12) level = "CRITICAL";
  else if (score >= 8) level = "HIGH";
  else if (score >= 5) level = "WATCH";

  const titleShort = String(title || "MAGIC PAWS Alert").replace(/^\[[^\]]+\]\s*/, "").slice(0, 160);
  return {
    level,
    score,
    reasons: reasons.slice(0, 8),
    title: level === "NONE" ? "" : `MAGIC PAWS ${level}: ${titleShort}`,
    tags: level === "CRITICAL" ? "rotating_light,ship,warning" : (level === "HIGH" ? "warning,ship" : "eyes,ship")
  };
}

function alertBody(priorityAlert, { title = "", source = {}, link = "", issueUrl = "", labels = [] }) {
  const src = source?.name || source?.id || "Unknown source";
  const reasons = (priorityAlert?.reasons || []).map((r) => `- ${r}`).join("\n");
  const target = link || issueUrl || "";
  return [
    priorityAlert?.title || `MAGIC PAWS ${priorityAlert?.level || "ALERT"}`,
    "",
    `Quelle: ${src}`,
    labels?.length ? `Labels: ${labels.join(", ")}` : "",
    priorityAlert?.score != null ? `Alert-Score: ${priorityAlert.score}` : "",
    reasons ? `Warum:\n${reasons}` : "",
    target ? `\nOpen: ${target}` : ""
  ].filter(Boolean).join("\n");
}

async function sendNtfyAlert(priorityAlert, context = {}) {
  if (!priorityAlert || alertRank(priorityAlert.level) < alertMinRank()) return;
  if (!NTFY_ENABLED || !NTFY_URL) return;
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Would send ntfy alert: ${priorityAlert.level} ${priorityAlert.title}`);
    return;
  }

  const headers = {
    "Title": priorityAlert.title.slice(0, 250),
    "Priority": priorityAlert.level === "CRITICAL" ? "5" : "4",
    "Tags": priorityAlert.tags || "warning,ship",
    "Content-Type": "text/plain; charset=utf-8"
  };
  const clickUrl = context.link || context.issueUrl || "";
  if (clickUrl) headers["Click"] = clickUrl;
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;

  try {
    const res = await fetch(NTFY_URL, {
      method: "POST",
      headers,
      body: alertBody(priorityAlert, context)
    });
    const txt = await res.text().catch(() => "");
    if (!res.ok) console.warn(`ntfy alert failed ${res.status}: ${txt.slice(0, 300)}`);
    else console.log(`ntfy alert sent: ${priorityAlert.level}`);
  } catch (e) {
    console.warn(`ntfy alert failed: ${e.message}`);
  }
}

// -----------------------------------------------------------------------------
// Config loading
// -----------------------------------------------------------------------------

async function loadSourcesConfig() {
  const raw = await fs.readFile(SOURCES_FILE, "utf8");
  const parsed = YAML.parse(raw);

  if (Array.isArray(parsed)) {
    return {
      endpoints: {},
      sources: parsed
    };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${SOURCES_FILE} is empty or invalid.`);
  }

  const sources =
    Array.isArray(parsed.sources) ? parsed.sources :
    Array.isArray(parsed.feeds) ? parsed.feeds :
    [];

  return {
    ...parsed,
    endpoints: parsed.endpoints || {},
    sources
  };
}

function enabledSources(config) {
  return (config.sources || [])
    .filter(s => s && s.enabled !== false)
    .filter(s => s.type && (s.url || s.bridge_path || s.handle))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
}

// -----------------------------------------------------------------------------
// GitHub API
// -----------------------------------------------------------------------------

function ghHeaders(extra = {}) {
  const h = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "magic-paws-ingest",
    ...extra
  };

  if (GITHUB_TOKEN) {
    h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  return h;
}

async function ghRequest(path, options = {}) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: ghHeaders(options.headers || {})
  });

  const text = await res.text().catch(() => "");
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${msg.slice(0, 500)}`);
  }

  return data;
}

async function fetchExistingIssues(maxItems = MAX_EXISTING_ISSUES) {
  const all = [];
  const perPage = 100;
  const maxPages = Math.ceil(maxItems / perPage);

  for (let page = 1; page <= maxPages; page++) {
    const batch = await ghRequest(
      `/issues?state=all&per_page=${perPage}&page=${page}&sort=created&direction=desc`
    );

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const issue of batch) {
      if (!issue.pull_request) all.push(issue);
    }

    if (batch.length < perPage) break;
    if (all.length >= maxItems) break;
  }

  return all.slice(0, maxItems);
}

function buildExistingIndex(issues) {
  const urls = new Set();
  const ingestIds = new Set();

  for (const issue of issues || []) {
    const body = String(issue.body || "");

    const idMatches = body.matchAll(/(?:MAGIC_PAWS_INGEST_ID|VOODOO_INGEST_ID|INGEST_ID)\s*:?\s*([A-Za-z0-9:_./-]+)/g);
    for (const m of idMatches) {
      if (m[1]) ingestIds.add(m[1].trim());
    }

    const urlMatches = body.matchAll(/https?:\/\/[^\s<>"')]+/g);
    for (const m of urlMatches) {
      urls.add(normalizeUrl(m[0]));
    }
  }

  return { urls, ingestIds };
}

async function ensureLabel(label) {
  if (DRY_RUN) return;

  try {
    await ghRequest(`/labels/${encodeURIComponent(label)}`);
    return;
  } catch {
    // create below
  }

  try {
    await ghRequest("/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: label,
        color: labelColorFor(label),
        description: "Created by MAGIC PAWS ingest"
      })
    });
  } catch (e) {
    console.warn(`Could not ensure label "${label}": ${e.message}`);
  }
}

async function createIssue({ title, body, labels }) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Would create issue: ${title}`);
    return { dry_run: true, title };
  }

  for (const label of labels) {
    await ensureLabel(label);
  }

  try {
    return await ghRequest("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, labels })
    });
  } catch (e) {
    console.warn(`Issue creation with labels failed, retrying without labels: ${e.message}`);

    return await ghRequest("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body })
    });
  }
}

// -----------------------------------------------------------------------------
// RSS / Atom parsing
// -----------------------------------------------------------------------------

function extractAtomLink(entry) {
  const links = asArray(entry.link);
  if (!links.length) return "";

  for (const l of links) {
    if (typeof l === "string") return l;
    if (l?.["@_rel"] === "alternate" && l?.["@_href"]) return l["@_href"];
  }

  const first = links[0];
  return asPlainText(first?.["@_href"] || first?.href || first);
}

function normalizeRssItem(raw, source) {
  const item = raw || {};

  const title =
    asPlainText(item.title) ||
    asPlainText(item["media:title"]) ||
    asPlainText(item.guid) ||
    "Untitled RSS item";

  const link =
    normalizeUrl(
      item.link ||
      item.guid?.["#text"] ||
      item.guid ||
      item.id ||
      extractAtomLink(item)
    );

  const description =
    stripHtml(
      item.description ||
      item.summary ||
      item.content ||
      item["content:encoded"] ||
      item["media:description"] ||
      item.title ||
      ""
    );

  const sourcePublishedAt = pickSourcePublishedAt(item);

  return {
    raw: item,
    source_id: source.id,
    platform: "rss",
    title,
    link,
    url: link,
    guid: asPlainText(item.guid || item.id || link),
    text: description,
    source_published_at: sourcePublishedAt
  };
}

function extractFeedItems(parsed) {
  if (parsed?.rss?.channel?.item) {
    return asArray(parsed.rss.channel.item);
  }

  if (parsed?.feed?.entry) {
    return asArray(parsed.feed.entry);
  }

  if (parsed?.rdf?.item) {
    return asArray(parsed.rdf.item);
  }

  return [];
}

async function fetchRssSource(source) {
  const res = await fetch(source.url, {
    headers: {
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      "User-Agent": "MAGIC-PAWS-RSS-Ingest/1.0"
    }
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`RSS fetch failed ${res.status}: ${text.slice(0, 300)}`);
  }

  const parsed = xmlParser.parse(text);
  const rawItems = extractFeedItems(parsed);

  return rawItems.map(item => normalizeRssItem(item, source));
}

// -----------------------------------------------------------------------------
// Social bridge parsing
// -----------------------------------------------------------------------------

function socialBridgeBase(config) {
  return (
    config?.endpoints?.social_bridge_base ||
    config?.social_bridge_base ||
    DEFAULT_SOCIAL_BRIDGE_BASE
  ).replace(/\/+$/, "");
}

function socialBridgeUrl(source, config) {
  const base = socialBridgeBase(config);

  if (source.bridge_url) return source.bridge_url;

  if (source.bridge_path) {
    const path = String(source.bridge_path).startsWith("/")
      ? String(source.bridge_path)
      : `/${source.bridge_path}`;
    return `${base}${path}`;
  }

  if (source.handle) {
    const handle = encodeURIComponent(String(source.handle).replace(/^@/, ""));
    if (isBskyType(source)) return `${base}/bsky/${handle}`;
    return `${base}/x/${handle}`;
  }

  throw new Error(`social source ${source.id} has no bridge_path, bridge_url or handle.`);
}

function extractSocialItems(payload) {
  if (Array.isArray(payload)) return payload;

  return (
    asArray(payload?.items).length ? asArray(payload.items) :
    asArray(payload?.posts).length ? asArray(payload.posts) :
    asArray(payload?.events).length ? asArray(payload.events) :
    asArray(payload?.data).length ? asArray(payload.data) :
    []
  );
}

function normalizeSocialItem(raw, source) {
  const item = raw || {};
  const bsky = isBskyType(source);

  const author = item.author || item.user || item.account || item.profile || {};
  const handle =
    item.handle ||
    item.username ||
    item.user_handle ||
    author.handle ||
    author.username ||
    author.displayName ||
    source.handle ||
    source.name ||
    source.id;

  const textCandidate =
    item.text ||
    item.body ||
    item.content ||
    item.description ||
    item.summary ||
    item.record?.text ||
    item.value?.text ||
    item.post?.record?.text ||
    item.post?.text ||
    "";

  const cleanText = stripHtml(textCandidate);

  const title =
    asPlainText(item.title) ||
    cleanText.slice(0, 160) ||
    `Social item ${handle}`;

  const link =
    normalizeUrl(
      item.url ||
      item.link ||
      item.permalink ||
      item.tweet_url ||
      item.post_url ||
      item.uri ||
      item.cid ||
      ""
    );

  const sourcePublishedAt = pickSourcePublishedAt({
    ...item,
    source_published_at: item.source_published_at,
    published_at: item.published_at || item.indexedAt || item.createdAt || item.created_at,
    ts: item.ts || item.timestamp
  });

  return {
    raw: item,
    source_id: source.id,
    platform: bsky ? "social_bsky" : "social_x",
    handle,
    title,
    link,
    url: link,
    guid: asPlainText(item.id || item.guid || item.post_id || item.cid || item.uri || link || `${handle}:${title}:${sourcePublishedAt || ""}`),
    text: cleanText || title,
    source_published_at: sourcePublishedAt,
    labels: item.labels
  };
}

async function fetchSocialSource(source, config) {
  const url = socialBridgeUrl(source, config);

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "MAGIC-PAWS-Social-Ingest/1.0"
    }
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`Social bridge fetch failed ${res.status}: ${text.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Social bridge returned non-JSON response: ${text.slice(0, 300)}`);
  }

  return extractSocialItems(payload).map(item => normalizeSocialItem(item, source));
}

// -----------------------------------------------------------------------------
// Source processing
// -----------------------------------------------------------------------------

async function fetchSourceItems(source, config) {
  const type = sourceType(source);

  if (isRssType(type)) {
    return fetchRssSource(source);
  }

  if (isSocialType(type)) {
    return fetchSocialSource(source, config);
  }

  console.log(`Notice: skipping unsupported source type "${source.type}" for ${source.id || source.name}`);
  return [];
}

function itemPassesBasicQuality(item) {
  const title = asPlainText(item.title);
  const text = asPlainText(item.text);
  const link = normalizeUrl(item.link || item.url || "");

  if (!title && !text) return false;

  // Linkless social items may still be useful, but RSS items should normally have links.
  if (item.platform === "rss" && !link) return false;

  return true;
}

async function processSource(source, config, existingIndex) {
  const sourceId = source.id || source.name || "unknown_source";
  const maxItems = maxItemsForSource(source);

  const stats = {
    source_id: sourceId,
    source_name: source.name || sourceId,
    type: source.type,
    fetched: 0,
    considered: 0,
    created: 0,
    skipped_duplicate: 0,
    skipped_quality: 0,
    skipped_lookback: 0,
    errors: []
  };

  console.log(`\n=== Source: ${sourceId} (${source.type}) ===`);

  let items = [];

  try {
    items = await fetchSourceItems(source, config);
  } catch (e) {
    stats.errors.push(e.message);
    console.error(`Fetch failed for ${sourceId}: ${e.message}`);
    return stats;
  }

  stats.fetched = items.length;

  const limited = items.slice(0, maxItems);
  stats.considered = limited.length;

  for (const item of limited) {
    try {
      if (!itemPassesBasicQuality(item)) {
        stats.skipped_quality++;
        continue;
      }

      if (!itemWithinLookback(source, item)) {
        stats.skipped_lookback++;
        continue;
      }

      const link = normalizeUrl(item.link || item.url || "");
      const ingestId = makeIngestId(source, item);

      if (existingIndex.ingestIds.has(ingestId) || (link && existingIndex.urls.has(link))) {
        stats.skipped_duplicate++;
        continue;
      }

      const geoEvidence = extractGeoEvidence(`${item.title || ""}
${item.text || ""}`, item, source);
      let labels = normalizeLabels(source, item, config);
      if (geoEvidence.hasMap && !labels.includes("MAP:YES")) labels.push("MAP:YES");
      if (geoEvidence.route && !labels.includes("PAT:ROUTE_OBSERVED")) labels.push("PAT:ROUTE_OBSERVED");
      if ((geoEvidence.geo || geoEvidence.route) && !labels.includes("D:AIS_TRACK") && (source.route_source || source.routeSource)) labels.push("D:AIS_TRACK");
      labels = uniqueStrings(labels);
      const sourcePublishedAt = pickSourcePublishedAt(item);
      const ingestedAt = nowIso();

      const prefix =
        item.platform === "social_x" ? "[X]" :
        item.platform === "social_bsky" ? "[BSKY]" :
        item.platform === "rss" ? "[RSS]" :
        "[OSINT]";

      const title = safeIssueTitle(item.title, `${prefix} `);
      const priorityAlert = classifyPriorityAlert({
        title,
        text: item.text || item.title,
        labels,
        geoEvidence,
        source,
        link
      });

      if (priorityAlert.level && priorityAlert.level !== "NONE") {
        const alertLabel = `ALERT:${priorityAlert.level}`;
        if (!labels.includes(alertLabel)) labels.push(alertLabel);
        labels = uniqueStrings(labels);
      }

      const body = makeBody({
        source,
        item,
        link,
        title,
        text: item.text || item.title,
        labels,
        ingestId,
        sourcePublishedAt,
        ingestedAt,
        geoEvidence,
        priorityAlert
      });

      const created = await createIssue({ title, body, labels });
      await sendNtfyAlert(priorityAlert, {
        title,
        source,
        link,
        issueUrl: created?.html_url || created?.url || "",
        labels
      });

      stats.created++;

      existingIndex.ingestIds.add(ingestId);
      if (link) existingIndex.urls.add(link);

      const issueNo = created?.number ? `#${created.number}` : "";
      console.log(`Created ${issueNo}: ${title}`);
    } catch (e) {
      stats.errors.push(e.message);
      console.error(`Item failed in ${sourceId}: ${e.message}`);
    }
  }

  console.log(
    `Done ${sourceId}: fetched=${stats.fetched}, considered=${stats.considered}, created=${stats.created}, duplicate=${stats.skipped_duplicate}, quality_skip=${stats.skipped_quality}, lookback_skip=${stats.skipped_lookback}`
  );

  return stats;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  console.log(`${VERSION}`);
  console.log(`Repository: ${OWNER}/${REPO}`);
  console.log(`Sources file: ${SOURCES_FILE}`);
  console.log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);

  const config = await loadSourcesConfig();
  const sources = enabledSources(config);

  console.log(`Enabled sources: ${sources.length}`);

  const existingIssues = DRY_RUN ? [] : await fetchExistingIssues(MAX_EXISTING_ISSUES);
  const existingIndex = buildExistingIndex(existingIssues);

  console.log(`Existing issues indexed: ${existingIssues.length}`);
  console.log(`Existing issue URLs indexed: ${existingIndex.urls.size}`);
  console.log(`Existing ingest IDs indexed: ${existingIndex.ingestIds.size}`);

  const results = [];

  for (const source of sources) {
    const result = await processSource(source, config, existingIndex);
    results.push(result);
  }

  const summary = {
    ok: true,
    version: VERSION,
    repository: `${OWNER}/${REPO}`,
    sources_total: sources.length,
    fetched_total: results.reduce((a, x) => a + x.fetched, 0),
    considered_total: results.reduce((a, x) => a + x.considered, 0),
    created_total: results.reduce((a, x) => a + x.created, 0),
    skipped_duplicate_total: results.reduce((a, x) => a + x.skipped_duplicate, 0),
    skipped_quality_total: results.reduce((a, x) => a + x.skipped_quality, 0),
    skipped_lookback_total: results.reduce((a, x) => a + x.skipped_lookback, 0),
    errors_total: results.reduce((a, x) => a + x.errors.length, 0),
    results
  };

  console.log("\n=== INGEST SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));

  if (summary.errors_total > 0) {
    const failedSources = results
      .filter(x => Array.isArray(x.errors) && x.errors.length > 0)
      .map(x => `${x.source_id}: ${x.errors.join(" | ")}`);

    console.warn("\n=== INGEST SOURCE WARNINGS ===");
    console.warn(`Non-fatal source/item errors: ${summary.errors_total}`);
    for (const line of failedSources.slice(0, 25)) console.warn(`- ${line}`);
    if (failedSources.length > 25) console.warn(`… ${failedSources.length - 25} more source(s) omitted`);

    if (FAIL_ON_SOURCE_ERRORS) {
      console.error("FAIL_ON_SOURCE_ERRORS=1, therefore failing this run.");
      process.exitCode = 1;
    } else {
      console.warn("Continuing with exit code 0. Set FAIL_ON_SOURCE_ERRORS=1 for strict mode.");
    }
  }
}

main().catch(err => {
  console.error("Fatal ingest error:", err);
  process.exitCode = 1;
});
