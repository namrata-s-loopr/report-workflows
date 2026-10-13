# Weekly monitor report

TypeScript GitHub Actions workflow scheduled for **Tuesday, 10:00 AM IST** (`30 4 * * 2` UTC), using the `Production` GitHub Environment. It sends HTML through an email API, not SMTP.

## Current status

- **CPU and disk implemented and live-tested:** `grafanacloud-prom`, discovered using the existing Codex Grafana MCP configuration. CPU is current five-minute utilisation (non-idle time); disk is current root-filesystem usage. These are snapshots, not weekly averages. Missing metrics display `N/A`, never `OK`.
- **Errors implemented and live-tested:** `grafanacloud-logs`, application Docker logs labelled `level="ERROR"`. Loki counts all matching structured JSON messages over the rolling last seven days—not a limited sample of log lines. Exact message/error-code pairs are combined across instances, filtered to at least 10 occurrences, and sorted by descending total count. This scope excludes WARN, unstructured logs and messages without a JSON `message` field.
- **Tenant monitor status implemented and live-tested:** the Kuma Socket.IO feed at `http://monitor.on.loopr.ai` currently exposes monitor data without login. The six screenshot tenants map to production groups in `config/report.json`. The report includes current status and Kuma's supplied 24-hour uptime; paused groups are explicitly marked Paused. Sanity checks are **Not collected**; this feed does not establish manual sanity results or ELK health. If authentication is enabled in future, this adapter will fail rather than invent status.
- **Email API contract unverified:** configurable JSON body is available, but the endpoint's actual field names and success response still need confirmation. No successful email delivery has been verified.

## Production environment secrets

Configure these in **Settings → Environments → Production → Environment secrets**:

| Secret | Value |
|---|---|
| `GRAFANA_URL` | Grafana base URL (`https://loopr.grafana.net`) |
| `GRAFANA_TOKEN` | Read-only service-account token with metrics/logs query permissions |
| `EMAIL_API_URL` | Complete email API endpoint including any secret embedded in the URL |
| `REPORT_RECIPIENTS` | Recipient address(es), comma-separated |

Keep secrets out of source files. `EMAIL_API_URL` is never intentionally printed, nor are its response body or fetch exception details, since they could contain the secret URL.

## Email API body

`config/report.json` contains `emailApi.payload`. The default request is a JSON `POST`:

```json
{
  "to": "{{recipients}}",
  "subject": "{{subject}}",
  "html": "{{html}}",
  "text": "{{text}}"
}
```

Change the field names/nesting to match the actual API. These placeholders are substituted recursively at runtime. A non-2xx HTTP response fails the run; a 2xx only indicates that the API accepted the request, not that delivery was confirmed.

## Grafana configuration

`config/report.json` defines two source adapters:

- `instances.source = prometheus-instances`: joins `cpuExpr` and `diskExpr` instant-query vectors on the instance label.
- `errors.source = loki-errors`: evaluates a seven-day count aggregation and combines counts across instances. `errorReport.minimumOccurrences` controls the minimum combined count (default 10).

Output headings are configured under each section's `fields`. The tenant section uses `source = uptime-kuma` and explicit production-monitor IDs; sanity results remain Not collected until a genuine source is added.

## Testing and running

```sh
npm ci
npm test
npm run send-report
```

`npm test` type-checks and tests the instance joining and error aggregation. `npm run send-report -- config/report.json --dry-run` writes local HTML without sending mail, but still requires the current secret variables and complete source configuration.

Use **Actions → Weekly monitor report → Run workflow** to test data collection and the email API contract. Ensure that Production environment protection rules permit scheduled execution without manual approval if unattended delivery is required.

GitHub-hosted runners must reach Grafana, Kuma and the email API. Use a secured self-hosted runner if any endpoint is private. Scheduled GitHub Actions may be delayed; the cron expresses the intended start time, not guaranteed exact delivery.
