/**
 * The parts of the payment path that need no database: signature verification,
 * commission arithmetic, the Razorpay client's idempotency, and the rate
 * limiter.
 *
 * Signature verification is the single most security-critical function in the
 * repo — without it, `POST /api/bookings/:id/confirm` is "type a payment id,
 * get a free booking" — so it is tested against forgery, not just against the
 * happy path.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  StubRazorpayClient,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../src/payments/razorpay.ts';
import { commissionPaise } from '../src/payments/service.ts';
import { RateLimitError, RateLimiter } from '../src/http/middleware.ts';

const SECRET = 'test_key_secret';

function sign(orderId: string, paymentId: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

describe('checkout signature', () => {
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';

  it('accepts the pair Razorpay actually signed', () => {
    assert.equal(
      verifyCheckoutSignature({ orderId, paymentId, signature: sign(orderId, paymentId) }, SECRET),
      true,
    );
  });

  it('rejects a signature made with a different secret', () => {
    // The exact shape of a leaked-test-key or wrong-environment mistake.
    assert.equal(
      verifyCheckoutSignature(
        { orderId, paymentId, signature: sign(orderId, paymentId, 'someone_elses_secret') },
        SECRET,
      ),
      false,
    );
  });

  it('rejects a signature lifted from another payment', () => {
    // The attack: pay ₹1 for a cheap booking, then replay that payment id and
    // signature against an expensive one. Both halves are in the digest, so the
    // pair cannot be split.
    const stolen = sign('order_OTHER', paymentId);
    assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: stolen }, SECRET), false);
  });

  it('rejects a payment id swapped under a valid order signature', () => {
    const valid = sign(orderId, paymentId);
    assert.equal(
      verifyCheckoutSignature({ orderId, paymentId: 'pay_FORGED', signature: valid }, SECRET),
      false,
    );
  });

  it('rejects empty, malformed and non-hex signatures instead of throwing', () => {
    // These reach the endpoint as raw request body fields, so they must fail
    // closed rather than 500 — a crash here is a free denial of service.
    for (const signature of ['', 'not-hex-at-all', 'ab', 'A'.repeat(64), '0'.repeat(63)]) {
      assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature }, SECRET), false, signature);
    }
    assert.equal(verifyCheckoutSignature({ orderId: '', paymentId, signature: 'x' }, SECRET), false);
  });
});

describe('webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { a: 1 } }));
  const webhookSecret = 'whsec_test';
  const good = createHmac('sha256', webhookSecret).update(body).digest('hex');

  it('accepts the raw bytes Razorpay signed', () => {
    assert.equal(verifyWebhookSignature(body, good, webhookSecret), true);
  });

  it('fails once the body has been re-serialised', () => {
    // This is the bug the raw-body path in middleware.ts exists to prevent:
    // JSON.parse + JSON.stringify produces equivalent JSON with different
    // bytes, and the digest is over bytes.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString())) + ' ');
    assert.equal(verifyWebhookSignature(reserialised, good, webhookSecret), false);
  });

  it('rejects a missing signature header', () => {
    assert.equal(verifyWebhookSignature(body, undefined, webhookSecret), false);
  });

  it('rejects the API secret used in place of the webhook secret', () => {
    // Two different secrets, easy to cross-wire in a dashboard. Better to fail
    // every webhook loudly than to accept unsigned bodies.
    assert.equal(verifyWebhookSignature(body, good, SECRET), false);
  });
});

describe('commission', () => {
  it('takes the configured basis points', () => {
    assert.equal(commissionPaise(100_000, 1500), 15_000); // ₹1000 at 15% -> ₹150
    assert.equal(commissionPaise(49_900, 1000), 4_990);
  });

  it('rounds the half-paise towards the salon, never the platform', () => {
    // 333 * 15% = 49.95 paise. Floor gives the salon the odd fraction; over
    // thousands of bookings that is a few rupees, and it is the side to err on.
    assert.equal(commissionPaise(333, 1500), 49);
  });

  it('handles the boundaries a config typo would produce', () => {
    assert.equal(commissionPaise(100_000, 0), 0);
    assert.equal(commissionPaise(100_000, 10_000), 100_000);
    assert.equal(commissionPaise(0, 1500), 0);
  });
});

describe('Razorpay client — idempotency', () => {
  it('returns the existing order for a repeated receipt', async () => {
    // Razorpay enforces receipt uniqueness per account. A customer reloading
    // checkout must get the same order, not a second one against the same chair.
    const client = new StubRazorpayClient();
    const a = await client.createOrder({ amountPaise: 50_000, receipt: 'booking-1' });
    const b = await client.createOrder({ amountPaise: 50_000, receipt: 'booking-1' });
    assert.equal(a.id, b.id);
  });

  it('does not refund twice for the same refund row', async () => {
    // The worker retries a refund whose HTTP call timed out. If that call had
    // actually succeeded, a naive retry sends the customer their money twice.
    const client = new StubRazorpayClient();
    const order = await client.createOrder({ amountPaise: 50_000, receipt: 'booking-2' });
    const paid = client.pay(order.id);

    const first = await client.createRefund({
      paymentId: paid.paymentId,
      amountPaise: 50_000,
      refundId: 'refund-row-1',
      reason: 'salon closed',
    });
    const retry = await client.createRefund({
      paymentId: paid.paymentId,
      amountPaise: 50_000,
      refundId: 'refund-row-1',
      reason: 'salon closed',
    });

    assert.equal(first.id, retry.id);
    const payment = await client.fetchPayment(paid.paymentId);
    assert.equal(payment.amount_refunded, 50_000, 'the customer is refunded once, not twice');
  });

  it('signs its simulated payments the way the real handler does', async () => {
    const client = new StubRazorpayClient(SECRET);
    const order = await client.createOrder({ amountPaise: 1_000, receipt: 'booking-3' });
    const paid = client.pay(order.id);
    assert.equal(
      verifyCheckoutSignature(
        { orderId: paid.orderId, paymentId: paid.paymentId, signature: paid.signature },
        SECRET,
      ),
      true,
      'otherwise the stub would let a broken confirm path pass',
    );
  });
});

describe('rate limiter', () => {
  it('allows the burst then refuses', () => {
    const limiter = new RateLimiter(60, 3);
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.check('ip', 1, now);
    assert.throws(() => limiter.check('ip', 1, now), RateLimitError);
  });

  it('refills over time', () => {
    const limiter = new RateLimiter(60, 3); // one token per second
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.check('ip', 1, now);
    assert.throws(() => limiter.check('ip', 1, now), RateLimitError);
    limiter.check('ip', 1, now + 1_100); // a second later, one token is back
  });

  it('meters callers separately', () => {
    const limiter = new RateLimiter(60, 1);
    const now = 1_000_000;
    limiter.check('a', 1, now);
    limiter.check('b', 1, now);
    assert.throws(() => limiter.check('a', 1, now), RateLimitError);
  });

  it('reports a usable retry-after', () => {
    const limiter = new RateLimiter(60, 1);
    const now = 1_000_000;
    limiter.check('ip', 1, now);
    try {
      limiter.check('ip', 1, now);
      assert.fail('expected RateLimitError');
    } catch (err) {
      assert.ok(err instanceof RateLimitError);
      assert.ok(err.retryAfterSec >= 1, 'a Retry-After of 0 invites an immediate retry');
    }
  });
});
