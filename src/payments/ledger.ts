import type { Pool, PoolClient } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';

type Queryable = Pool | PoolClient;

/**
 * Reads over the ledger.
 *
 * Every number a salon sees about its money is derived here by summing
 * ledger_entries. Nothing is stored pre-aggregated. A cached balance that
 * drifts from its entries cannot be repaired without an audit; a SUM over a
 * salon's entries is a few hundred rows and an index scan, and it is right by
 * construction.
 */

export interface SalonBalance {
  /** what customers paid */
  gross: number;
  /** what the platform kept, positive for display */
  commission: number;
  /** what went back to customers, positive for display */
  refunded: number;
  /** commission returned alongside those refunds, positive for display */
  commissionReturned: number;
  /** already sent to the salon, positive for display */
  paidOut: number;
  /** signed sum of everything — what is owed right now */
  available: number;
  currency: string;
}

export async function salonBalance(db: Queryable, salonId: string): Promise<SalonBalance> {
  const res = await db.query<{
    gross: string;
    commission: string;
    refunded: string;
    reversal: string;
    payout: string;
    adjustment: string;
    total: string;
  }>(
    `SELECT
       coalesce(sum(amount) FILTER (WHERE kind = 'sale'), 0)                AS gross,
       coalesce(sum(amount) FILTER (WHERE kind = 'commission'), 0)          AS commission,
       coalesce(sum(amount) FILTER (WHERE kind = 'refund'), 0)              AS refunded,
       coalesce(sum(amount) FILTER (WHERE kind = 'commission_reversal'), 0) AS reversal,
       coalesce(sum(amount) FILTER (WHERE kind = 'payout'), 0)              AS payout,
       coalesce(sum(amount) FILTER (WHERE kind = 'adjustment'), 0)          AS adjustment,
       coalesce(sum(amount), 0)                                            AS total
     FROM ledger_entries WHERE salon_id = $1`,
    [salonId],
  );
  const r = res.rows[0]!;
  const n = (v: string) => Number(v);
  return {
    gross: n(r.gross),
    commission: -n(r.commission),
    refunded: -n(r.refunded),
    commissionReturned: n(r.reversal),
    paidOut: -n(r.payout),
    available: n(r.total),
    currency: 'INR',
  };
}

export interface LedgerRow {
  id: string;
  kind: string;
  amount: number;
  note: string | null;
  occurredAt: string;
  bookingId: string | null;
  customerName: string | null;
  bookingStartAt: string | null;
}

export async function salonLedger(
  db: Queryable,
  salonId: string,
  opts: { limit?: number; from?: Date; to?: Date } = {},
): Promise<LedgerRow[]> {
  const res = await db.query<{
    id: string;
    kind: string;
    amount: number;
    note: string | null;
    occurred_at: Date;
    booking_id: string | null;
    customer_name: string | null;
    booking_start_at: Date | null;
  }>(
    `SELECT le.id, le.kind, le.amount, le.note, le.occurred_at, le.booking_id,
            u.name AS customer_name, b.start_at AS booking_start_at
       FROM ledger_entries le
       LEFT JOIN bookings b ON b.id = le.booking_id
       LEFT JOIN users u    ON u.id = b.customer_id
      WHERE le.salon_id = $1
        AND ($2::timestamptz IS NULL OR le.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR le.occurred_at <  $3)
      ORDER BY le.occurred_at DESC, le.id
      LIMIT $4`,
    [salonId, opts.from ?? null, opts.to ?? null, opts.limit ?? 100],
  );
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: r.amount,
    note: r.note,
    occurredAt: r.occurred_at.toISOString(),
    bookingId: r.booking_id,
    customerName: r.customer_name,
    bookingStartAt: r.booking_start_at ? r.booking_start_at.toISOString() : null,
  }));
}

export interface EarningsDay {
  date: string;
  gross: number;
  net: number;
  bookings: number;
}

