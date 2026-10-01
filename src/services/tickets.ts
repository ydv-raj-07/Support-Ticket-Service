import { z } from "zod";
import { Prisma } from "../generated/prisma/client";
import type { Db } from "../db";
import { PLANS, SLA_HOURS, type Priority } from "../config";
import type { Deps } from "../types";

export const newTicketSchema = z.object({
  external_id: z.string().min(1),
  customer_id: z.string().min(1),
  customer_plan: z.string(),   
  subject: z.string(),
  body: z.string(),
  created_at: z.string(),
});
export type NewTicket = z.infer<typeof newTicketSchema>;

export function normalizeCreatedAt(raw: string): Date | null {
  let s = raw.trim().replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z"; 
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export const computeDueAt = (createdAt: Date, priority: Priority) =>
  new Date(createdAt.getTime() + SLA_HOURS[priority] * 3600_000);

async function insertTicket(db: Db, t: NewTicket, createdAt: Date) {
  const plan = ((PLANS as readonly string[]).includes(t.customer_plan) ? t.customer_plan : "unknown") as
    "free" | "pro" | "enterprise" | "unknown";
  try {
    const ticket = await db.ticket.create({
      data: { externalId: t.external_id, customerId: t.customer_id, customerPlan: plan,
              subject: t.subject, body: t.body, createdAt },
    });
    return { ticket, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const ticket = await db.ticket.findUniqueOrThrow({ where: { externalId: t.external_id } });
      return { ticket, created: false };
    }
    throw e;
  }
}

export async function ingestTicket(deps: Pick<Deps, "db" | "enqueue">, raw: unknown) {
  const parsed = newTicketSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: z.flattenError(parsed.error) };
  const createdAt = normalizeCreatedAt(parsed.data.created_at);
  if (!createdAt) return { ok: false as const, error: "invalid created_at" };

  const { ticket, created } = await insertTicket(deps.db, parsed.data, createdAt);
  if (created) deps.enqueue(ticket.id);  
  return { ok: true as const, ticket, created };
}