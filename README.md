# Support Ticket Service

A backend that receives customer support tickets, sorts them with an AI model, checks if the AI answer can be trusted, and helps agents answer on time.

For the reasons behind every choice, read **[DECISIONS.md](./DECISIONS.md)**.

## Tech stack

- Node.js, Express 5, TypeScript (run with `tsx`, no build step)
- PostgreSQL 16 (Docker) with Prisma 7
- Zod for input validation
- Google Gemini (free tier) for AI sorting, behind a small `AiClient` interface
- Vitest and Supertest for tests (with a fake AI)

## What you need

- Node.js 20 or newer
- Docker (for PostgreSQL)
- A free Gemini API key from https://aistudio.google.com/app/apikey

## Setup

```bash
cp .env.example .env          # then put your key in AI_API_KEY
docker compose up -d          # starts PostgreSQL
npm install
npx prisma migrate deploy     # creates the tables
npx prisma generate           # creates the Prisma client
```

If port 5433 is already used on your machine, change it in both `docker-compose.yml` and `DATABASE_URL` in `.env`.

## Environment variables

| Name | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `AI_API_KEY` | Your AI provider key (never commit it) |
| `AI_MODEL` | AI model name (optional, has a default) |
| `PORT` | Server port (optional, default 3000) |

## Load the test data

```bash
npm run seed
```

This sends the 8 sample tickets through the same code as `POST /tickets`, waits for the AI step, and prints a result table. It takes a few minutes because it pauses between AI calls (free tier rate limits).

To start again from zero:

```bash
docker compose exec db psql -U postgres -d tickets -c 'TRUNCATE "AiCall","TicketEvent","Ticket" RESTART IDENTITY CASCADE;'
```

## Run the server

```bash
npm run dev
```

## Run the tests

Tests use a **fake AI** and a **separate database**, so they never call a real AI and never touch your data.

```bash
docker compose exec db psql -U postgres -c "CREATE DATABASE tickets_test;"
echo 'DATABASE_URL="postgresql://postgres:postgres@localhost:5433/tickets_test"' > .env.test
npx dotenv -e .env.test -- prisma migrate deploy
npm test
```

Type check: `npm run typecheck`

## API

Agent routes need the header `X-Agent-Id: <any name>`. There is no login.

| Route | What it does |
|---|---|
| `POST /tickets` | Save a ticket. Replies at once. AI runs in the background. Same `external_id` is never saved twice |
| `GET /tickets` | List tickets. Filters: `status`, `priority`, `category`, `triage_decision`. Paging: `limit`, `cursor` |
| `POST /tickets/:id/claim` | Agent takes a ticket. Only one agent can win |
| `PATCH /tickets/:id/status` | `open → in_progress → resolved`, and `resolved → open` |
| `PATCH /tickets/:id/triage` | Agent fixes category or priority of a `manual_review` ticket. Needs a `reason` |
| `GET /stats` | Per priority: how many tickets are late, at risk, on track |

Example:

```bash
curl -X POST localhost:3000/tickets -H "Content-Type: application/json" -d '{
  "external_id": "T-1", "customer_id": "C-1", "customer_plan": "pro",
  "subject": "Charged twice", "body": "I was charged twice this month",
  "created_at": "2026-09-20T09:00:00Z"
}'
```

## How it works (short)

1. `POST /tickets` saves the ticket and replies.
2. A worker asks the AI for `category`, `priority` and `summary`.
3. The checker (plain code) decides `auto_accept` or `manual_review` and saves a `review_reason`.
4. If anything fails, the ticket is still saved and goes to `manual_review`.

## Project structure

```
src/
  ai/         AI interface, Gemini client, fake client (for tests)
  checker/    Checks the AI answer and applies business rules
  routes/     HTTP routes
  services/   Saving tickets, AI worker, stats
  db/         Prisma client
  config.ts   SLA hours, time limits, allowed values
prisma/       Database schema and migrations
scripts/      Seed script
tests/        Tests
```

## Change the AI provider

Create a new class that follows the `AiClient` interface in `src/ai/types.ts`, then use it in `src/index.ts` and `scripts/seed.ts`. Nothing else changes.
