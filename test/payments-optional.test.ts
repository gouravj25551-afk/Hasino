/**
 * Running with no payment provider.
 *
 * Hasino has not chosen one yet, and this is a supported state rather than a
 * misconfiguration: the server boots, bookings are taken and hold a real
 * chair, the completion OTP still gates service — and no money moves and
 * nothing claims it did.
 *
 * These pin the two halves that are easy to break in opposite directions:
 * that a missing credential cannot stop production booting, and that a
 * half-configured provider still can.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { paymentsConfigFromEnv } from '../src/payments/razorpay.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** paymentsConfigFromEnv reads process.env at call time, so this is enough. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const NO_KEYS = {
  RAZORPAY_KEY_ID: undefined,
  RAZORPAY_KEY_SECRET: undefined,
  PAYMENTS_PROVIDER: undefined,
};

describe('payments are optional', () => {
  it('is provider "none" with no keys', () => {
    const cfg = withEnv(NO_KEYS, () => paymentsConfigFromEnv(false));
    assert.equal(cfg.provider, 'none');
    assert.equal(cfg.enabled, false);
  });

  it('is provider "razorpay" once both keys are present', () => {
    const cfg = withEnv(
      { ...NO_KEYS, RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret' },
      () => paymentsConfigFromEnv(false),
    );
    assert.equal(cfg.provider, 'razorpay');
    assert.equal(cfg.enabled, true);
  });

  it('an explicit "none" wins over present keys', () => {
    // Turning payments off should not require deleting a credential — that is
    // the change nobody remembers how to undo.
    const cfg = withEnv(
      { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret', PAYMENTS_PROVIDER: 'none' },
      () => paymentsConfigFromEnv(false),
    );
    assert.equal(cfg.provider, 'none');
    assert.equal(cfg.enabled, false);
  });

  it('an explicit "none" wins over the CI stub too', () => {
    const cfg = withEnv({ ...NO_KEYS, PAYMENTS_PROVIDER: 'none' }, () => paymentsConfigFromEnv(true));
    assert.equal(cfg.provider, 'none');
    assert.equal(cfg.enabled, false);
  });

  it('provider and enabled can never disagree', () => {
    // Two fields answering the same question is how a config reports 'none'
    // while still opening a checkout.
    for (const ci of [false, true]) {
      for (const forced of [undefined, 'none', 'razorpay']) {
        for (const keys of [{}, { RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's' }]) {
          const cfg = withEnv({ ...NO_KEYS, ...keys, PAYMENTS_PROVIDER: forced }, () =>
            paymentsConfigFromEnv(ci),
          );
          assert.equal(cfg.enabled, cfg.provider === 'razorpay');
        }
      }
    }
  });

  it('rejects a provider nobody implements', () => {
    assert.throws(
      () => withEnv({ PAYMENTS_PROVIDER: 'stripe' }, () => paymentsConfigFromEnv(false)),
      /PAYMENTS_PROVIDER must be/,
    );
  });
});

describe('production boots without payment credentials', () => {
  const server = read('src/http/server.ts');
  // The startup guard, not the prose around it.
  const guard = server.slice(server.indexOf('const fatal: string[] = []'), server.indexOf('if (fatal.length > 0)'));

  it('missing Razorpay credentials are not fatal', () => {
    assert.doesNotMatch(guard, /No Razorpay credentials/);
    assert.doesNotMatch(guard, /!payments\.enabled/);
  });

  it('but a half-configured Razorpay still is', () => {
    // Keys without a webhook secret debits customers whose webhooks then fail
    // their signature check — worse than not taking payments at all.
    assert.match(guard, /payments\.provider === 'razorpay' && !process\.env\['RAZORPAY_WEBHOOK_SECRET'\]/);
  });

  it('the auth and safety bypasses are still fatal', () => {
    for (const flag of ['DEV_AUTH', 'CI_SMOKE']) {
      assert.match(guard, new RegExp(flag), `${flag} must still refuse to start in production`);
    }
  });

  it('the booking route no longer 503s when payments are off', () => {
    // A booking with no provider is a real reservation, not an error.
    assert.doesNotMatch(server, /bookings cannot be taken/);
    assert.match(server, /payments\.provider === 'none'/);
  });

  it('the webhook is closed when no provider is configured', () => {
    // Otherwise it is an open endpoint running HMAC against a secret that is
    // in the source code.
    const hook = server.slice(server.indexOf("path === '/api/webhooks/razorpay'"));
    assert.match(hook.slice(0, 600), /payments\.provider !== 'razorpay'/);
  });
});

describe('the provider stays swappable', () => {
  const razorpay = read('src/payments/razorpay.ts');

  it('there is an interface, not just one client', () => {
    assert.match(razorpay, /export interface RazorpayClient/);
    assert.match(razorpay, /class HttpRazorpayClient implements RazorpayClient/);
    assert.match(razorpay, /class StubRazorpayClient implements RazorpayClient/);
  });

  it('the rest of the system asks the provider, never a key', () => {
    assert.match(razorpay, /export type PaymentProvider/);
    const server = read('src/http/server.ts');
    assert.doesNotMatch(server, /process\.env\['RAZORPAY_KEY_ID'\]/);
  });
});
