export type Row = Record<string, unknown>;
export type Sample = { metric: Record<string, string>; value: [number, string] };
export type SourceQuery = {
  source?: "prometheus-instances" | "loki-errors" | "uptime-kuma";
  datasource?: { uid: string };
  cpuExpr?: string;
  diskExpr?: string;
  expr?: string;
};

async function instantQuery(baseUrl: string, token: string, uid: string, path: string, expr: string, end: Date): Promise<Sample[]> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/datasources/proxy/uid/${encodeURIComponent(uid)}/${path}`);
  url.searchParams.set("query", expr);
  url.searchParams.set("time", String(end.getTime() / 1000));
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new Error(`Cannot reach Grafana ${uid}; check network access and datasource permissions`);
  }
  if (!response.ok) throw new Error(`Grafana ${uid} query failed: HTTP ${response.status}`);
  const data = await response.json() as { status: string; data?: { resultType: string; result: Sample[] } };
  if (data.status !== "success" || data.data?.resultType !== "vector") throw new Error(`Grafana ${uid} must return a successful instant vector`);
  return data.data.result;
}

export function instanceRows(cpu: Sample[], disk: Sample[]): Row[] {
  const rows = new Map<string, Row>();
  for (const [field, samples] of [["cpu", cpu], ["disk", disk]] as const) {
    for (const sample of samples) {
      const instance = sample.metric.instance;
      if (!instance) throw new Error("Instance metric is missing its instance label");
      const row = rows.get(instance) ?? { instance, cpu: "N/A", disk: "N/A" };
      const number = Number(sample.value[1]);
      row[field] = Number.isFinite(number) ? `${number.toFixed(2)}%` : "N/A";
      rows.set(instance, row);
    }
  }
  if (!rows.size) throw new Error("Grafana returned no CPU or disk metrics; refusing to send an empty instance report");
  return [...rows.values()].sort((a, b) => String(a.instance).localeCompare(String(b.instance)));
}

export function errorRows(samples: Sample[], minimumOccurrences: number): Row[] {
  const groups = new Map<string, { message: string; code: string; instances: Set<string>; count: number }>();
  for (const sample of samples) {
    const message = sample.metric.error_message;
    const code = sample.metric.error_code ?? "";
    const count = Number(sample.value[1]);
    if (!message || !Number.isFinite(count)) throw new Error("Unexpected error count result from Loki");
    const key = JSON.stringify([message, code]);
    const group = groups.get(key) ?? { message, code, instances: new Set<string>(), count: 0 };
    group.count += count;
    group.instances.add(sample.metric.instance ?? "Unknown instance");
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.count >= minimumOccurrences)
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .map((group) => ({ unique_error: group.code ? `${group.message} — ${group.code}` : group.message, instances: [...group.instances].sort().join(", "), occurrences: group.count }));
}

export async function collectGrafanaSource(baseUrl: string, token: string, query: SourceQuery, now: Date, minimumOccurrences: number): Promise<Row[]> {
  const uid = query.datasource?.uid;
  if (!uid) throw new Error("Grafana datasource UID is required");
  if (query.source === "prometheus-instances") {
    if (!query.cpuExpr || !query.diskExpr) throw new Error("CPU and disk expressions are required");
    const [cpu, disk] = await Promise.all([
      instantQuery(baseUrl, token, uid, "api/v1/query", query.cpuExpr, now),
      instantQuery(baseUrl, token, uid, "api/v1/query", query.diskExpr, now),
    ]);
    return instanceRows(cpu, disk);
  }
  if (query.source === "loki-errors") {
    if (!query.expr) throw new Error("Loki aggregation expression is required");
    return errorRows(await instantQuery(baseUrl, token, uid, "loki/api/v1/query", query.expr, now), minimumOccurrences);
  }
  throw new Error("Unsupported Grafana report source");
}
