/**
 * End-to-end smoke test against a running server.
 * Walks the customer flow and every business-panel screen from spec §6.
 *
 *   node scripts/smoke.ts            (server must be on :3000 with DEV_AUTH=true)
 */
const BASE = process.env.BASE ?? 'http://localhost:3000';

let failures = 0;
const rupees = (p: number) => '₹' + (p / 100).toLocaleString('en-IN');

function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; as?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.as ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ids = (await call('/api/dev/identities')).body;
// Positional, not by name. Fixtures come from scripts/ci-fixture.ts and the
// product must contain no demo salon names to pin against.
if (!ids.owners || ids.owners.length < 2 || !ids.customers?.length) {
  console.error(
    'Not enough fixtures. Run:\n' +
      '  node scripts/seed-catalog.ts && CI_SMOKE=true node scripts/ci-fixture.ts',
  );
  process.exit(1);
}
const owner = ids.owners[0];
const customer = ids.customers[0];
const asOwner = { 'x-dev-user': owner.dev_token };
const asCustomer = { 'x-dev-user': customer.dev_token };

console.log(`\nsalon: ${owner.salon_name}   customer: ${customer.name}\n`);

// ---------- business: services (screen 1) ----------
console.log('services (§6.1)');
let { body: svc } = await call('/api/business/services', { as: asOwner });
const haircut = svc.services.find((s: any) => s.name === 'Haircut');
check('menu lists every global service with offered/not-offered', svc.services.length >= 5,
  `${svc.services.filter((s: any) => s.offered).length} offered of ${svc.services.length}`);

await call(`/api/business/services/${haircut.serviceId}`, {
  method: 'PUT', as: asOwner, body: { price: 27_500, durationMin: 35, bufferMin: 10, active: true },
});
svc = (await call('/api/business/services', { as: asOwner })).body;
const edited = svc.services.find((s: any) => s.name === 'Haircut');
check('price + duration edit persists', edited.price === 27_500 && edited.durationMin === 35,
  `${rupees(edited.price)} / ${edited.durationMin}min`);

const facial = svc.services.find((s: any) => s.name === 'Facial');
await call(`/api/business/services/${facial.serviceId}`, {
  method: 'PUT', as: asOwner, body: { price: 65_000, durationMin: 40, bufferMin: 15, active: true },
});
const salonId = (await call('/api/business/overview', { as: asOwner })).body.salon.id;
const publicSalon = (await call(`/api/salons/${salonId}`)).body;
check('a newly added service appears in the customer app',
  publicSalon.services.some((s: any) => s.name === 'Facial'));

const bad = await call(`/api/business/services/${haircut.serviceId}`, {
  method: 'PUT', as: asOwner, body: { price: 100, durationMin: 0, bufferMin: 10, active: true },
});
check('rejects durationMin = 0', bad.status === 400, bad.body.error);

// ---------- business: timings (screen 2) ----------
console.log('\ntimings (§6.2)');
const { body: hrs } = await call('/api/business/hours', { as: asOwner });
check('returns all 7 weekdays', hrs.hours.length === 7);

// Arrange rather than assume: this script must pass on a re-run, not only
// against a fresh seed.
await call('/api/business/hours/1', {
  method: 'PUT', as: asOwner,
  body: { working: false, openAt: '10:00', closeAt: '20:00', breakStart: null, breakEnd: null,
          onlineCapacity: 1, slotIntervalMin: 30 },
});
const closedMon = (await call('/api/business/hours', { as: asOwner })).body.hours[1];
check('closing a weekday removes it from the schedule', closedMon.working === false);

await call('/api/business/hours/1', {
  method: 'PUT', as: asOwner,
  body: { working: true, openAt: '11:00', closeAt: '18:00', breakStart: null, breakEnd: null,
          onlineCapacity: 2, slotIntervalMin: 45 },
});
const mon = (await call('/api/business/hours', { as: asOwner })).body.hours[1];
check('reopening it persists', mon.working && mon.openAt === '11:00' && mon.slotIntervalMin === 45,
  `${mon.openAt}-${mon.closeAt} @${mon.slotIntervalMin}min x${mon.onlineCapacity}`);

