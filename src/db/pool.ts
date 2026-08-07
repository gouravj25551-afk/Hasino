import pg from 'pg';

/**
 * Return timestamptz as a real Date and let pg do the parsing.
 * Return int8 counts as numbers — COUNT(*) over a day of slots will never
 * approach 2^53, and a string here would silently break `booked < capacity`.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the connection is already broken; the pool will discard it
    }
    throw err;
  } finally {
    client.release();
  }
}
