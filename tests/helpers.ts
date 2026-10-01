import { prisma } from "../src/db";
import { buildApp } from "../src/app";
import { createTriage } from "../src/services/triage";
import type { AiClient } from "../src/AI/types";

const active: ReturnType<typeof createTriage>[] = [];
export const drainAll = () => Promise.all(active.splice(0).map((t) => t.drain()));

export const resetDb = () => {
  if (!process.env.DATABASE_URL?.includes("test")) {
    throw new Error("Refusing to wipe a non-test database. Check .env.test");
  }
  return prisma.$executeRawUnsafe('TRUNCATE "AiCall","TicketEvent","Ticket" RESTART IDENTITY CASCADE');
};

export const sample = (o: Record<string, unknown> = {}) => ({
  external_id: "T-1", customer_id: "C-1", customer_plan: "pro",
  subject: "Charged twice", body: "I was charged twice this month",
  created_at: "2026-09-20T09:00:00Z", ...o,
});

export function makeApp(ai: AiClient, now = new Date("2026-09-20T10:00:00Z")) {
  const clock = () => now;
  const triage = createTriage({ db: prisma, ai, clock, timeoutMs: 500 });
  active.push(triage);
  const app = buildApp({ db: prisma, enqueue: triage.enqueue, clock });
  return { app, triage };
}