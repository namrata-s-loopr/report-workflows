import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import nodemailer from "nodemailer";

type Row = Record<string, unknown>;
type Query = Record<string, unknown> & { refId: string; fields: Record<string, string> };
type Config = {
  title?: string;
  queries: Record<"tenant_checks" | "instances" | "errors", Query>;
  errorReport?: { minimumOccurrences?: number; occurrenceField?: string };
};

const requiredEnvironment = [
  "GRAFANA_URL", "GRAFANA_TOKEN", "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME",
  "SMTP_PASSWORD", "SMTP_FROM", "REPORT_RECIPIENTS",
] as const;

function environment(): Record<(typeof requiredEnvironment)[number], string> {
  const missing = requiredEnvironment.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return Object.fromEntries(requiredEnvironment.map((key) => [key, process.env[key]!])) as Record<(typeof requiredEnvironment)[number], string>;
}

function timezoneDate(date: Date, timezone: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number } {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => values.find((value) => value.type === type)?.value ?? "";
  return {
    year: Number(part("year")), month: Number(part("month")), day: Number(part("day")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday")),
    hour: Number(part("hour")), minute: Number(part("minute")),
  };
}

function zonedMidnightAsUtc(date: { year: number; month: number; day: number }, timezone: string): Date {
  // Iteratively match the local time to the requested midnight; this handles non-whole-hour offsets and DST.
  let candidate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const target = Date.UTC(date.year, date.month - 1, date.day);
  for (let i = 0; i < 3; i++) {
    const local = timezoneDate(candidate, timezone);
    const actual = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    candidate = new Date(candidate.getTime() + target - actual);
  }
  return candidate;
}

function reportWindow(timezone: string): { start: Date; end: Date; label: string } {
  const today = timezoneDate(new Date(), timezone);
  const daysSinceTuesday = (today.weekday - 2 + 7) % 7;
  const endDate = new Date(Date.UTC(today.year, today.month - 1, today.day) - daysSinceTuesday * 86_400_000);
  const startDate = new Date(endDate.getTime() - 7 * 86_400_000);
  const start = zonedMidnightAsUtc({ year: startDate.getUTCFullYear(), month: startDate.getUTCMonth() + 1, day: startDate.getUTCDate() }, timezone);
  const end = zonedMidnightAsUtc({ year: endDate.getUTCFullYear(), month: endDate.getUTCMonth() + 1, day: endDate.getUTCDate() }, timezone);
  return { start, end, label: start.toLocaleDateString("en-CA", { timeZone: "UTC" }) };
}

function rowsFromFrames(frames: unknown[]): Row[] {
  const rows: Row[] = [];
  for (const rawFrame of frames) {
    const frame = rawFrame as { schema?: { fields?: { name?: string }[] }; data?: { values?: unknown[][] } };
    const columns = frame.schema?.fields?.map((field) => field.name ?? "") ?? [];
    const values = frame.data?.values ?? [];
    const rowCount = Math.max(0, ...values.map((column) => column.length));
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      rows.push(Object.fromEntries(columns.map((column, columnIndex) => [column, values[columnIndex]?.[rowIndex] ?? ""])));
    }
  }
  return rows;
}

async function grafanaQuery(baseUrl: string, token: string, query: Query, start: Date, end: Date): Promise<Row[]> {
  const { fields: _fields, ...queryPayload } = query;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ds/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: String(start.getTime()), to: String(end.getTime()), queries: [queryPayload] }),
  });
  const resultJson = await response.json() as { message?: string; results?: Record<string, { error?: string; frames?: unknown[] }> };
  if (!response.ok) throw new Error(`Grafana query ${query.refId} failed: HTTP ${response.status} ${resultJson.message ?? ""}`);
  const result = resultJson.results?.[query.refId];
  if (!result) throw new Error(`Grafana did not return a result for query ${query.refId}`);
  if (result.error) throw new Error(`Grafana query ${query.refId} failed: ${result.error}`);
  return rowsFromFrames(result.frames ?? []);
}

function value(row: Row, field: string): string {
  const matchedKey = Object.keys(row).find((key) => key.toLowerCase() === field.toLowerCase());
  const raw = matchedKey ? row[matchedKey] : "";
  return raw === null || raw === undefined ? "" : String(raw);
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function table(rows: Row[], fields: Record<string, string>): string {
  const headings = Object.values(fields).map((heading) => `<th>${escapeHtml(heading)}</th>`).join("");
  const body = rows.length
    ? rows.map((row) => `<tr>${Object.keys(fields).map((key) => `<td>${escapeHtml(value(row, key))}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${Object.keys(fields).length}">No data</td></tr>`;
  return `<table><thead><tr>${headings}</tr></thead><tbody>${body}</tbody></table>`;
}

function buildEmail(config: Config, datasets: Record<string, Row[]>, label: string): { subject: string; html: string; text: string } {
  const title = config.title ?? "Weekly report";
  const sections: [string, keyof Config["queries"]][] = [["Tenant checks", "tenant_checks"], ["Instance health", "instances"], ["High-occurrence errors (last 7 days)", "errors"]];
  const content = sections.map(([heading, key]) => `<h2>${heading}</h2>${table(datasets[key], config.queries[key].fields)}`).join("\n");
  return {
    subject: `${title} for ${label}`,
    html: `<!doctype html><html><body><h1>${escapeHtml(title)} for ${escapeHtml(label)}</h1>${content}<p>Thanks,<br>Loopr monitoring</p><style>body{font-family:Arial,sans-serif;color:#111}table{border-collapse:collapse;margin:8px 0 36px;min-width:500px}th,td{border:1px solid #222;padding:4px 8px;text-align:left}th{font-weight:bold}</style></body></html>`,
    text: `${title} for ${label}\n\n${sections.map(([heading, key]) => `${heading}: ${datasets[key].length} row(s)`).join("\n")}`,
  };
}

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "config/report.json";
  const dryRun = process.argv.includes("--dry-run");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Config;
  if (!["tenant_checks", "instances", "errors"].every((key) => config.queries[key as keyof Config["queries"]])) throw new Error("Config must define tenant_checks, instances, and errors queries");
  const env = environment();
  const { start, end, label } = reportWindow(process.env.REPORT_TIMEZONE ?? "UTC");
  const datasets = Object.fromEntries(await Promise.all(Object.entries(config.queries).map(async ([key, query]) => [key, await grafanaQuery(env.GRAFANA_URL, env.GRAFANA_TOKEN, query, start, end)]))) as Record<string, Row[]>;
  const minimumOccurrences = config.errorReport?.minimumOccurrences;
  const occurrenceField = config.errorReport?.occurrenceField ?? "occurrences";
  if (minimumOccurrences !== undefined) datasets.errors = datasets.errors.filter((row) => Number(value(row, occurrenceField)) >= minimumOccurrences);
  const email = buildEmail(config, datasets, label);
  if (dryRun) return void await writeFile("weekly-report-preview.html", email.html);
  const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT), secure: process.env.SMTP_USE_SSL === "true", auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD }, requireTLS: process.env.SMTP_USE_SSL !== "true" });
  await transport.sendMail({ from: env.SMTP_FROM, to: env.REPORT_RECIPIENTS, subject: email.subject, text: email.text, html: email.html });
  console.log(`Sent ${JSON.stringify(email.subject)} to ${env.REPORT_RECIPIENTS}`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
