import { io } from "socket.io-client";
import type { Row } from "./grafana_sources.js";

type Monitor = { id: number; name: string; active: boolean };
type Beat = { status: number; time?: string };
export type TenantMonitor = { tenant: string; monitorId: number };

export function tenantRows(mapping: TenantMonitor[], monitors: Record<string, Monitor>, beats: Map<number, Beat>, uptime: Map<number, number>): Row[] {
  return mapping.map(({ tenant, monitorId }) => {
    const monitor = monitors[String(monitorId)];
    if (!monitor) throw new Error(`Kuma monitor ${monitorId} is missing for ${tenant}`);
    const beat = beats.get(monitorId);
    const status = !monitor.active ? "Paused" : !beat ? "Unknown" : ({ 0: "Down", 1: "OK", 2: "Pending", 3: "Maintenance" } as Record<number, string>)[beat.status] ?? "Unknown";
    const ratio = uptime.get(monitorId);
    const percentage = typeof ratio === "number" && Number.isFinite(ratio) ? `${(ratio * 100).toFixed(2)}%` : "N/A";
    return { tenant, sanity_check: "Not collected", kuma_and_elk: `${status} — ${percentage}` };
  });
}

export async function collectKuma(baseUrl: string, mapping: TenantMonitor[]): Promise<Row[]> {
  if (!mapping.length) throw new Error("Tenant-to-Kuma monitor mapping is required");
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, { autoConnect: false, reconnection: false, timeout: 15_000, transports: ["polling", "websocket"] });
    let monitors: Record<string, Monitor> = {};
    const beats = new Map<number, Beat>();
    const uptime = new Map<number, number>();
    let settle: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => finish(new Error("Kuma did not provide complete tenant monitor/uptime data within 45 seconds")), 45_000);
    function finish(error?: Error): void {
      clearTimeout(deadline);
      if (settle) clearTimeout(settle);
      socket.disconnect();
      if (error) reject(error);
      else {
        try { resolve(tenantRows(mapping, monitors, beats, uptime)); }
        catch (cause) { reject(cause); }
      }
    }
    function ready(): void {
      if (mapping.every(({ monitorId }) => monitors[String(monitorId)] && uptime.has(monitorId))) {
        // Allow initial heartbeat batches to arrive. If none arrive, report Unknown rather than OK.
        if (!settle) settle = setTimeout(() => finish(), 3_000);
      }
    }
    socket.on("connect_error", () => finish(new Error("Cannot connect to Kuma monitor feed")));
    socket.on("monitorList", (list: Record<string, Monitor>) => { monitors = list; ready(); });
    socket.on("heartbeatList", (id: number, list: Beat[]) => {
      if (list.length) beats.set(Number(id), list[list.length - 1]);
      ready();
    });
    socket.on("heartbeat", (beat: Beat & { monitorID: number }) => { beats.set(Number(beat.monitorID), beat); ready(); });
    socket.on("uptime", (id: number, hours: number, ratio: number) => {
      if (Number(hours) === 24) uptime.set(Number(id), ratio);
      ready();
    });
    socket.connect();
  });
}