const badIv = await call('/api/business/hours/2', {
  method: 'PUT', as: asOwner,
  body: { working: true, openAt: '10:00', closeAt: '20:00', breakStart: null, breakEnd: null,
          onlineCapacity: 1, slotIntervalMin: 37 },
});
check('rejects a slot interval that is not 20/30/45', badIv.status === 400, badIv.body.error);

const badTime = await call('/api/business/hours/2', {
  method: 'PUT', as: asOwner,
  body: { working: true, openAt: '20:00', closeAt: '10:00', breakStart: null, breakEnd: null,
          onlineCapacity: 1, slotIntervalMin: 30 },
});
check('rejects closing before opening', badTime.status === 400, badTime.body.error);

// holidays
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
await call('/api/business/holidays', { method: 'POST', as: asOwner, body: { date: tomorrow, reason: 'Smoke test' } });
const hol = (await call('/api/business/holidays', { as: asOwner })).body;
check('holiday added', hol.holidays.some((h: any) => h.date === tomorrow));

// ---------- the holiday must reach availability ----------
console.log('\nholiday -> availability');
const cartIds = [edited.serviceId];
const avail = (await call(`/api/salons/${salonId}/availability`, { method: 'POST', body: { serviceIds: cartIds } })).body;
const holidayDay = avail.days.find((d: any) => d.date === tomorrow);
check('the day the salon marked off is closed to customers',
  holidayDay?.state === 'closed' && holidayDay?.closedReason === 'holiday');

await call(`/api/business/holidays/${tomorrow}`, { method: 'DELETE', as: asOwner });
const avail2 = (await call(`/api/salons/${salonId}/availability`, { method: 'POST', body: { serviceIds: cartIds } })).body;
check('removing the holiday reopens it (cache invalidated)',
  avail2.days.find((d: any) => d.date === tomorrow)?.state !== 'closed');

// ---------- payment: hold -> pay -> confirm ----------
//
// POST /api/bookings no longer produces a booking; it produces a hold on a
// chair plus a Razorpay order. Under DEV_AUTH the payment client is the
// in-process stub, and /api/dev/pay mints a payment signed with the same HMAC
// Razorpay uses — so the confirm below goes through the real signature check.
console.log('\npayment (hold -> pay -> confirm)');

/** What the customer's browser does between the two API calls. */
async function payAndConfirm(booking: any, as: Record<string, string>) {
  const signed = (await call('/api/dev/pay', { method: 'POST', body: { orderId: booking.checkout.orderId } })).body;
  return call(`/api/bookings/${booking.id}/confirm`, {
    method: 'POST',
    as,
    body: {
      razorpay_order_id: signed.orderId,
      razorpay_payment_id: signed.paymentId,
      razorpay_signature: signed.signature,
    },
  });
}

const openDay = avail2.days.find((d: any) => d.state === 'full' && d.full.length);
const slot = openDay.full[0];
const created = await call('/api/bookings', {
  method: 'POST', as: asCustomer, body: { salonId, serviceIds: cartIds, startAt: slot },
});
check('customer takes a hold on the chair', created.status === 201, created.body.id ?? created.body.error);
check('the hold is not yet a booking', created.body.status === 'pending_payment' && created.body.paid === false);
check('a Razorpay order is opened', Boolean(created.body.checkout?.orderId), created.body.checkout?.orderId);
check('the hold has a deadline', Boolean(created.body.holdExpiresAt));
const bookingId = created.body.id;

// The chair is gone before any money moves — this is the race the old
// pay-then-create ordering lost, and lost by refunding someone.
const contested = await call('/api/bookings', {
  method: 'POST', as: asCustomer, body: { salonId, serviceIds: cartIds, startAt: slot },
});
check('a second customer is rejected while the first is still paying',
  contested.status === 409 && contested.body.code === 'SLOT_UNAVAILABLE',
  `${contested.status} ${contested.body.code ?? ''}`);

