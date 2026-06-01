#!/usr/bin/env node
/**
 * MAGIC PAWS // ntfy threshold alerts
 * Version: v5.52 "Canonical sensor threshold values"
 *
 * Purpose:
 *   Sends ntfy notifications only from the same current sensor values shown in
 *   the dashboard/snapshot, not from legacy daily proxy values.
 *
 * Default rules:
 *   - Hybrid-Seismograph > 75% for 2 consecutive workflow runs
 *   - Government Weirdness North Sea > 60% for 2 consecutive workflow runs
 *   - Government Weirdness Baltic Sea > 60% for 2 consecutive workflow runs
 *
 * Important change from v5.51:
 *   The Hybrid alert no longer uses hybrid_index_pct or daily_summary
 *   hybrid_index_proxy as a trigger. It uses, in order:
 *     1) sensors.ntfy_hybrid_alert_pct
 *     2) sensors.hybrid_seismograph_pct
 *
 *   Legacy hybrid_index_pct is recorded only as diagnostic unless explicitly
 *   enabled via MAGICPAWS_ALLOW_LEGACY_HYBRID_SOURCE=true.
 *
 * Designed for GitHub Actions. Uses only Node 18+ built-ins.
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
  writeStateEveryRun: boolFromEnv("MAGICPAWS_ALERT_WRITE_STATE_EVERY_RUN", false),
  maxSensorAgeHours: Math.max(1, numberFromEnv("MAGICPAWS_SENSOR_MAX_AGE_HOURS", 18)),
  allowLegacyHybridSource: boolFromEnv("MAGICPAWS_ALLOW_LEGACY_HYBRID_SOURCE", false)
};

const SENSOR_CANDIDATE_PATHS = [
  "data/snapshots/voodoo_sensor_latest.json",
  "data/snapshots/magicpaws_sensor_latest.json",
  "voodoo_sensor_latest.json",
  "magicpaws_sensor_latest.json"
];

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

function cleanSecret(value){
  return String(value || "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

function readJsonMaybe(relOrAbs){
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function writeJson(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function dateMs(value){
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : 0;
}

function sensorTimestampMs(sensor){
  const candidates = [
    sensor?.generated_at,
    sensor?.ts,
    sensor?.snapshot_key,
    sensor?.bucket_end_utc,
    sensor?.exported_at,
    sensor?.created_at,
    sensor?.updated_at
  ];
  for (const c of candidates){
    const t = dateMs(c);
    if (t) return t;
  }
  return 0;
}

function sensorTimestampIso(sensor){
  const ms = sensorTimestampMs(sensor);
  return ms ? new Date(ms).toISOString() : null;
}

function sensorAgeHours(sensor, nowMs = Date.now()){
  const ms = sensorTimestampMs(sensor);
  if (!ms) return null;
  return Math.max(0, (nowMs - ms) / 36e5);
}

function findNumberWithPath(obj, paths){
  for (const p of paths){
    const parts = p.split(".");
    let cur = obj;
    for (const part of parts) cur = cur?.[part];
    const n = Number(cur);
    if (Number.isFinite(n)) return { value:n, path:p };
  }
  return { value:null, path:null };
}

function hasAnyNumber(obj, paths){
  return findNumberWithPath(obj, paths).value !== null;
}

function loadSensorCandidates(nowMs = Date.now()){
  const candidates = [];
  for (const rel of SENSOR_CANDIDATE_PATHS){
    const data = readJsonMaybe(rel);
    if (!data) continue;
    const ageHours = sensorAgeHours(data, nowMs);
    const timestamp = sensorTimestampIso(data);
    const hasCanonicalHybrid = hasAnyNumber(data, [
      "sensors.ntfy_hybrid_alert_pct",
      "sensors.hybrid_seismograph_pct"
    ]);
    const hasLegacyHybrid = hasAnyNumber(data, [
      "sensors.hybrid_index_pct",
      "hybrid_index_pct",
      "hybrid_index"
    ]);
    const hasGov = hasAnyNumber(data, [
      "sensors.government_weirdness.north_sea_pct",
      "sensors.government_weirdness.baltic_sea_pct",
      "government_weirdness.north_sea_pct",
      "government_weirdness.baltic_sea_pct"
    ]);
    candidates.push({
      path: rel,
      data,
      timestamp,
      age_hours: ageHours,
      fresh: ageHours !== null && ageHours <= CONFIG.maxSensorAgeHours,
      has_canonical_hybrid: hasCanonicalHybrid,
      has_legacy_hybrid: hasLegacyHybrid,
      has_government_weirdness: hasGov
    });
  }
  candidates.sort((a, b) => (sensorTimestampMs(b.data) || 0) - (sensorTimestampMs(a.data) || 0));
  return candidates;
}

function selectSensorCandidate(candidates){
  const usableFresh = candidates.filter(c => c.fresh && (c.has_canonical_hybrid || c.has_government_weirdness));
  if (usableFresh.length) return usableFresh[0];
  const freshest = candidates[0] || null;
  return freshest;
}

function loadCurrentValues(){
  const nowMs = Date.now();
  const candidates = loadSensorCandidates(nowMs);
  const selected = selectSensorCandidate(candidates);
  const sensor = selected?.data || {};

  const sensorFresh = !!(selected && selected.fresh);

  const hybridPrimary = findNumberWithPath(sensor, [
    "sensors.ntfy_hybrid_alert_pct",
    "sensors.hybrid_seismograph_pct"
  ]);

  const hybridLegacy = findNumberWithPath(sensor, [
    "sensors.hybrid_index_pct",
    "hybrid_index_pct",
    "hybrid_index",
    "hybridIndex",
    "phase_zero_index",
    "p0_pct",
    "metrics.hybrid_index",
    "metrics.phase_zero_index"
  ]);

  const hybridPeak = findNumberWithPath(sensor, [
    "sensors.ntfy_hybrid_72h_peak_pct",
    "sensors.hybrid_72h_peak_pct",
    "hybrid_72h_peak_pct"
  ]);

  const weirdNorth = findNumberWithPath(sensor, [
    "sensors.government_weirdness.north_sea_pct",
    "sensors.government_weirdness.north_sea",
    "sensors.government_weirdness.north_pct",
    "sensors.government_weirdness.north",
    "government_weirdness.north_sea_pct",
    "government_weirdness.north_sea",
    "government_weirdness.north_pct",
    "government_weirdness.north",
    "weirdness.north_sea_pct",
    "weirdness.north_sea"
  ]);

  const weirdBaltic = findNumberWithPath(sensor, [
    "sensors.government_weirdness.baltic_sea_pct",
    "sensors.government_weirdness.baltic_sea",
    "sensors.government_weirdness.baltic_pct",
    "sensors.government_weirdness.baltic",
    "government_weirdness.baltic_sea_pct",
    "government_weirdness.baltic_sea",
    "government_weirdness.baltic_pct",
    "government_weirdness.baltic",
    "weirdness.baltic_sea_pct",
    "weirdness.baltic_sea"
  ]);

  const hybridValue = sensorFresh
    ? (hybridPrimary.value ?? (CONFIG.allowLegacyHybridSource ? hybridLegacy.value : null))
    : null;

  return {
    values: {
      hybrid: hybridValue === null ? null : Math.round(clamp(hybridValue, 0, 100)),
      gov_weirdness_north: sensorFresh && weirdNorth.value !== null ? Math.round(clamp(weirdNorth.value, 0, 100)) : null,
      gov_weirdness_baltic: sensorFresh && weirdBaltic.value !== null ? Math.round(clamp(weirdBaltic.value, 0, 100)) : null,
      hybrid_72h_peak: sensorFresh && hybridPeak.value !== null ? Math.round(clamp(hybridPeak.value, 0, 100)) : null
    },
    sources: {
      selected_sensor: selected?.path || null,
      selected_sensor_timestamp: selected?.timestamp || null,
      selected_sensor_age_hours: selected?.age_hours === null || selected?.age_hours === undefined ? null : Number(selected.age_hours.toFixed(2)),
      max_sensor_age_hours: CONFIG.maxSensorAgeHours,
      sensor_is_fresh: sensorFresh,
      candidate_sensors: candidates.map(c => ({
        path:c.path,
        timestamp:c.timestamp,
        age_hours:c.age_hours === null || c.age_hours === undefined ? null : Number(c.age_hours.toFixed(2)),
        fresh:c.fresh,
        has_canonical_hybrid:c.has_canonical_hybrid,
        has_legacy_hybrid:c.has_legacy_hybrid,
        has_government_weirdness:c.has_government_weirdness
      }))
    },
    measurement_paths: {
      hybrid: sensorFresh ? (hybridPrimary.path || (CONFIG.allowLegacyHybridSource ? hybridLegacy.path : null)) : null,
      hybrid_legacy_detected: hybridLegacy.path,
      hybrid_legacy_value: hybridLegacy.value,
      hybrid_72h_peak: sensorFresh ? hybridPeak.path : null,
      gov_weirdness_north: sensorFresh ? weirdNorth.path : null,
      gov_weirdness_baltic: sensorFresh ? weirdBaltic.path : null
    },
    data_quality: {
      ok: sensorFresh && (hybridPrimary.value !== null || CONFIG.allowLegacyHybridSource),
      hybrid_uses_canonical_sensor: sensorFresh && hybridPrimary.value !== null,
      legacy_hybrid_source_allowed: CONFIG.allowLegacyHybridSource,
      note: sensorFresh
        ? "Threshold alerts use current dashboard/snapshot sensor values. Daily proxy values are not alert triggers."
        : "No fresh current sensor snapshot available. Threshold alerts are suppressed and metric episodes are reset."
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

function evaluateMetric({ key, label, value, threshold, priority, tags, measurement_path }, previousState, nowIso, nowMs){
  const prev = previousState || {};
  const finiteValue = Number(value);
  const hasValue = Number.isFinite(finiteValue);
  let changed = false;
  let alert = null;
  let next = makeMetricState(prev, {});

  if (!hasValue){
    next = makeMetricState(prev, {
      is_over_threshold: false,
      consecutive_high_runs: 0,
      alerted_for_current_episode: false,
      first_high_at: null,
      recovered_at: prev.is_over_threshold || Number(prev.consecutive_high_runs || 0) > 0 ? nowIso : (prev.recovered_at || null),
      last_value: null,
      threshold,
      label,
      measurement_path: measurement_path || null,
      unavailable_at: nowIso,
      unavailable_reason: "no_fresh_current_sensor_value"
    });
    if (prev.is_over_threshold || Number(prev.consecutive_high_runs || 0) > 0 || prev.alerted_for_current_episode || prev.last_value !== null){
      next.last_state_change_at = nowIso;
      changed = true;
    }
    return { next, changed, alert };
  }

  const roundedValue = Math.round(clamp(finiteValue, 0, 100));
  const isHigh = roundedValue > threshold;

  if (isHigh){
    const wasHigh = prev.is_over_threshold === true;
    const prevRuns = Number(prev.consecutive_high_runs || 0);
    const nextRuns = wasHigh ? Math.min(CONFIG.requiredHighRuns, Math.max(1, prevRuns + 1)) : 1;

    next = makeMetricState(prev, {
      is_over_threshold: true,
      consecutive_high_runs: nextRuns,
      first_high_at: wasHigh ? (prev.first_high_at || nowIso) : nowIso,
      recovered_at: null,
      last_value: roundedValue,
      threshold,
      label,
      measurement_path: measurement_path || null,
      unavailable_at: null,
      unavailable_reason: null
    });

    if (!wasHigh || nextRuns !== prevRuns || prev.last_value !== roundedValue || prev.threshold !== threshold || prev.measurement_path !== measurement_path){
      next.last_state_change_at = nowIso;
      changed = true;
    }

    if (nextRuns >= CONFIG.requiredHighRuns && !prev.alerted_for_current_episode && shouldPassCooldown(prev, nowMs)){
      alert = { key, label, value:roundedValue, threshold, priority, tags, consecutive_high_runs: nextRuns, first_high_at: next.first_high_at, measurement_path };
    }
  } else {
    next = makeMetricState(prev, {
      is_over_threshold: false,
      consecutive_high_runs: 0,
      alerted_for_current_episode: false,
      first_high_at: null,
      recovered_at: prev.is_over_threshold || Number(prev.consecutive_high_runs || 0) > 0 ? nowIso : (prev.recovered_at || null),
      last_value: roundedValue,
      threshold,
      label,
      measurement_path: measurement_path || null,
      unavailable_at: null,
      unavailable_reason: null
    });

    if (prev.is_over_threshold || Number(prev.consecutive_high_runs || 0) > 0 || prev.alerted_for_current_episode || prev.last_value !== roundedValue || prev.threshold !== threshold || prev.measurement_path !== measurement_path){
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

  const url = cleanSecret(process.env.NTFY_URL);
  if (!url) throw new Error("NTFY_URL missing although NTFY_ENABLED is true");
  try { new URL(url); }
  catch { throw new Error("NTFY_URL is not a valid absolute URL. Expected format: https://ntfy.sh/<topic>"); }

  const headers = {
    Title: title,
    Priority: String(priority),
    Tags: tags
  };
  const token = cleanSecret(process.env.NTFY_TOKEN);
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { method:"POST", headers, body:message });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${await res.text()}`);
  return true;
}

function fmtValue(value){
  return value === null || value === undefined ? "n/a" : `${value}%`;
}

function buildAlertText(alert, current, generatedAt){
  return [
    `${alert.label} liegt bei ${alert.value}% und damit über der Schwelle ${alert.threshold}%.`,
    `Auslösung erst nach ${alert.consecutive_high_runs} aufeinanderfolgenden Workflow-Läufen über Schwelle.`,
    `Erster hoher Lauf: ${alert.first_high_at || "unbekannt"}`,
    `Messpfad: ${alert.measurement_path || "unbekannt"}`,
    "",
    `Hybrid aktuell: ${fmtValue(current.values.hybrid)}`,
    `Hybrid 72h-Peak: ${fmtValue(current.values.hybrid_72h_peak)}`,
    `Government Weirdness Nordsee: ${fmtValue(current.values.gov_weirdness_north)}`,
    `Government Weirdness Ostsee: ${fmtValue(current.values.gov_weirdness_baltic)}`,
    "",
    `Sensorquelle: ${current.sources.selected_sensor || "keine"}`,
    `Sensorstand: ${current.sources.selected_sensor_timestamp || "unbekannt"}`,
    `Sensoralter: ${current.sources.selected_sensor_age_hours ?? "n/a"} h`,
    `Stand: ${generatedAt}`
  ].join("\n");
}

async function main(){
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const current = loadCurrentValues();
  const { values, sources, measurement_paths, data_quality } = current;

  const previousState = readJsonMaybe(STATE_PATH) || {};
  const state = {
    schema: "MAGIC_PAWS_NTFY_THRESHOLD_STATE_v3",
    version: "v5.52 Canonical sensor threshold values",
    thresholds: {
      hybrid: CONFIG.hybridThreshold,
      government_weirdness: CONFIG.weirdnessThreshold,
      required_high_runs: CONFIG.requiredHighRuns,
      cooldown_minutes: CONFIG.cooldownMinutes,
      max_sensor_age_hours: CONFIG.maxSensorAgeHours
    },
    sources,
    measurement_paths,
    data_quality,
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
      label: "Hybrid-Seismograph",
      value: values.hybrid,
      threshold: CONFIG.hybridThreshold,
      priority: "5",
      tags: "rotating_light,warning,magicpaws",
      measurement_path: measurement_paths.hybrid
    },
    {
      key: "gov_weirdness_north",
      label: "Government Weirdness Nordsee",
      value: values.gov_weirdness_north,
      threshold: CONFIG.weirdnessThreshold,
      priority: "4",
      tags: "warning,ship,magicpaws",
      measurement_path: measurement_paths.gov_weirdness_north
    },
    {
      key: "gov_weirdness_baltic",
      label: "Government Weirdness Ostsee",
      value: values.gov_weirdness_baltic,
      threshold: CONFIG.weirdnessThreshold,
      priority: "4",
      tags: "warning,ship,magicpaws",
      measurement_path: measurement_paths.gov_weirdness_baltic
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
    const message = buildAlertText(alert, current, nowIso);
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
    ntfy_enabled: boolFromEnv("NTFY_ENABLED", false),
    data_quality
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
    sources,
    measurement_paths,
    data_quality,
    pending_alerts: pendingAlerts.map(a => ({ key:a.key, value:a.value, consecutive_high_runs:a.consecutive_high_runs, measurement_path:a.measurement_path })),
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
    schema: "MAGIC_PAWS_NTFY_THRESHOLD_STATE_v3",
    version: "v5.52 Canonical sensor threshold values",
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
