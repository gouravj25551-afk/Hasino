/**
 * Spec §8, "Tests for step 2 — write these before the code".
 * Cases 1-8 here; case 9 (concurrency) needs a real database, see
 * booking-concurrency.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { availabilityFromSnapshot } from '../src/availability/service.ts';
import { cartRequiredMin, slotsNeeded } from '../src/availability/engine.ts';
import { DATE, at, hoursFor, occupancy, service, snapshot, times, NOW } from './helpers.ts';

/** 20 + 10 buffer = 30 = exactly one slot on the 30-min fixture grid. */
const quickTrim = service('quick-trim', 20, 20_000);
/** 50 + 10 buffer = 60 = two slots. */
const haircut = service('haircut', 50, 30_000);

function today(snap: ReturnType<typeof snapshot>, cart = [quickTrim]) {
  const result = availabilityFromSnapshot(snap, cart, NOW);
  return result.days[0]!;
}

describe('availability — spec §8', () => {
  it('1. empty day -> all slots returned', () => {
    const day = today(snapshot());
    assert.equal(day.state, 'full');
    assert.deepEqual(times(day.full), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
  });

  it('2. capacity 1, one booking -> that window blocked', () => {
    const day = today(
      snapshot({
        hours: hoursFor({ onlineCapacity: 1 }),
        occupancy: occupancy([['11:00', 1]]),
      }),
    );
    assert.deepEqual(times(day.full), ['10:00', '10:30', '11:30', '12:00', '12:30']);
  });

  it('3. capacity 2, one booking -> all slots still open', () => {
    const day = today(
      snapshot({
        hours: hoursFor({ onlineCapacity: 2 }),
        occupancy: occupancy([['11:00', 1]]),
      }),
    );
    assert.deepEqual(times(day.full), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
  });

  it('4. capacity 2, two overlapping bookings -> that window blocked', () => {
    const day = today(
      snapshot({
        hours: hoursFor({ onlineCapacity: 2 }),
        occupancy: occupancy([['11:00', 2]]),
      }),
    );
    assert.deepEqual(times(day.full), ['10:00', '10:30', '11:30', '12:00', '12:30']);
  });

  it('5. 90-min cart, fragmented gaps -> empty list + partial suggestions', () => {
    // 30 + 20 + 30 durations, max buffer 10 => 90 min => 3 consecutive slots
    const cart = [
      service('haircut', 30, 30_000),
      service('beard', 20, 15_000),
      service('head-massage', 30, 20_000),
    ];
    assert.equal(cartRequiredMin(cart), 90);
    assert.equal(slotsNeeded(90, 30), 3);

    // 10:00..13:30, capacity 1, booked at 11:00 and 12:30 => longest free run is 2
    const snap = snapshot({
      hours: hoursFor({ closeAt: '14:00', onlineCapacity: 1 }),
      occupancy: occupancy([
        ['11:00', 1],
        ['12:30', 1],
      ]),
    });

    const day = availabilityFromSnapshot(snap, cart, NOW).days[0]!;

    assert.equal(day.state, 'partial');
    assert.deepEqual(day.full, [], 'no start time can hold the whole 90-min cart');
    assert.ok(day.partial.length > 0, 'must fall back to partial suggestions');

    const first = day.partial[0]!;
    assert.equal(times([first.at])[0], '10:00');
    assert.equal(first.freeMin, 60);
    // one option, the highest-value service that fits (not every subset)
    assert.equal(first.suggest.name, 'haircut');
    assert.deepEqual(
      first.fits.map((s) => s.name).sort(),
      ['beard', 'haircut', 'head-massage'],
    );
  });

  it('5b. partials are suppressed while any full-fit start exists', () => {
    const day = today(snapshot({ hours: hoursFor({ onlineCapacity: 1 }) }));
    assert.equal(day.state, 'full');
    assert.deepEqual(day.partial, []);
  });

  it('6. booking would cross the lunch break -> those start times excluded', () => {
    const snap = snapshot({
      hours: hoursFor({
        openAt: '10:00',
        closeAt: '19:00',
        breakStart: '13:00',
        breakEnd: '14:00',
        onlineCapacity: 1,
      }),
    });
    const day = availabilityFromSnapshot(snap, [haircut], NOW).days[0]!;
    const starts = times(day.full);

    // 12:30 + 60 min would run into the break
    assert.ok(!starts.includes('12:30'), '12:30 would cross the lunch break');
    assert.ok(starts.includes('12:00'), '12:00 ends exactly at the break');
    // ...and nothing is offered inside the break itself
    assert.ok(!starts.includes('13:00'));
    assert.ok(!starts.includes('13:30'));
    assert.ok(starts.includes('14:00'), 'the salon reopens at 14:00');
  });

  it('7. booking would run past closing -> excluded', () => {
    const snap = snapshot({ hours: hoursFor({ onlineCapacity: 1 }) }); // 10:00-13:00
    const day = availabilityFromSnapshot(snap, [haircut], NOW).days[0]!;
    assert.deepEqual(times(day.full), ['10:00', '10:30', '11:00', '11:30', '12:00']);
    // 12:30 + 60 = 13:30, past the 13:00 close
  });

  it('8. holiday -> zero rows', () => {
    const snap = snapshot({ holidays: [DATE] });
    const day = today(snap);
    assert.equal(day.state, 'closed');
    assert.equal(day.closedReason, 'holiday');
    assert.deepEqual(day.full, []);
    assert.deepEqual(day.partial, []);
  });

  it('8b. a weekday with no salon_hours row is a non-working day', () => {
    const hours = hoursFor();
    hours.delete(new Date(`${DATE}T00:00:00Z`).getUTCDay());
    const day = today(snapshot({ hours }));
    assert.equal(day.state, 'closed');
    assert.equal(day.closedReason, 'not_working');
  });
});

describe('availability — rules the spec states but does not list a test for', () => {
  it('excludes start times less than 15 minutes away', () => {
    // 10:50 local: 11:00 is 10 minutes out, 11:30 is fine
    const now = at('10:50');
    const day = availabilityFromSnapshot(snapshot(), [quickTrim], now).days[0]!;
    assert.deepEqual(times(day.full), ['11:30', '12:00', '12:30']);
  });

  it('capacity 0 closes the day to online booking without closing the salon', () => {
    const day = today(snapshot({ hours: hoursFor({ onlineCapacity: 0 }) }));
    assert.equal(day.state, 'none');
    assert.deepEqual(day.full, []);
  });

  it('covers exactly 7 days: today + 6', () => {
    const result = availabilityFromSnapshot(snapshot(), [quickTrim], NOW);
    assert.equal(result.days.length, 7);
    assert.equal(result.days[0]!.date, DATE);
    assert.equal(result.days[6]!.date, '2026-08-09');
  });

  it('a booking in progress right now still holds its chair', () => {
    const now = at('10:40');
    const day = availabilityFromSnapshot(
      snapshot({
        hours: hoursFor({ onlineCapacity: 1 }),
        // started 10:30, spans 10:30 and 11:00
        occupancy: occupancy([
          ['10:30', 1],
          ['11:00', 1],
        ]),
      }),
      [quickTrim],
      now,
    ).days[0]!;
    assert.deepEqual(times(day.full), ['11:30', '12:00', '12:30']);
  });
});

/**
 * Chairs are concurrency, not a daily allowance.
 *
 * A salon with 3 chairs can hold three bookings in the same half hour and is
 * full on the fourth — and it can do that again in the next half hour. The
 * failure this guards against is reading the number as "3 bookings a day",
 * which would sell a third of the salon.
 */
describe('chairs are per-slot capacity', () => {
  const slotAt = (day: ReturnType<typeof today>, hhmm: string) =>
    day.slots.find((s) => times([s.at])[0] === hhmm);

  it('3 chairs means 3 bookings in the same slot, in every slot', () => {
    const day = today(snapshot({ hours: hoursFor({ onlineCapacity: 3 }) }));
    assert.equal(day.capacity, 3);
    assert.equal(day.slots.length, 6, '10:00 to 12:30 on a 30-minute grid');
    for (const slot of day.slots) {
      assert.equal(slot.remaining, 3);
      assert.equal(slot.state, 'open');
    }
  });

  it('two of three chairs taken leaves one, and the slot stays bookable', () => {
    const day = today(
      snapshot({
        hours: hoursFor({ onlineCapacity: 3 }),
        occupancy: occupancy([['11:00', 2]]),
      }),
    );
    const eleven = slotAt(day, '11:00')!;
    assert.equal(eleven.taken, 2);
    assert.equal(eleven.remaining, 1);
    assert.equal(eleven.state, 'limited', 'partially occupied, not full');
    assert.ok(times(day.full).includes('11:00'), 'the third customer can still book it');

    // ...and the neighbouring slots are untouched. This is the "not a daily
    // allowance" assertion: two bookings at 11:00 cost 11:30 nothing.
    assert.equal(slotAt(day, '11:30')!.remaining, 3);
    assert.equal(slotAt(day, '10:30')!.remaining, 3);
  });

  it('the third booking fills the slot and the fourth customer cannot have it', () => {
    const day = today(
      snapshot({
        hours: hoursFor({ onlineCapacity: 3 }),
        occupancy: occupancy([['11:00', 3]]),
      }),
    );
    const eleven = slotAt(day, '11:00')!;
    assert.equal(eleven.remaining, 0);
    assert.equal(eleven.state, 'full');
    assert.ok(!times(day.full).includes('11:00'), 'full means unbookable');
    // Still on the list, so the customer sees a sold-out time rather than a
    // hole in the salon's day.
    assert.ok(times(day.slots.map((s) => s.at)).includes('11:00'));
    assert.deepEqual(times(day.full), ['10:00', '10:30', '11:30', '12:00', '12:30']);
  });

  it('a multi-slot cart is limited by its worst slot, not its first', () => {
    // 50 + 10 buffer = 60 = two slots. 11:00 has all 3 chairs free, 11:30 has one.
    const day = availabilityFromSnapshot(
      snapshot({
        hours: hoursFor({ onlineCapacity: 3 }),
        occupancy: occupancy([['11:30', 2]]),
      }),
      [haircut],
      NOW,
    ).days[0]!;

    const eleven = slotAt(day, '11:00')!;
    assert.equal(eleven.remaining, 1, 'one chair can be held for the whole hour, not three');
    assert.equal(eleven.state, 'limited');
  });

  it('a start time the cart cannot fit into is not offered as full — it is not offered', () => {
    // Salon closes at 13:00; a 60-minute cart cannot start at 12:30.
    const day = availabilityFromSnapshot(
      snapshot({ hours: hoursFor({ onlineCapacity: 2 }) }),
      [haircut],
      NOW,
    ).days[0]!;
    assert.ok(!times(day.slots.map((s) => s.at)).includes('12:30'));
    assert.deepEqual(times(day.slots.map((s) => s.at)), ['10:00', '10:30', '11:00', '11:30', '12:00']);
  });

  it('a one-chair salon is full at one booking', () => {
    const day = today(
      snapshot({ hours: hoursFor({ onlineCapacity: 1 }), occupancy: occupancy([['11:00', 1]]) }),
    );
    const eleven = slotAt(day, '11:00')!;
    assert.equal(eleven.remaining, 0);
    assert.equal(eleven.state, 'full');
    // 'limited' cannot happen with one chair: it is either free or gone.
    assert.ok(day.slots.every((s) => s.state !== 'limited'));
  });

  it('an over-booked slot never reports negative capacity', () => {
    // Defensive: capacity can be lowered after bookings were taken at the old
    // number. The salon honours them; the UI must not show "-1 free".
    const day = today(
      snapshot({ hours: hoursFor({ onlineCapacity: 2 }), occupancy: occupancy([['11:00', 5]]) }),
    );
    const eleven = slotAt(day, '11:00')!;
    assert.equal(eleven.remaining, 0);
    assert.equal(eleven.taken, 2, 'clamped to what the salon actually has');
    assert.equal(eleven.state, 'full');
  });

  it('a closed day has no slots and no chairs', () => {
    const day = today(snapshot({ holidays: [DATE] }));
    assert.equal(day.capacity, 0);
    assert.deepEqual(day.slots, []);
  });
});

describe('buffer policy', () => {
  it("'max' charges one turnaround per booking, 'sum' charges one per service", () => {
    const cart = [service('a', 30, 100, 10), service('b', 20, 100, 15)];
    assert.equal(cartRequiredMin(cart, 'max'), 50 + 15);
    assert.equal(cartRequiredMin(cart, 'sum'), 50 + 25);
  });

  it('changes how many slots a cart needs, which is why it must be decided', () => {
    const cart = [service('a', 30, 100, 10), service('b', 20, 100, 15)];
    assert.equal(slotsNeeded(cartRequiredMin(cart, 'max'), 30), 3); // 65 min
    assert.equal(slotsNeeded(cartRequiredMin(cart, 'sum'), 30), 3); // 75 min
    const two = [service('a', 20, 100, 5), service('b', 20, 100, 5)];
    assert.equal(slotsNeeded(cartRequiredMin(two, 'max'), 30), 2); // 45 min
    assert.equal(slotsNeeded(cartRequiredMin(two, 'sum'), 30), 2); // 50 min
  });
});
