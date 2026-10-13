# Weekly monitor report

A GitHub Actions workflow that queries Grafana and emails a weekly HTML report with tenant status, instance CPU/disk utilisation, and unique errors.

## What is already implemented

- `.github/workflows/weekly-monitor-report.yml` runs every Tuesday at **10:00 IST** and can be run manually from the Actions page.
- `scripts/send_weekly_report.ts` queries Grafana's documented `POST /api/ds/query` endpoint for the completed Tuesday-to-Tuesday week, converts Grafana table frames to HTML tables, and sends an HTML email.
- `config/report.json` maps the three expected report tables to their Grafana queries and output columns.

> The supplied `http://monitor.on.loopr.ai/dashboard/36` URL identifies itself as **Uptime Kuma**, rather than Grafana. This workflow queries Grafana directly, as requested. The actual Grafana URL and the three panel queries still need to be supplied.

## One-time configuration

### 1. Add GitHub Actions secrets

In **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `GRAFANA_URL` | Grafana base URL, e.g. `https://grafana.example.com` |
| `GRAFANA_TOKEN` | Read-only Grafana service-account token with access to the required data sources |
| `SMTP_HOST` | SMTP host |
| `SMTP_PORT` | `587` for STARTTLS or `465` for implicit TLS |
| `SMTP_USE_SSL` | `false` for port 587; `true` for port 465 |
| `SMTP_USERNAME` | SMTP username |
| `SMTP_PASSWORD` | SMTP password or app password |
| `SMTP_FROM` | Sender address |
| `REPORT_RECIPIENTS` | Recipient address(es), comma-separated |

For Microsoft 365, use an approved SMTP relay or an app/password mechanism permitted by your organisation. Do not commit these values to the repository.

### 2. Copy the Grafana queries into `config/report.json`

Each entry must be a valid Grafana `/api/ds/query` query object. Replace the placeholder datasource UIDs and `expr` values with the query configuration from the corresponding Grafana panel. Preserve the `refId`, `datasource`, and query-type-specific fields required by its data source.

The response must be formatted as a Grafana **table** and have the configured field names:

- `tenant_checks`: `tenant`, `sanity_check`, `kuma_and_elk`
- `instances`: `instance`, `cpu`, `disk`
- `errors`: `unique_error`, `instances`, `occurrences`

The errors query receives the same completed seven-day range as the rest of the report. The workflow filters it to errors whose `occurrences` value is at least `errorReport.minimumOccurrences` (currently `10`), then includes the count in the email. Change those two settings in `config/report.json` if the field name or high-occurrence threshold differs.

If Grafana returns different field names, edit the `fields` keys (left-hand side) in `config/report.json`; the displayed headings are on the right-hand side.

### 3. Set timezone and schedule

GitHub Actions schedules are always UTC. The committed schedule is 10:00 IST (04:30 UTC):

```yaml
- cron: "30 4 * * 2"
```

`REPORT_TIMEZONE` is set to `Asia/Kolkata`, so the Tuesday-to-Tuesday query window and subject date use IST.

## Testing

Use **Actions → Weekly monitor report → Run workflow** after adding secrets and configuring queries. Set `REPORT_RECIPIENTS` to `namrata.shirdhankar@loopr.ai` in GitHub Secrets. GitHub will never print secret values. A query or SMTP failure fails the workflow, which makes the delivery problem visible in the Actions run.

The workflow uses GitHub-hosted runners. If Grafana or SMTP is reachable only on Loopr's private network, change `runs-on: ubuntu-latest` to the label of a secured self-hosted runner with access to both services.
