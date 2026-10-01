import type { Db } from "../db";
import { AT_RISK_FRACTION, PRIORITIES, type Priority } from "../config";

type Buckets = { late: number; at_risk: number; on_track: number };

export async function getStats(db: Db, now: Date) {
  const rows = await db.ticket.findMany({
    where: { status: "open", priority: { not: null }, dueAt: { not: null } },
    select: { priority: true, createdAt: true, dueAt: true },
  });
  const out = Object.fromEntries(
    PRIORITIES.map((p) => [p, { late: 0, at_risk: 0, on_track: 0 }]),
  ) as Record<Priority, Buckets>;

  for (const r of rows) {
    const due = r.dueAt!.getTime();
    const total = due - r.createdAt.getTime();
    const left = due - now.getTime();
    const bucket: keyof Buckets = left <= 0 ? "late" : left < total * AT_RISK_FRACTION ? "at_risk" : "on_track";
    out[r.priority!][bucket]++;
  }
  return out;
}