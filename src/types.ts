import type { Db } from "./db";
export interface Deps {
  db: Db;
  enqueue: (ticketId: number) => void;
  clock: () => Date;   
}