#!/usr/bin/env node
/**
 * MAGIC PAWS // ntfy threshold alerts
 * Version: v5.51 "Two-run threshold gate"
 *
 * Sends ntfy notifications only when a metric remains above its threshold for
 * at least two consecutive workflow runs. This prevents single-run spikes from
 * creating noise.
 *
 * Default rules:
 *   - Hybrid-Index > 75% for 2 consecutive runs
 *   - Government Weirdness North Sea > 60% for 2 consecutive runs
 *   - Government Weirdness Baltic Sea > 60% for 2 consecutive runs
 *
 * Designed for GitHub Actions. Uses only Node 18+ built-ins.
 *
 * Required secrets/env for real sends:
 *   NTFY_ENABLED=true
 *   NTFY_URL=https://ntfy.sh/<topic>  OR self-hosted topic URL
 *   NTFY_TOKEN=<optional bearer token>
 *
 * Optional env:
 *   MAGICPAWS_ALERT_HYBRID_THRESHOLD=75
 *   MAGICPAWS_ALERT_WEIRDNESS_THRESHOLD=60
 *   MAGICPAWS_ALERT_REQUIRED_HIGH_RUNS=2
 *   MAGICPAWS_ALERT_COOLDOWN_MINUTES=0
 *   MAGICPAWS_ALERT_WRITE_STATE_EVERY_RUN=false
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, "data/live/magicpaws_threshold_alert_state.json");

const CONFIG = {
  hybridThreshold: numberFromEnv("MAGICPAWS_ALERT_HYBRID_THRESHOLD", 75),
  weirdnessThreshold: numberFromEnv("MAGICPAWS_ALERT_WEIRDNESS_THRESHOLD", 60),
  requiredHighRuns: Math.max(2, Math.round(numberFromEnv("MAGICPAWS_ALERT_REQUIRED_HIGH_RUNS", 2))),
  cooldownMinutes: Math.max(0, numberFromEnv("MAGICPAWS_ALERT_COOLDOWN_MINUTES", 0)),
  writeStateEveryRun: boolFromEnv("MAGICPAWS_ALERT_WRITE_STATE_EVERY_RUN", false)
};

function numberFromEnv(name, fallback){
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function boolFromEnv(name, fallback = false){
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

function readJsonMaybe(relOrAbs){
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function readFirstJson(paths){
  for (const p of paths){
    const data = readJsonMaybe(p);
    if (data) return { data, path:p };
  }
  return { data:null, path:null };
}

function writeJson(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function asArr(x){ return Array.isArray(x) ? x : []; }
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function labelsOf(e){ return asArr(e?.labels).map(String); }
function hasAny(e, wanted){
  const labels = labelsOf(e);
  return wanted.some(x => labels.includes(x));
}
function getMs(e){
  const candidates = [e?.event_ts, e?.published_at, e?.source_published_at, e?.chronology_ts, e?.ts, e?.timestamp, e?.date, e?.created_at, e?.updated_at];
  for (const c of candidates){
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function findNumber(obj, paths){
  for (const p of paths){
    const parts = p.split(".");
    let cur = obj;
    for (const part of parts) cur = cur?.[part];
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function latestDailySummary(){
  const { data, path:sourcePath } = readFirstJson([
    "data/snapshots/magicpaws_daily_summary.json",
    "data/snapshots/voodoo_daily_summary.json",
    "magicpaws_daily_summary.json",
    "voodoo_daily_summary.json"
  ]);
  const arr = Array.isArray(data) ? data : asArr(data?.daily_summary || data?.days || data?.items);
  if (!arr.length) return { item:null, sourcePath };
  const item = [...arr].sort((a, b) => {
    const ta = Date.parse(a?.date || a?.generated_at || a?.ts || 0) || 0;
    const tb = Date.parse(b?.date || b?.generated_at || b?.ts || 0) || 0;
    return tb - ta;
  })[0];
  return { item, sourcePath };
}

function loadEvents(){
  const { data, path:sourcePath } = readFirstJson([
    "data/logs/magicpaws_events_20d.json",
    "data/logs/voodoo_events_20d.json",
    "magicpaws_events_20d.json",
    "voodoo_events_20d.json"
  ]);
  return { events:asArr(data?.events || data?.items || data), sourcePath };
}

function scoreEventForHybrid(e){
  const labels = labelsOf(e);
  const sev = String(e?.severity || "SEV:1");
  const conf = String(e?.confidence || "CONF:LOW");
  const sevW = sev === "SEV:4" ? 9 : sev === "SEV:3" ? 6 : sev === "SEV:2" ? 3 : 1;
  const confW = conf === "CONF:HIGH" ? 1.2 : conf === "CONF:MED" ? 1.0 : 0.8;
  let v = sevW * confW;
  if (e?.phase0?.suspect || labels.includes("P0:SUSPECT")) v *= 1.6;
  if (["OBJ:CABLE", "OBJ:PIPELINE", "OBJ:WINDFARM", "OBJ:PORT", "OBJ:VTS_WSV", "D:INFRA_CI"].some(x => labels.includes(x))) v *= 1.25;
  if (["PAT:LOITERING", "PAT:STS_SUSPECT", "PAT:AIS_GAP", "PAT:DARK_ACTIVITY", "PAT:SURVEYING", "PAT:ROUTE_DEVIATION", "PAT:ROUTE_OBSERVED", "PAT:GNSS_JAM", "PAT:GNSS_SPOOF", "RF:GNSS_JAM", "RF:GNSS_SPOOF"].some(x => labels.includes(x))) v *= 1.20;
  if (["V:SHADOW_FLEET", "V:RUS_RESEARCH", "V:RUS_WARSHIP", "V:RUS_AUXILIARY", "V:SANCTIONS_EVASION"].some(x => labels.includes(x))) v *= 1.15;
  return v;
}

function scorePhaseZero(events, windowHours = 72){
  const now = Date.now();
  const bucketMs = 60 * 60 * 1000;
  const buckets = Array.from({ length:windowHours }, () => ({ score:0, count:0 }));
  const seen = new Set();

  for (const e of events){
    const ms = getMs(e);
    if (!ms) continue;
    const age = now - ms;
    if (age < 0 || age > bucketMs * windowHours) continue;

    const key = e?.url || e?.id || e?.number || `${e?.title || ""}:${e?.ts || ""}`;
    const seenKey = `${Math.floor(ms / bucketMs)}:${key}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    const idx = windowHours - 1 - Math.floor(age / bucketMs);
    if (idx < 0 || idx >= windowHours) continue;
    buckets[idx].score += scoreEventForHybrid(e);
    buckets[idx].count += 1;
  }

  const pctBuckets = buckets.map(b => clamp(Math.round((b.score / 28) * 100), 0, 100));
  const avg = pctBuckets.length ? pctBuckets.reduce((s, v) => s + v, 0) / pctBuckets.length : 0;
  return clamp(Math.round(avg), 0, 100);
}

function eventInRegion(e, region){
  const labels = labelsOf(e);
  const text = `${e?.title || ""} ${e?.summary || ""}`.toLowerCase();
  if (region === "north"){
    return labels.some(l => ["REG:NORTH_SEA", "REG:GER_BIGHT", "REG:CHANNEL", "REG:SKAGERRAK"].includes(l)) || /north sea|nordsee|german bight|deutsche bucht|channel|skagerrak/.test(text);
  }
  return labels.some(l => ["REG:BALTIC_SEA", "REG:BALTIC", "REG:DANISH_STRAITS", "REG:ORESUND", "REG:GOTLAND_SEA", "REG:GULF_OF_FINLAND"].includes(l)) || /baltic|ostsee|danish straits|øresund|oresund|gulf of finland|gotland/.test(text);
}

function scoreWeirdnessFromEvents(events, region){
  const now = Date.now();
  let points = 0;
  const seen = new Set();

  for (const e of events){
    const ms = getMs(e);
    if (!ms || (now - ms) / 36e5 > 24 || !eventInRegion(e, region)) continue;
    const key = e?.url || e?.id || e?.number || e?.title || JSON.stringify(e).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    const labels = labelsOf(e);
    const text = `${e?.title || ""} ${e?.summary || ""} ${labels.join(" ")}`.toLowerCase();
    const ais = hasAny(e, ["SRC:AIS", "D:AIS_TRACK", "PAT:AIS_GAP", "PAT:DARK_ACTIVITY", "PAT:LOITERING", "PAT:ROUTE_DEVIATION", "PAT:ROUTE_OBSERVED", "PAT:STS_SUSPECT"]) || /ais gap|dark vessel|loitering|route deviation|ship-to-ship|\bsts\b|rendezvous/.test(text);
    const adsb = hasAny(e, ["SRC:ADSB", "D:AIR_ACTIVITY", "V:MPA", "V:SAR_UNIT", "V:AUTH_COAST_GUARD", "PAT:RACETRACK", "PAT:LOW_ORBIT"]) || /ads-?b|mpa|p-8|p8 poseidon|sar aircraft|coast guard aircraft|helicopter|racetrack|orbit|isr/.test(text);
    const official = hasAny(e, ["SRC:OFFICIAL", "SRC:AUTHORITY", "V:AUTH_COAST_GUARD"]) || /coast guard|police|navy|marine|behörde|bsh|wsv|official/.test(text);
    const ci = hasAny(e, ["OBJ:PORT", "OBJ:VTS_WSV", "OBJ:CABLE", "OBJ:PIPELINE", "OBJ:WINDFARM", "D:INFRA_CI"]);
    const rf = hasAny(e, ["D:RF_SIGNAL", "PAT:GNSS_JAM", "PAT:GNSS_SPOOF"]) || labels.some(l => l.startsWith("RF:"));

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

function loadCurrentValues(){
  const sensorRead = readFirstJson([
    "data/snapshots/magicpaws_sensor_latest.json",
    "data/snapshots/voodoo_sensor_latest.json",
    "magicpaws_sensor_latest.json",
    "voodoo_sensor_latest.json"
  ]);
  const sensor = sensorRead.data || {};
  const { item:latest, sourcePath:dailySource } = latestDailySummary();
  const { events, sourcePath:eventsSource } = loadEvents();

  const hybrid = findNumber(sensor, [
    "sensors.hybrid_index_pct",
    "sensors.hybrid_index",
    "hybrid_index_pct",
    "hybrid_index",
    "hybridIndex",
    "phase_zero_index",
    "p0_pct",
    "metrics.hybrid_index",
    "metrics.phase_zero_index"
  ]) ?? findNumber(latest, [
    "hybrid_index_pct",
    "hybrid_index",
    "hybrid_index_proxy",
    "hybridIndex",
    "phase_zero_index",
    "p0_pct"
  ]) ?? scorePhaseZero(events, 72);

  const weirdNorth = findNumber(sensor, [
    "sensors.government_weirdness.north_sea_pct",
    "sensors.government_weirdness.north_sea",
    "sensors.government_weirdness.north_pct",
    "sensors.government_weirdness.north",
    "government_weirdness.north_sea_pct",
    "government_weirdness.north_sea",
    "government_weirdness.north_pct",
    "government_weirdness.north",
    "weirdness.north_sea_pct",
    "weirdness.north_sea",
    "government_weirdness_proxy.north_sea"
  ]) ?? findNumber(latest, [
    "government_weirdness.north_sea_pct",
    "government_weirdness.north_sea",
    "government_weirdness_proxy.north_sea",
    "weirdness.north_sea"
  ]) ?? scoreWeirdnessFromEvents(events, "north");

  const weirdBaltic = findNumber(sensor, [
    "sensors.government_weirdness.baltic_sea_pct",
    "sensors.government_weirdness.baltic_sea",
    "sensors.government_weirdness.baltic_pct",
    "sensors.government_weirdness.baltic",
    "government_weirdness.baltic_sea_pct",
    "government_weirdness.baltic_sea",
    "government_weirdness.baltic_pct",
    "government_weirdness.baltic",
    "weirdness.baltic_sea_pct",
    "weirdness.baltic_sea",
    "government_weirdness_proxy.baltic_sea"
  ]) ?? findNumber(latest, [
    "government_weirdness.baltic_sea_pct",
    "government_weirdness.baltic_sea",
    "government_weirdness_proxy.baltic_sea",
    "weirdness.baltic_sea"
  ]) ?? scoreWeirdnessFromEvents(events, "baltic");

  return {
    values: {
      hybrid: Math.round(hybrid),
      gov_weirdness_north: Math.round(weirdNorth),
      gov_weirdness_baltic: Math.round(weirdBaltic)
    },
    sources: {
      sensor: sensorRead.path,
      daily_summary: dailySource,
      events: eventsSource
    }
  };
}

function shouldPassCooldown(metricState, nowMs){
  if (!CONFIG.cooldownMinutes) return true;
  const last = Date.parse(metricState?.last_alert_at || 0) || 0;
  if (!last) return true;
  return nowMs - last >= CONFIG.cooldownMinutes * 60 * 1000;
}

function makeMetricState(previous, patch){
  return {
    is_over_threshold: false,
    consecutive_high_runs: 0,
    alerted_for_current_episode: false,
    first_high_at: null,
    last_alert_at: previous?.last_alert_at || null,
    recovered_at: previous?.recovered_at || null,
    last_state_change_at: previous?.last_state_change_at || null,
    ...previous,
    ...patch
  };
}

function evaluateMetric({ key, label, value, threshold, priority, tags }, previousState, nowIso, nowMs){
  const prev = previousState || {};
  const isHigh = value > threshold;
  let changed = false;
  let alert = null;
  let next = makeMetricState(prev, {});

  if (isHigh){
    const wasHigh = prev.is_over_threshold === true;
    const prevRuns = Number(prev.consecutive_high_runs || 0);
    const nextRuns = wasHigh ? Math.min(CONFIG.requiredHighRuns, Math.max(1, prevRuns + 1)) : 1;

    next = makeMetricState(prev, {
      is_over_threshold: true,
      consecutive_high_runs: nextRuns,
      first_high_at: wasHigh ? (prev.first_high_at || nowIso) : nowIso,
      recovered_at: null,
      last_value: value,
      threshold,
      label
    });

    if (!wasHigh || nextRuns !== prevRuns || prev.last_value !== value || prev.threshold !== threshold){
      next.last_state_change_at = nowIso;
      changed = true;
    }

    if (nextRuns >= CONFIG.requiredHighRuns && !prev.alerted_for_current_episode && shouldPassCooldown(prev, nowMs)){
      alert = { key, label, value, threshold, priority, tags, consecutive_high_runs: nextRuns, first_high_at: next.first_high_at };
    }
  } else {
    next = makeMetricState(prev, {
      is_over_threshold: false,
      consecutive_high_runs: 0,
      alerted_for_current_episode: false,
      first_high_at: null,
      recovered_at: prev.is_over_threshold || Number(prev.consecutive_high_runs || 0) > 0 ? nowIso : (prev.recovered_at || null),
      last_value: value,
      threshold,
      label
    });

    if (prev.is_over_threshold || Number(prev.consecutive_high_runs || 0) > 0 || prev.alerted_for_current_episode || prev.last_value !== value || prev.threshold !== threshold){
      next.last_state_change_at = nowIso;
      changed = true;
    }
  }

  return { next, changed, alert };
}

async function sendNtfy(title, message, priority = "high", tags = "warning,magicpaws"){
  if (!boolFromEnv("NTFY_ENABLED", false)) {
    console.log(`NTFY disabled; would send: ${title}`);
    console.log(message);
    return false;
  }

  const url = process.env.NTFY_URL;
  if (!url) throw new Error("NTFY_URL missing although NTFY_ENABLED is true");

  const headers = {
    Title: title,
    Priority: String(priority),
    Tags: tags
  };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;

  const res = await fetch(url, { method:"POST", headers, body:message });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${await res.text()}`);
  return true;
}

function buildAlertText(alert, allValues, generatedAt){
  return [
    `${alert.label} liegt bei ${alert.value}% und damit über der Schwelle ${alert.threshold}%.`,
    `Auslösung erst nach ${alert.consecutive_high_runs} aufeinanderfolgenden Workflow-Läufen über Schwelle.`,
    `Erster hoher Lauf: ${alert.first_high_at || "unbekannt"}`,
    "",
    `Hybrid: ${allValues.hybrid}%`,
    `Government Weirdness Nordsee: ${allValues.gov_weirdness_north}%`,
    `Government Weirdness Ostsee: ${allValues.gov_weirdness_baltic}%`,
    `Stand: ${generatedAt}`
  ].join("\n");
}

async function main(){
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const { values, sources } = loadCurrentValues();

  const previousState = readJsonMaybe(STATE_PATH) || {};
  const state = {
    schema: "MAGIC_PAWS_NTFY_THRESHOLD_STATE_v2",
    version: "v5.51 Two-run threshold gate",
    thresholds: {
      hybrid: CONFIG.hybridThreshold,
      government_weirdness: CONFIG.weirdnessThreshold,
      required_high_runs: CONFIG.requiredHighRuns,
      cooldown_minutes: CONFIG.cooldownMinutes
    },
    sources,
    metrics: {
      ...(previousState.metrics || {})
    },
    alert_totals: {
      ...(previousState.alert_totals || {})
    },
    last_error: null
  };

  const metricDefs = [
    {
      key: "hybrid",
      label: "Hybrid-Index",
      value: values.hybrid,
      threshold: CONFIG.hybridThreshold,
      priority: "5",
      tags: "rotating_light,warning,magicpaws"
    },
    {
      key: "gov_weirdness_north",
      label: "Government Weirdness Nordsee",
      value: values.gov_weirdness_north,
      threshold: CONFIG.weirdnessThreshold,
      priority: "4",
      tags: "warning,ship,magicpaws"
    },
    {
      key: "gov_weirdness_baltic",
      label: "Government Weirdness Ostsee",
      value: values.gov_weirdness_baltic,
      threshold: CONFIG.weirdnessThreshold,
      priority: "4",
      tags: "warning,ship,magicpaws"
    }
  ];

  let stateChanged = false;
  const pendingAlerts = [];

  for (const def of metricDefs){
    const result = evaluateMetric(def, state.metrics[def.key], nowIso, nowMs);
    state.metrics[def.key] = result.next;
    if (result.changed) stateChanged = true;
    if (result.alert) pendingAlerts.push(result.alert);
  }

  const sent = [];
  const failed = [];

  for (const alert of pendingAlerts){
    const title = `MAGIC PAWS ${alert.label}: ${alert.value}%`;
    const message = buildAlertText(alert, values, nowIso);
    try {
      const wasSent = await sendNtfy(title, message, alert.priority, alert.tags);
      if (wasSent){
        state.metrics[alert.key].alerted_for_current_episode = true;
        state.metrics[alert.key].last_alert_at = nowIso;
        state.metrics[alert.key].last_state_change_at = nowIso;
        state.alert_totals[alert.key] = Number(state.alert_totals[alert.key] || 0) + 1;
        sent.push(alert.key);
        stateChanged = true;
      }
    } catch (err){
      const errorText = String(err?.message || err);
      failed.push({ key:alert.key, error:errorText });
      state.metrics[alert.key].last_alert_error = errorText;
      state.metrics[alert.key].last_state_change_at = nowIso;
      stateChanged = true;
    }
  }

  state.last_values = values;
  state.last_run = {
    at: nowIso,
    pending_alerts: pendingAlerts.map(a => a.key),
    sent,
    failed,
    ntfy_enabled: boolFromEnv("NTFY_ENABLED", false)
  };

  const oldSerialized = JSON.stringify(previousState.metrics || {});
  const newSerialized = JSON.stringify(state.metrics || {});
  if (CONFIG.writeStateEveryRun || stateChanged || oldSerialized !== newSerialized){
    writeJson(STATE_PATH, state);
  } else {
    console.log("No threshold state change; state file not rewritten.");
  }

  console.log(JSON.stringify({
    ok: failed.length === 0,
    at: nowIso,
    values,
    thresholds: state.thresholds,
    pending_alerts: pendingAlerts.map(a => ({ key:a.key, value:a.value, consecutive_high_runs:a.consecutive_high_runs })),
    alerts_sent: sent,
    alerts_failed: failed,
    state_written: CONFIG.writeStateEveryRun || stateChanged || oldSerialized !== newSerialized
  }, null, 2));

  if (failed.length) process.exitCode = 1;
}

main().catch(err => {
  const nowIso = new Date().toISOString();
  const previousState = readJsonMaybe(STATE_PATH) || {};
  const state = {
    ...previousState,
    schema: "MAGIC_PAWS_NTFY_THRESHOLD_STATE_v2",
    version: "v5.51 Two-run threshold gate",
    last_error: String(err?.stack || err?.message || err),
    last_run: {
      at: nowIso,
      ok: false
    }
  };
  writeJson(STATE_PATH, state);
  console.error(err);
  process.exitCode = 1;
});