const forged = await call(`/api/bookings/${bookingId}/confirm`, {
  method: 'POST', as: asCustomer,
  body: { razorpay_order_id: created.body.checkout.orderId, razorpay_payment_id: 'pay_forged', razorpay_signature: 'de'.repeat(32) },
});
check('a forged signature is refused', forged.status === 403 && forged.body.code === 'BAD_SIGNATURE',
  `${forged.status} ${forged.body.code ?? ''}`);

const confirmed = await payAndConfirm(created.body, asCustomer);
check('payment confirms the booking', confirmed.status === 200 && confirmed.body.outcome === 'confirmed',
  confirmed.body.message ?? confirmed.body.error);

const replay = await payAndConfirm(created.body, asCustomer);
check('confirming twice is idempotent',
  replay.status === 200 && replay.body.outcome === 'already_confirmed', replay.body.outcome);

// ---------- booking lifecycle (screen 3) ----------
console.log('\nbooking lifecycle (§6.3, §4 states)');

const dayList = (await call(`/api/business/bookings?date=${openDay.date}`, { as: asOwner })).body;
const mine = dayList.bookings.find((b: any) => b.id === bookingId);
check('booking appears in the salon\'s day list', Boolean(mine), `${mine?.customerName} · ${mine?.status}`);

const raw = (await call(`/api/bookings/${bookingId}`)).body;
const code = raw.verify_code;
check('a 6-digit verify code was generated', /^\d{6}$/.test(code ?? ''), code);

const wrongCode = await call(`/api/business/bookings/${bookingId}/verify`, {
  method: 'POST', as: asOwner, body: { code: '000000' === code ? '111111' : '000000' },
});
check('wrong code is rejected', wrongCode.status === 400 && wrongCode.body.code === 'BAD_CODE');

const outOfOrder = await call(`/api/business/bookings/${bookingId}/complete`, { method: 'POST', as: asOwner });
check('cannot complete a booking that never started',
  outOfOrder.status === 409 && outOfOrder.body.code === 'INVALID_TRANSITION', outOfOrder.body.error);

for (const [action, expect] of [['verify', 'verified'], ['start', 'in_progress'], ['complete', 'completed']] as const) {
  const r = await call(`/api/business/bookings/${bookingId}/${action}`, {
    method: 'POST', as: asOwner, body: action === 'verify' ? { code } : {},
  });
  check(`${action} -> ${expect}`, r.status === 200 && r.body.status === expect, r.body.error ?? '');
}

// ---------- ownership ----------
console.log('\nownership');
const otherOwner = ids.owners.find((o: any) => o.dev_token !== owner.dev_token);
// 'complete' rather than a cancel: the panel has no per-booking cancel any
// more (see routes-business.ts), and an action the router does not know would
// 404 for the wrong reason and stop testing ownership at all.
const cross = await call(`/api/business/bookings/${bookingId}/complete`, {
  method: 'POST', as: { 'x-dev-user': otherOwner.dev_token },
});
check('another salon cannot touch this booking',
  cross.status === 404 || cross.status === 409, `${cross.status} ${cross.body.code ?? ''}`);

// ---------- close for today (screen 5) ----------
console.log('\nclose for the day (§6.5)');
const day2 = avail2.days.find((d: any) => d.state === 'full' && d.full.length > 1 && d.date !== openDay.date);
const b2 = await call('/api/bookings', {
  method: 'POST', as: asCustomer, body: { salonId, serviceIds: cartIds, startAt: day2.full[0] },
});
await payAndConfirm(b2.body, asCustomer);

const closed = await call('/api/business/close-today', { method: 'POST', as: asOwner, body: { date: day2.date } });
check('cancels the day\'s bookings', closed.body.cancelled >= 1, `${closed.body.cancelled} cancelled`);
check('and queues a real refund for each', closed.body.refundsQueued >= 1, closed.body.refunds);

const after = (await call(`/api/business/bookings?date=${day2.date}`, { as: asOwner })).body;
const cancelled = after.bookings.find((b: any) => b.id === b2.body.id);
check('status is cancelled_by_salon', cancelled?.status === 'cancelled_by_salon');
check('a refund is queued, not silently claimed', cancelled?.refundStatus === 'pending');

