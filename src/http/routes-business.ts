import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Pool } from '../db/pool.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import { localDateKey } from '../time/tz.ts';
import { NO_SHOW_GRACE_MIN, closeForDay, transition, type BookingStatus } from '../booking/status.ts';
import {
  addHoliday,
  addSalonService,
  dayBounds,
  listBookingsForDay,
  listHolidays,
  listHours,
  listReviews,
  listServiceSetup,
  removeHoliday,
  removeService,
  salonForOwner,
  salonStats,
  saveHours,
  upsertService,
} from '../business/repo.ts';
import { listPayouts, salonBalance, salonEarnings, salonLedger } from '../payments/ledger.ts';
import { readImageBody, saveSalonImage } from '../salons/images.ts';
import { HttpError, bool, int, json, readJson, str, uuid } from './respond.ts';

/**
 * Spec §6 — the business panel's seven screens, minus Razorpay onboarding
 * (build order step 4, blocked on the Partner application).
 *
 * Every route resolves the salon from the authenticated owner. A salonId is
 * never accepted from the client, so there is no path where one salon edits
 * another's menu by guessing a UUID.
 */
export async function businessRoutes(
  db: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { seg: string[]; method: string; url: URL; ownerId: string; cache: SnapshotCache },
): Promise<boolean> {
  const { seg, method, url, ownerId, cache } = ctx;
  if (seg[0] !== 'api' || seg[1] !== 'business') return false;

  const salon = await salonForOwner(db, ownerId);
  const tail = seg.slice(2);

  // GET /api/business/overview
  if (method === 'GET' && tail[0] === 'overview' && tail.length === 1) {
    const today = localDateKey(new Date(), salon.timezone);
    const [stats, bookings] = await Promise.all([
      salonStats(db, salon.id),
      listBookingsForDay(db, salon.id, salon.timezone, today),
    ]);
    json(res, 200, { salon, today, stats, todayCount: bookings.length });
    return true;
  }

  // ---- the salon's storefront photo ----
  //
  // PUT, not POST: there is one photo per salon and uploading again replaces
  // it. The salon is `salon.id` — resolved from the authenticated owner by
  // salonForOwner above, exactly like every other route in this file — so an
  // owner can only ever replace their own photo and there is no salon id in
  // the request for anyone to tamper with.
  if (method === 'PUT' && tail[0] === 'image' && tail.length === 1) {
    const bytes = await readImageBody(req);
    const stored = await saveSalonImage(db, salon.id, bytes, ownerId);
    json(res, 200, { coverImage: stored.coverUrl, byteSize: stored.byteSize, contentType: stored.contentType });
    return true;
  }

  // ---- screen 1: services ----
  if (tail[0] === 'services') {
    if (method === 'GET' && tail.length === 1) {
      json(res, 200, { services: await listServiceSetup(db, salon.id) });
      return true;
    }
    if (method === 'PUT' && tail.length === 2) {
      const body = await readJson(req);
      try {
        await upsertService(db, salon.id, uuid(tail[1]!, 'serviceId'), {
          price: int(body, 'price'),
          durationMin: int(body, 'durationMin'),
          bufferMin: int(body, 'bufferMin'),
          active: bool(body, 'active'),
        });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      await cache.invalidate(salon.id);
      json(res, 200, { ok: true });
      return true;
    }
    // POST /api/business/services — put a service on this salon's menu,
    // creating the catalogue entry when Hasino has no service by that name.
    // salon.id comes from the authenticated owner exactly like every other
    // route here; the body names a service, never a salon.
    if (method === 'POST' && tail.length === 1) {
      const body = await readJson(req);
      let created;
      try {
        created = await addSalonService(db, salon.id, {
          name: str(body, 'name'),
          category: String(body['category'] ?? 'other'),
          price: int(body, 'price'),
          durationMin: int(body, 'durationMin'),
          bufferMin: Number.isFinite(Number(body['bufferMin'])) ? int(body, 'bufferMin') : 10,
          active: body['active'] === undefined ? true : bool(body, 'active'),
        });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      await cache.invalidate(salon.id);
      json(res, 201, created);
      return true;
    }
    if (method === 'DELETE' && tail.length === 2) {
      // Off this salon's menu, not out of the catalogue. Past bookings keep
      // their own snapshot of price and duration — see removeService.
      await removeService(db, salon.id, uuid(tail[1]!, 'serviceId'));
      await cache.invalidate(salon.id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  // ---- screen 2: timings ----
  if (tail[0] === 'hours') {
    if (method === 'GET' && tail.length === 1) {
      json(res, 200, { hours: await listHours(db, salon.id) });
      return true;
    }
    if (method === 'PUT' && tail.length === 2) {
      const weekday = Number(tail[1]);
      const body = await readJson(req);
      try {
        await saveHours(db, salon.id, weekday, {
          working: bool(body, 'working'),
          openAt: String(body['openAt'] ?? '10:00'),
          closeAt: String(body['closeAt'] ?? '20:00'),
          breakStart: (body['breakStart'] as string | null) || null,
          breakEnd: (body['breakEnd'] as string | null) || null,
          onlineCapacity: int(body, 'onlineCapacity'),
          slotIntervalMin: int(body, 'slotIntervalMin'),
        });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      // Hours changes move every slot boundary — the cached window is now wrong.
      await cache.invalidate(salon.id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (tail[0] === 'holidays') {
    if (method === 'GET' && tail.length === 1) {
      json(res, 200, { holidays: await listHolidays(db, salon.id) });
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = await readJson(req);
      try {
        await addHoliday(db, salon.id, str(body, 'date'), (body['reason'] as string) ?? null);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      await cache.invalidate(salon.id);
      json(res, 201, { ok: true });
      return true;
    }
    if (method === 'DELETE' && tail.length === 2) {
      await removeHoliday(db, salon.id, tail[1]!);
      await cache.invalidate(salon.id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  // ---- screen 3 + 4: bookings, calendar ----
  if (method === 'GET' && tail[0] === 'bookings' && tail.length === 1) {
    const date = url.searchParams.get('date') ?? localDateKey(new Date(), salon.timezone);
    json(res, 200, {
      date,
      timezone: salon.timezone,
      // The clock the panel must reason against. A no-show is gated on server
      // time; a shop phone that is ten minutes fast would otherwise offer the
      // button ten minutes early and the API would refuse it, which reads as
      // the panel being broken rather than as the customer being protected.
      serverNow: new Date().toISOString(),
      noShowGraceMin: NO_SHOW_GRACE_MIN,
      bookings: await listBookingsForDay(db, salon.id, salon.timezone, date),
    });
    return true;
  }

  // POST /api/business/bookings/:id/:action
  if (method === 'POST' && tail[0] === 'bookings' && tail.length === 3) {
    const bookingId = uuid(tail[1]!, 'bookingId');
    const action = tail[2]!;
    const map: Record<string, BookingStatus> = {
      verify: 'verified',
      start: 'in_progress',
      complete: 'completed',
      'no-show': 'no_show',
      cancel: 'cancelled_by_salon',
    };
    const to = map[action];
    if (!to) throw new HttpError(404, `Unknown action ${action}`);

    const body = action === 'verify' ? await readJson(req) : {};
    const result = await transition(db, salon.id, bookingId, to, {
      code: action === 'verify' ? String(body['code'] ?? '') : undefined,
    });
    // completed / no_show / cancelled release the chair
    await cache.invalidate(salon.id);
    json(res, 200, result);
    return true;
  }

  // ---- screen 5: close for today ----
  if (method === 'POST' && tail[0] === 'close-today' && tail.length === 1) {
    const body = await readJson(req);
    const date = (body['date'] as string) ?? localDateKey(new Date(), salon.timezone);
    const { start, end } = dayBounds(salon.timezone, date);
    const result = await closeForDay(db, salon.id, start, end);
    await cache.invalidate(salon.id);
    json(res, 200, {
      date,
      ...result,
      refunds: `${result.refundsQueued} full refund(s) queued; the worker sends them to Razorpay within the minute`,
    });
    return true;
  }

  // ---- screen 7: reviews + analytics ----
  if (method === 'GET' && tail[0] === 'reviews' && tail.length === 1) {
    json(res, 200, { reviews: await listReviews(db, salon.id) });
    return true;
  }
  if (method === 'GET' && tail[0] === 'stats' && tail.length === 1) {
    json(res, 200, await salonStats(db, salon.id));
    return true;
  }

  // ---- screen 6: money ----
  //
  // §6.6 as the spec writes it assumes the Partner sub-merchant model, where
  // money never touches the platform and there is nothing to show but a KYC
  // status. Payments run on the platform account instead (see [DEVIATION 9] in
  // db/schema.sql), so what a salon needs here is the actual number it is owed
  // and the entries that make it up.
  if (method === 'GET' && tail[0] === 'payouts' && tail.length === 1) {
    const [balance, payouts, recent] = await Promise.all([
      salonBalance(db, salon.id),
      listPayouts(db, salon.id),
      salonLedger(db, salon.id, { limit: 50 }),
    ]);
    json(res, 200, {
      balance,
      payouts,
      ledger: recent,
      commissionBps: salon.commissionBps,
      kycStatus: salon.rzpKycStatus,
      // The transfer itself is still an operator action — see
      // payments/ledger.ts createPayoutForPeriod.
      settlement: 'weekly, to the account on file',
    });
    return true;
  }

  if (method === 'GET' && tail[0] === 'earnings' && tail.length === 1) {
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30), 1), 365);
    json(res, 200, { days, series: await salonEarnings(db, salon.id, days) });
    return true;
  }

  return false;
}
