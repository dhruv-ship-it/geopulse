import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

import { logger } from './logger';

/**
 * Apply every `.sql` file in `migrations/`, in filename order, at startup.
 *
 * **This is not a migration tool, and it is not pretending to be one.** There is no versions
 * table, no down-migrations and no checksum — every statement in `migrations/` is idempotent DDL
 * (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), so re-running the whole set is a
 * no-op on a database that already has them. Filenames are numbered so ordering is explicit
 * rather than alphabetical by accident.
 *
 * It exists because the alternative was worse. The files were mounted into Postgres's
 * `/docker-entrypoint-initdb.d`, which the image runs **only when the data directory is empty**.
 * That means a new migration silently does not apply to any developer who already has a volume:
 * the stack comes up, every service reports healthy, and the first incident write fails with
 * `relation "incidents" does not exist`. The only documented fix would have been
 * `docker compose down -v`, which is "delete your data to get a new index".
 *
 * Running it from the service that owns the tables also puts the schema and the code that writes
 * it in one deployable unit, which is the property that matters when a column is added.
 *
 * When this stops being enough — the first time a migration is not idempotent, which is the first
 * `ALTER` that is not `IF NOT EXISTS` — the answer is a real tool (node-pg-migrate, or Flyway),
 * not a bigger version of this.
 */
export async function runMigrations(pool: Pool, dir = join(__dirname, '..', 'migrations')): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    logger.warn({ dir }, 'No migrations found');
    return [];
  }

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    try {
      await pool.query(sql);
      logger.info({ file }, 'Applied migration');
    } catch (err) {
      // Fail the startup. A service that runs against a schema it could not establish will
      // fail later, per message, in a way that looks like a data problem rather than a
      // deployment one.
      logger.fatal({ error: err, file }, 'Migration failed');
      throw err;
    }
  }

  return files;
}
