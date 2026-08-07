export class BookingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}

/** Someone else took the last chair between the slot list and the commit. */
export class SlotUnavailableError extends BookingError {
  constructor(message = 'That slot just went. Pick another time.') {
    super('SLOT_UNAVAILABLE', message);
    this.name = 'SlotUnavailableError';
  }
}

/** The start time is not a real slot, or the booking would not fit from it. */
export class InvalidStartError extends BookingError {
  constructor(message: string) {
    super('INVALID_START', message);
    this.name = 'InvalidStartError';
  }
}

export class SalonUnavailableError extends BookingError {
  constructor(message: string) {
    super('SALON_UNAVAILABLE', message);
    this.name = 'SalonUnavailableError';
  }
}

/** 3 no-shows in 60 days -> blocked for 30 (spec §4). */
export class CustomerBlockedError extends BookingError {
  readonly until: Date;
  constructor(until: Date) {
    super('CUSTOMER_BLOCKED', `Booking blocked until ${until.toISOString()}`);
    this.name = 'CustomerBlockedError';
    this.until = until;
  }
}

export class EmptyCartError extends BookingError {
  constructor(message = 'Cart is empty or contains services this salon does not offer') {
    super('EMPTY_CART', message);
    this.name = 'EmptyCartError';
  }
}
