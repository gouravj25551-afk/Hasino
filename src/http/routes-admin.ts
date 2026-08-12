import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Pool } from '../db/pool.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import {
  addCatalogueService,
  adminOverview,
  adminSalonDetail,
  changeSalonStatus,
  countFutureBookings,
  deleteCatalogueService,
  listCatalogue,
  listCities,
  listSalonsForAdmin,
  onboardSalon,
  statusHistory,
  updateSalon,
  type SalonStatus,
} from '../admin/repo.ts';
// Reused rather than reimplemented: these already take a salonId and have no
// notion of who is calling. A second copy of the validation is how the owner
// panel and the admin panel drift apart.
import { deactivateService, listHours, listServiceSetup, saveHours, upsertService } from '../business/repo.ts';
import { salonBalance } from '../payments/ledger.ts';
import { HttpError, bool, int, json, readJson, str, uuid } from './respond.ts';

const STATUSES = new Set<SalonStatus>(['pending', 'active', 'suspended', 'banned', 'rejected']);

function num(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpError(400, `${field} must be a number`);
  }
  return v;
}

function optionalStr(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  return v;
}

/**
 * The platform operator's surface.
 *
 * Every route here is behind requireRole(s, 'admin') in server.ts, checked
 * before the body is parsed. Unlike /api/business/*, the salon is named in the
 * URL rather than resolved from the caller — that is the whole difference
 * between the two panels, and the reason admin is not a superset of business.
 */
