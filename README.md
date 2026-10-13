# Weekly monitor report

A GitHub Actions workflow that queries Grafana and sends a weekly HTML report through an email API, with tenant status, instance CPU/disk utilisation, and unique errors.

## What is already implemented

- `.github/workflows/weekly-monitor-report.yml` runs every Tuesday at **10:00 IST** and can be run manually from the Actions page.
- `scripts/send_weekly_report.ts` queries Grafana's documented `POST /api/ds/query` endpoint for the completed Tuesday-to-Tuesday week, converts Grafana table frames to HTML tables, and sends them to the configured email API.
- `config/report.json` maps the three expected report tables to their Grafana queries and output columns.

> The supplied `http://monitor.on.loopr.ai/dashboard/36` URL identifies itself as **Uptime Kuma**, rather than Grafana. This workflow queries Grafana directly, as requested. The actual Grafana URL and the three panel queries still need to be supplied.

## One-time configuration

### 1. Add GitHub Actions secrets

In **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `GRAFANA_URL` | Grafana base URL, e.g. `https://grafana.example.com` |
| `GRAFANA_TOKEN` | Read-only Grafana service-account token with access to the required data sources |
| `EMAIL_API_URL` | Complete API endpoint URL, including any secret embedded in the URL |
| `REPORT_RECIPIENTS` | Recipient address(es), comma-separated |

Do not commit the API URL to the repository. These secrets are read from the `Production` GitHub Environment.

### 2. Configure the email API payload and Grafana queries

The workflow sends `POST` JSON to `EMAIL_API_URL`. Its default payload is:

```json
{
  "to": "{{recipients}}",
  "subject": "{{subject}}",
  "html": "{{html}}",
  "text": "{{text}}"
}
```

If the API uses different names or nesting, edit `emailApi.payload` in `config/report.json`. The placeholders are replaced just before the request; do not add secrets to this file.

### 3. Copy the Grafana queries into `config/report.json`

Each entry must be a valid Grafana `/api/ds/query` query object. Replace the placeholder datasource UIDs and `expr` values with the query configuration from the corresponding Grafana panel. Preserve the `refId`, `datasource`, and query-type-specific fields required by its data source.

The response must be formatted as a Grafana **table** and have the configured field names:

- `tenant_checks`: `tenant`, `sanity_check`, `kuma_and_elk`
- `instances`: `instance`, `cpu`, `disk`
- `errors`: `unique_error`, `instances`, `occurrences`

The errors query receives the same completed seven-day range as the rest of the report. The workflow filters it to errors whose `occurrences` value is at least `errorReport.minimumOccurrences` (currently `10`), then includes the count in the email. Change those two settings in `config/report.json` if the field name or high-occurrence threshold differs.

If Grafana returns different field names, edit the `fields` keys (left-hand side) in `config/report.json`; the displayed headings are on the right-hand side.

### 4. Set timezone and schedule

GitHub Actions schedules are always UTC. The committed schedule is 10:00 IST (04:30 UTC):

```yaml
- cron: "30 4 * * 2"
```

`REPORT_TIMEZONE` is set to `Asia/Kolkata`, so the Tuesday-to-Tuesday query window and subject date use IST.

## Testing

Use **Actions → Weekly monitor report → Run workflow** after adding secrets and configuring queries. Set `REPORT_RECIPIENTS` to `namrata.shirdhankar@loopr.ai` in the `Production` environment secrets. GitHub will never print secret values. A query or email-API failure fails the workflow, which makes the delivery problem visible in the Actions run.

The workflow uses GitHub-hosted runners. If Grafana or SMTP is reachable only on Loopr's private network, change `runs-on: ubuntu-latest` to the label of a secured self-hosted runner with access to both services.