/** Daily net earnings, in the salon's own timezone. */
export async function salonEarnings(
  db: Queryable,
  salonId: string,
  days = 30,
): Promise<EarningsDay[]> {
  const res = await db.query<{ date: string; gross: string; net: string; bookings: string }>(
    `SELECT to_char((le.occurred_at AT TIME ZONE s.timezone)::date, 'YYYY-MM-DD') AS date,
            coalesce(sum(le.amount) FILTER (WHERE le.kind = 'sale'), 0) AS gross,
            coalesce(sum(le.amount) FILTER (WHERE le.kind IN
              ('sale','commission','refund','commission_reversal')), 0)  AS net,
            count(DISTINCT le.booking_id) FILTER (WHERE le.kind = 'sale') AS bookings
       FROM ledger_entries le
       JOIN salons s ON s.id = le.salon_id
      WHERE le.salon_id = $1
        AND le.occurred_at >= now() - ($2::int * interval '1 day')
      GROUP BY 1
      ORDER BY 1`,
    [salonId, days],
  );
  return res.rows.map((r) => ({
    date: r.date,
    gross: Number(r.gross),
    net: Number(r.net),
    bookings: Number(r.bookings),
  }));
}

export interface PayoutRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  status: string;
  reference: string | null;
  createdAt: string;
  paidAt: string | null;
}

export async function listPayouts(db: Queryable, salonId: string, limit = 24): Promise<PayoutRow[]> {
  const res = await db.query<{
    id: string;
    period_start: string;
    period_end: string;
    amount: number;
    status: string;
    reference: string | null;
    created_at: Date;
    paid_at: Date | null;
  }>(
    `SELECT id, to_char(period_start,'YYYY-MM-DD') AS period_start,
            to_char(period_end,'YYYY-MM-DD') AS period_end,
            amount, status, reference, created_at, paid_at
       FROM payouts WHERE salon_id = $1
      ORDER BY period_start DESC LIMIT $2`,
    [salonId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    amount: r.amount,
    status: r.status,
    reference: r.reference,
    createdAt: r.created_at.toISOString(),
    paidAt: r.paid_at ? r.paid_at.toISOString() : null,
  }));
}

/**
 * Cut a payout for a period.
 *
 * The amount is whatever the ledger says is unpaid at the moment it runs, and
 * the corresponding 'payout' entry is written in the same transaction — so the
 * balance drops by exactly what was promised, and running the job twice for the
 * same period is a no-op via the UNIQUE(salon_id, period_start, period_end)
 * constraint rather than a second cheque.
 *
 * The transfer itself is deliberately not here. Under the platform-account
 * model money leaves via Razorpay's dashboard or RazorpayX, both of which are
 * an operator action for now; this records the intent so the salon's panel and
 * the operator are reading the same number.
 */
export async function createPayoutForPeriod(
  db: Pool,
  salonId: string,
  periodStart: string,
  periodEnd: string,
  opts: { reference?: string; now?: Date } = {},
): Promise<{ created: boolean; payoutId: string | null; amount: number }> {
  const now = opts.now ?? new Date();

  return withTransaction(db, async (tx) => {
    // Lock the salon's ledger tail so a sale committing right now is either
    // fully inside this payout or fully outside it.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${salonId}`]);

    const bal = await salonBalance(tx, salonId);
    if (bal.available <= 0) return { created: false, payoutId: null, amount: bal.available };

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO payouts (salon_id, period_start, period_end, amount, reference)
       VALUES ($1, $2::date, $3::date, $4, $5)
       ON CONFLICT (salon_id, period_start, period_end) DO NOTHING
       RETURNING id`,
      [salonId, periodStart, periodEnd, bal.available, opts.reference ?? null],
    );
    const payoutId = inserted.rows[0]?.id;
    if (!payoutId) return { created: false, payoutId: null, amount: 0 };

    await tx.query(
      `INSERT INTO ledger_entries (salon_id, payout_id, kind, amount, note, occurred_at)
       VALUES ($1, $2, 'payout', $3, $4, $5)`,
      [salonId, payoutId, -bal.available, `payout ${periodStart} to ${periodEnd}`, now],
    );

    return { created: true, payoutId, amount: bal.available };
  });
}