export async function adminRoutes(
  db: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { seg: string[]; method: string; url: URL; adminUserId: string; cache: SnapshotCache },
): Promise<boolean> {
  const { seg, method, url, adminUserId, cache } = ctx;
  if (seg[0] !== 'api' || seg[1] !== 'admin') return false;

  const tail = seg.slice(2);

  // ---------- overview ----------
  if (method === 'GET' && tail[0] === 'overview' && tail.length === 1) {
    json(res, 200, await adminOverview(db));
    return true;
  }

  if (method === 'GET' && tail[0] === 'cities' && tail.length === 1) {
    json(res, 200, { cities: await listCities(db) });
    return true;
  }

  // ---------- global service catalogue ----------
  if (tail[0] === 'services') {
    if (method === 'GET' && tail.length === 1) {
      json(res, 200, { services: await listCatalogue(db) });
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = await readJson(req);
      const created = await addCatalogueService(db, str(body, 'name'), str(body, 'category'));
      json(res, 201, created);
      return true;
    }
    if (method === 'DELETE' && tail.length === 2) {
      await deleteCatalogueService(db, uuid(tail[1]!, 'serviceId'));
      json(res, 200, { ok: true });
      return true;
    }
  }

  // ---------- salons ----------
  if (tail[0] === 'salons') {
    if (method === 'GET' && tail.length === 1) {
      const status = url.searchParams.get('status') ?? undefined;
      if (status !== undefined && !STATUSES.has(status as SalonStatus)) {
        throw new HttpError(400, `status must be one of ${[...STATUSES].join(', ')}`);
      }
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
        throw new HttpError(400, 'limit must be an integer between 1 and 500');
      }
      json(res, 200, {
        salons: await listSalonsForAdmin(db, {
          status,
          city: url.searchParams.get('city') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
          limit,
        }),
      });
      return true;
    }

    if (method === 'POST' && tail.length === 1) {
      const body = await readJson(req);
      const owner = body['owner'];
      if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) {
        throw new HttpError(400, 'owner must be an object with at least a phone');
      }
      const o = owner as Record<string, unknown>;
      const result = await onboardSalon(db, adminUserId, {
        name: str(body, 'name'),
        address: str(body, 'address'),
        city: str(body, 'city'),
        area: optionalStr(body, 'area') ?? null,
        // Optional: geocoded from the address when absent. Hand-typed
        // coordinates are wrong in a way nobody notices.
        ...(body['lat'] !== undefined ? { lat: num(body, 'lat') } : {}),
        ...(body['lng'] !== undefined ? { lng: num(body, 'lng') } : {}),
        ...(optionalStr(body, 'timezone') !== undefined ? { timezone: optionalStr(body, 'timezone')! } : {}),
        ...(body['commissionBps'] !== undefined ? { commissionBps: int(body, 'commissionBps') } : {}),
        ...(body['status'] !== undefined ? { status: str(body, 'status') as 'pending' | 'active' } : {}),
        phone: optionalStr(body, 'phone') ?? null,
        email: optionalStr(body, 'email') ?? null,
        owner: {
          phone: str(o, 'phone'),
          // Required: it is how the owner's Google sign-in finds this row.
          email: str(o, 'email'),
          name: typeof o['name'] === 'string' ? o['name'] : null,
        },
      });
      // A brand new salon has no cached window, but an admin re-onboarding
      // onto a recycled owner might; cheap insurance either way.
      await cache.invalidate(result.salonId);
      json(res, 201, result);
      return true;
    }

    if (tail.length >= 2) {
      const salonId = uuid(tail[1]!, 'salonId');
      const rest = tail.slice(2);

      // GET /api/admin/salons/:id
      if (method === 'GET' && rest.length === 0) {
        const [detail, services, hours, balance, history, futureBookings] = await Promise.all([
          adminSalonDetail(db, salonId),
          listServiceSetup(db, salonId),
          listHours(db, salonId),
          salonBalance(db, salonId),
          statusHistory(db, salonId),
          countFutureBookings(db, salonId),
        ]);
        json(res, 200, { ...detail, services, hours, balance, statusHistory: history, futureBookings });
        return true;
      }

      // PUT /api/admin/salons/:id
      if (method === 'PUT' && rest.length === 0) {
        const body = await readJson(req);
        await updateSalon(db, salonId, {
          ...(body['name'] !== undefined ? { name: str(body, 'name') } : {}),
          ...(body['address'] !== undefined ? { address: str(body, 'address') } : {}),
          ...(body['city'] !== undefined ? { city: str(body, 'city') } : {}),
          ...(body['area'] !== undefined ? { area: optionalStr(body, 'area') ?? null } : {}),
          ...(body['lat'] !== undefined ? { lat: num(body, 'lat') } : {}),
          ...(body['lng'] !== undefined ? { lng: num(body, 'lng') } : {}),
          ...(body['timezone'] !== undefined ? { timezone: str(body, 'timezone') } : {}),
          ...(body['commissionBps'] !== undefined ? { commissionBps: int(body, 'commissionBps') } : {}),
          ...(body['phone'] !== undefined ? { phone: optionalStr(body, 'phone') ?? null } : {}),
          ...(body['email'] !== undefined ? { email: optionalStr(body, 'email') ?? null } : {}),
        });
        // The timezone moves every slot boundary this salon has.
        await cache.invalidate(salonId);
        json(res, 200, { ok: true });
        return true;
      }

      // POST /api/admin/salons/:id/status
      if (method === 'POST' && rest[0] === 'status' && rest.length === 1) {
        const body = await readJson(req);
        const to = str(body, 'status');
        if (!STATUSES.has(to as SalonStatus)) {
          throw new HttpError(400, `status must be one of ${[...STATUSES].join(', ')}`);
        }
        const result = await changeSalonStatus(db, adminUserId, salonId, to as SalonStatus, {
          reason: optionalStr(body, 'reason') ?? null,
          cancelFutureBookings: body['cancelFutureBookings'] === true,
        });
        // Status gates availability and booking creation both.
        await cache.invalidate(salonId);
        json(res, 200, result);
        return true;
      }

      // GET/PUT/DELETE /api/admin/salons/:id/services[/:serviceId]
      if (rest[0] === 'services') {
        if (method === 'GET' && rest.length === 1) {
          json(res, 200, { services: await listServiceSetup(db, salonId) });
          return true;
        }
        if (method === 'PUT' && rest.length === 2) {
          const body = await readJson(req);
          try {
            await upsertService(db, salonId, uuid(rest[1]!, 'serviceId'), {
              price: int(body, 'price'),
              durationMin: int(body, 'durationMin'),
              bufferMin: int(body, 'bufferMin'),
              active: bool(body, 'active'),
            });
          } catch (err) {
            throw new HttpError(400, (err as Error).message);
          }
          await cache.invalidate(salonId);
          json(res, 200, { ok: true });
          return true;
        }
        if (method === 'DELETE' && rest.length === 2) {
          await deactivateService(db, salonId, uuid(rest[1]!, 'serviceId'));
          await cache.invalidate(salonId);
          json(res, 200, { ok: true });
          return true;
        }
      }

      // GET/PUT /api/admin/salons/:id/hours[/:weekday]
      if (rest[0] === 'hours') {
        if (method === 'GET' && rest.length === 1) {
          json(res, 200, { hours: await listHours(db, salonId) });
          return true;
        }
        if (method === 'PUT' && rest.length === 2) {
          const body = await readJson(req);
          try {
            await saveHours(db, salonId, Number(rest[1]), {
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
          await cache.invalidate(salonId);
          json(res, 200, { ok: true });
          return true;
        }
      }
    }
  }

  return false;
}