const reopened = (await call(`/api/salons/${salonId}/availability`, { method: 'POST', body: { serviceIds: cartIds } })).body;
const freed = reopened.days.find((d: any) => d.date === day2.date);
check('the cancelled slot is released back to availability',
  freed.full.includes(day2.full[0]), `${freed.full.length} slots open`);

// ---------- customer's own view ----------
console.log('\ncustomer view');
const mineList = (await call('/api/me/bookings', { as: asCustomer })).body;
check('customer sees their bookings', mineList.bookings.length >= 2);
check('verify code is withheld until 15 min before',
  mineList.bookings.every((b: any) => b.verifyCode === null));

// ---------- insights (screen 7) ----------
console.log('\ninsights (§6.7)');
const stats = (await call('/api/business/stats', { as: asOwner })).body;
check('stats computed', stats.total >= 2, `${stats.total} bookings, ${stats.completed} completed, ${rupees(stats.revenue)}`);
check('fraud rates present', typeof stats.noShowRate === 'number' && typeof stats.cancelRate === 'number',
  `no-show ${(stats.noShowRate * 100).toFixed(0)}% · cancel ${(stats.cancelRate * 100).toFixed(0)}%`);

// ---------- reschedule (§4, 36h) ----------
console.log('\nreschedule (§4)');
const reAvail = (await call(`/api/salons/${salonId}/availability`, { method: 'POST', body: { serviceIds: cartIds } })).body;
const reDay = reAvail.days.find((d: any) => d.state === 'full' && d.full.length > 1);
if (reDay) {
  const toMove = await call('/api/bookings', {
    method: 'POST', as: asCustomer, body: { salonId, serviceIds: cartIds, startAt: reDay.full[0] },
  });
  await payAndConfirm(toMove.body, asCustomer);

  const moved = await call(`/api/me/bookings/${toMove.body.id}/reschedule`, {
    method: 'POST', as: asCustomer, body: { startAt: reDay.full[1] },
  });
  check('a paid booking can be moved', moved.status === 201 && moved.body.paid === true,
    moved.body.error ?? '');
  check('and is not charged again', moved.body.amount === toMove.body.amount);

  const twice = await call(`/api/me/bookings/${moved.body.id}/reschedule`, {
    method: 'POST', as: asCustomer, body: { startAt: reDay.full[0] },
  });
  check('but only once — §10 Q2',
    twice.status === 409 && twice.body.code === 'RESCHEDULE_LIMIT', `${twice.status} ${twice.body.code ?? ''}`);
} else {
  check('reschedule needs two free slots on one day', false, 'skipped — no day with 2+ slots');
}

// ---------- money (screen 6) ----------
console.log('\nmoney (§6.6)');
const money = (await call('/api/business/payouts', { as: asOwner })).body;
check('the salon has a balance from real ledger entries', money.balance.gross > 0,
  `gross ${rupees(money.balance.gross)} · commission ${rupees(money.balance.commission)} · available ${rupees(money.balance.available)}`);
check('commission was taken', money.balance.commission > 0);
check('available = gross - commission - refunds',
  money.balance.available ===
    money.balance.gross - money.balance.commission - money.balance.refunded + money.balance.commissionReturned - money.balance.paidOut,
  'the ledger sums to itself');
check('the statement lists entries', money.ledger.length > 0, `${money.ledger.length} entries`);

// ---------- ops ----------
console.log('\nops');
const live = await call('/healthz');
check('liveness needs no database', live.status === 200 && live.body.ok === true);
const ready = await call('/readyz');
check('readiness checks the database', ready.status === 200 && ready.body.ok === true, ready.body.payments);
const unsigned = await fetch(BASE + '/api/webhooks/razorpay', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'payment.captured' }),
});
check('an unsigned webhook is refused', unsigned.status === 400, String(unsigned.status));

console.log(failures === 0 ? '\nall smoke checks passed\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
