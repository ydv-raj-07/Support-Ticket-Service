import "dotenv/config";
import { prisma } from "./db";
import { buildApp } from "./app";
import { GeminiClient } from "./AI/geminiClient";;
import { createTriage, sweepStuck } from "./services/triage";

const clock = () => new Date();
const triage = createTriage({ db: prisma, ai: new GeminiClient(), clock });

setInterval(() => sweepStuck(prisma, clock()).catch(console.error), 30_000).unref();

const port = Number(process.env.PORT ?? 3000);
buildApp({ db: prisma, enqueue: triage.enqueue, clock }).listen(port, () => console.log(`listening on ${port}`));