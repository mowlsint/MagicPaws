# Magic Paws ntfy Ingest-Umgebung

Ergänze in deinem bestehenden `.github/workflows/ingest.yml` im Schritt, der `node scripts/ingest.mjs` ausführt, diese env-Werte:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  NTFY_ENABLED: ${{ secrets.NTFY_ENABLED }}
  NTFY_URL: ${{ secrets.NTFY_URL }}
  NTFY_TOKEN: ${{ secrets.NTFY_TOKEN }}
  NTFY_MIN_LEVEL: HIGH
```

GitHub Secrets:

- `NTFY_ENABLED` = `true`
- `NTFY_URL` = `https://ntfy.sh/<dein-langer-zufalls-topic>` oder dein eigener ntfy-Server/Topic
- `NTFY_TOKEN` = optional, nur bei geschütztem Topic

Push erfolgt nur ab `ALERT:HIGH`. `ALERT:WATCH` erscheint nur im Dashboard.
