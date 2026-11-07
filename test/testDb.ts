import { newDb } from "pg-mem";
import {
  SelenaDb,
  resetDbForTests,
  setDbForTests,
  type Pool,
} from "../src/lib/db.js";

/**
 * In-memory Postgres (pg-mem) with the full schema, for tests. No network,
 * no Supabase needed. NOTE: pg-mem does not implement transaction rollback
 * (BEGIN/ROLLBACK are accepted but rows are not restored), so rollback
 * behaviour is covered by a fake-pool test in test/db-pg.test.ts, not
 * against pg-mem.
 *
 * Lives in test/ (not src/lib/db.ts) so the production build never needs
 * the pg-mem devDependency: Render builds with NODE_ENV=production, which
 * prunes devDependencies, and a top-level pg-mem import in src/ breaks
 * `tsc` there.
 */
export function getTestDb(): SelenaDb {
  resetDbForTests();
  const mem = newDb();
  const pgMem = mem.adapters.createPg() as unknown as {
    Pool: new () => Pool;
  };
  const pool = new pgMem.Pool();
  const instance = new SelenaDb(pool);
  setDbForTests(instance);
  return instance;
}
