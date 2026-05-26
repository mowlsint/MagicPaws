# MAGIC PAWS Live Sensors v5.34

This package adds a first, bounded AIS/ADS-B sensor layer for Government Weirdness.

## New files

- `config/live_sensor_regions.yml` — North Sea/Channel and Baltic BBoxes plus ADS-B radius tiles.
- `scripts/fetch_aisstream.mjs` — AISstream WebSocket sample collector.
- `scripts/fetch_adsb.mjs` — adsb.fi public radius collector.
- `.github/workflows/magicpaws_fetch_ais.yml` — runs every 30 minutes.
- `.github/workflows/magicpaws_fetch_adsb.yml` — runs every 15 minutes.
- `data/live/ais_latest.json` and `data/live/adsb_latest.json` — current live sensor snapshots.

## Required secret

Set this GitHub Actions secret:

```text
AISSTREAM_API_KEY=<your aisstream.io key>
```

ADS-B uses the public `adsb.fi` open data endpoint by default and needs no key for this first stage.

## Dashboard logic

Government Weirdness now uses:

1. Live AIS authority-like vessels in North Sea/Channel and Baltic.
2. AIS authority clusters: more than two authority-like vessels within 5 NM.
3. Live ADS-B authority/military/SAR/MPA-like aircraft in the same BBoxes.
4. Authority-report anomaly over 24h against the last 14 days, with weekend/weekday comparison and ±25% threshold.
5. NAVTEX/NAVWARN vital messages and clustered obstacle/hazard messages.

Hybrid Index also gets a bounded NAVTEX/NAVWARN vital-message boost.
