import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { prisma } from "../src/db";
import { getStats } from "../src/services/stats";
import { sweepStuck } from "../src/services/triage";
import { FakeAiClient, fakeReply } from "../src/AI/fakeclient";
import { drainAll, makeApp, resetDb, sample } from "./helpers";

const goodAnswer = { category: "billing", priority: "P2", summary: "Customer was charged twice." };

afterEach(drainAll);      
beforeEach(resetDb);

describe("ingestion", () => {
  it("saves the same external_id only once", async () => {
    const { app } = makeApp(fakeReply(goodAnswer));
    const [a, b] = await Promise.all([request(app).post("/tickets").send(sample()), request(app).post("/tickets").send(sample())]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await prisma.ticket.count()).toBe(1);
  });

  it("stores an invalid plan as unknown and sends it to manual review", async () => {
    const { app, triage } = makeApp(fakeReply(goodAnswer));
    await request(app).post("/tickets").send(sample({ customer_plan: "platinum" }));
    await triage.drain();
    const t = await prisma.ticket.findFirstOrThrow();
    expect(t).toMatchObject({ customerPlan: "unknown", triageDecision: "manual_review", reviewReason: "invalid_plan" });
  });
});

describe("triage", () => {
  it("does not call the AI for an empty ticket", async () => {
    const ai = fakeReply(goodAnswer);
    const { app, triage } = makeApp(ai);
    await request(app).post("/tickets").send(sample({ subject: "", body: "" }));
    await triage.drain();
    expect(ai.calls).toBe(0);
    expect((await prisma.ticket.findFirstOrThrow()).reviewReason).toBe("empty_ticket");
  });

  it("keeps the ticket and marks manual review when the AI throws", async () => {
    const { app, triage } = makeApp(new FakeAiClient(() => { throw new Error("boom"); }));
    await request(app).post("/tickets").send(sample());
    await triage.drain();
    expect(await prisma.ticket.findFirstOrThrow()).toMatchObject({ triageDecision: "manual_review", reviewReason: "ai_error" });
  });

  it("marks manual review when the AI is too slow", async () => {
    const slow = new FakeAiClient(() => new Promise(() => {}));   
    const { app, triage } = makeApp(slow);
    await request(app).post("/tickets").send(sample());
    await triage.drain();
    expect((await prisma.ticket.findFirstOrThrow()).reviewReason).toBe("ai_timeout");
  });

  it("applies the enterprise floor and records tokens", async () => {
    const { app, triage } = makeApp(fakeReply({ ...goodAnswer, priority: "P3" }));
    await request(app).post("/tickets").send(sample({ customer_plan: "enterprise" }));
    await triage.drain();
    expect(await prisma.ticket.findFirstOrThrow()).toMatchObject({ priority: "P1", triageDecision: "auto_accept" });
    expect((await prisma.aiCall.findFirstOrThrow()).inputTokens).toBe(10);
  });

  it("links a repeat ticket from the same customer to the first one", async () => {
    const { app, triage } = makeApp(fakeReply(goodAnswer));
    await request(app).post("/tickets").send(sample({ external_id: "A", created_at: "2026-09-20T09:00:00Z" }));
    await request(app).post("/tickets").send(sample({ external_id: "B", created_at: "2026-09-20T09:04:00Z" }));
    await triage.drain();
    const b = await prisma.ticket.findFirstOrThrow({ where: { externalId: "B" } });
    expect(b.duplicateOfId).toBe(1);
  });

  it("sweeps tickets stuck in pending", async () => {
    await prisma.ticket.create({ data: { externalId: "S", customerId: "C", customerPlan: "pro", subject: "x", body: "y",
      createdAt: new Date("2026-09-20T09:00:00Z"), receivedAt: new Date("2026-09-20T09:00:00Z") } });
    expect(await sweepStuck(prisma, new Date("2026-09-20T10:00:00Z"))).toBe(1);
    expect((await prisma.ticket.findFirstOrThrow()).triageDecision).toBe("manual_review");
  });
});

describe("agents", () => {
  const create = async (app: any) => (await request(app).post("/tickets").send(sample())).body.id as number;

  it("lets only one agent claim", async () => {
    const { app } = makeApp(fakeReply(goodAnswer));
    const id = await create(app);
    const [a, b] = await Promise.all([
      request(app).post(`/tickets/${id}/claim`).set("X-Agent-Id", "A1"),
      request(app).post(`/tickets/${id}/claim`).set("X-Agent-Id", "A2"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("allows only valid status moves", async () => {
    const { app } = makeApp(fakeReply(goodAnswer));
    const id = await create(app);
    const move = (status: string) => request(app).patch(`/tickets/${id}/status`).set("X-Agent-Id", "A1").send({ status });
    expect((await move("resolved")).status).toBe(409);      
    expect((await move("in_progress")).status).toBe(200);
    expect((await move("resolved")).status).toBe(200);
    expect((await move("open")).status).toBe(200);          
  });

  it("recomputes the deadline when an agent changes priority", async () => {
    const { app, triage } = makeApp(new FakeAiClient(() => ({ raw: "garbage", model: "fake", inputTokens: 1, outputTokens: 1 })));
    const id = await create(app);
    await triage.drain();                                    
    const res = await request(app).patch(`/tickets/${id}/triage`).set("X-Agent-Id", "A1")
      .send({ priority: "P0", reason: "customer is down" });
    expect(new Date(res.body.dueAt).toISOString()).toBe("2026-09-20T10:00:00.000Z");   
  });
});

describe("listing and stats", () => {
  it("paginates without duplicates or gaps while new tickets arrive", async () => {
    const { app } = makeApp(fakeReply(goodAnswer));
    for (let i = 1; i <= 5; i++) await request(app).post("/tickets").send(sample({ external_id: `T${i}` }));
    const p1 = (await request(app).get("/tickets?limit=2")).body;
    await request(app).post("/tickets").send(sample({ external_id: "NEW" }));  
    const p2 = (await request(app).get(`/tickets?limit=2&cursor=${p1.nextCursor}`)).body;
    const p3 = (await request(app).get(`/tickets?limit=2&cursor=${p2.nextCursor}`)).body;
    const ids = [...p1.items, ...p2.items, ...p3.items].map((t: any) => t.id);
    expect(ids).toEqual([5, 4, 3, 2, 1]);
  });

  it("buckets tickets into late, at_risk and on_track", async () => {
    const createdAt = new Date("2026-09-20T09:00:00Z");
    await prisma.ticket.create({ data: { externalId: "a", customerId: "C", customerPlan: "pro",
      subject: "s", body: "b", createdAt, priority: "P1", dueAt: new Date("2026-09-20T13:00:00Z") } });   
    const at = (iso: string) => getStats(prisma, new Date(iso));
    expect((await at("2026-09-20T10:00:00Z")).P1).toEqual({ late: 0, at_risk: 0, on_track: 1 });
    expect((await at("2026-09-20T12:30:00Z")).P1).toEqual({ late: 0, at_risk: 1, on_track: 0 });   
    expect((await at("2026-09-20T14:00:00Z")).P1).toEqual({ late: 1, at_risk: 0, on_track: 0 });
  });
});