// Billing: seat limit on the free plan, checkout, signed webhook, seat sync. Stripe is a fake that records calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb, createApp, stripeVerify, FREE_SEATS } from '../server.js';

const calls = [];
const fakeStripe = async (method, p, params) => {
  calls.push([method, p, params]);
  if (p === '/checkout/sessions') return { url: 'https://checkout.stripe.test/s1' };
  if (p === '/billing_portal/sessions') return { url: 'https://billing.stripe.test/p1' };
  if (p === '/subscriptions/sub_1') return { items: { data: [{ id: 'si_1', quantity: 1 }] } };
  return {};
};
const SECRET = 'whsec_test';
let server, base; const jar = {};
before(async () => {
  server = http.createServer((q, s) => app.handle(q, s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ db: openDb(':memory:'), baseUrl: base, billing: { stripe: fakeStripe, price: 'price_x', webhookSecret: SECRET, priceLabel: '$8 per person a month' } });
});
after(() => { server.closeAllConnections(); server.close(); });
let app;
async function as(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body && JSON.stringify(body) });
  const c = res.headers.get('set-cookie'); if (c) jar[who] = c.split(';')[0];
  return { http: res.status, ...(await res.json().catch(() => ({}))) };
}
const sign = (raw, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;
const hook = (ev, sig) => { const raw = JSON.stringify(ev); return fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig ?? sign(raw) }, body: raw }); };

test('free seat limit, checkout, webhook, seat sync', async () => {
  const people = ['own', 'p2', 'p3', 'p4', 'p5'];
  for (const u of people) assert.equal((await as(u, 'POST', '/api/signup', { email: `${u}@x.com`, handle: u, password: 'password123' })).http, 200);
  assert.equal((await as('own', 'POST', '/api/orgs', { slug: 'acme', name: 'Acme' })).http, 200);
  const o = (await as('own', 'GET', '/api/orgs/acme')).org;
  assert.equal(o.plan, 'free'); assert.equal(o.can_bill, true);
  const code = new URL(o.invite).searchParams.get('code');
  for (const u of people.slice(1, FREE_SEATS)) assert.equal((await as(u, 'POST', '/api/join', { code })).http, 200);
  assert.equal((await as('p4', 'POST', '/api/join', { code })).http, 402, 'free plan is full');

  assert.equal((await as('p2', 'POST', '/api/orgs/acme/billing/checkout')).http, 403, 'members cannot buy');
  const co = await as('own', 'POST', '/api/orgs/acme/billing/checkout');
  assert.equal(co.url, 'https://checkout.stripe.test/s1');
  const params = calls.at(-1)[2];
  assert.equal(params.line_items[0].quantity, FREE_SEATS);
  const orgId = params.client_reference_id;

  assert.equal((await hook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: orgId, customer: 'cus_1', subscription: 'sub_1' } } }, 't=1,v1=bad')).status, 400);
  assert.equal((await hook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: orgId, customer: 'cus_1', subscription: 'sub_1' } } })).status, 200);
  assert.equal((await as('own', 'GET', '/api/orgs/acme')).org.plan, 'team');

  assert.equal((await as('p4', 'POST', '/api/join', { code })).http, 200, 'team has no limit');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls.find((c) => c[1] === '/subscription_items/si_1')?.[2].quantity, FREE_SEATS + 1);
  assert.equal((await as('own', 'POST', '/api/orgs/acme/billing/portal')).url, 'https://billing.stripe.test/p1');

  await hook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', customer: 'cus_1', metadata: { org: orgId } } } });
  assert.equal((await as('own', 'GET', '/api/orgs/acme')).org.plan, 'free');
  assert.equal((await as('p5', 'GET', '/api/plans')).team, '$8 per person a month');
});

test('signature check rejects old and forged events', () => {
  const raw = '{"a":1}', t = Math.floor(Date.now() / 1000);
  assert.ok(stripeVerify(raw, sign(raw, t), SECRET));
  assert.ok(!stripeVerify(raw, sign(raw, t - 600), SECRET));
  assert.ok(!stripeVerify('{"a":2}', sign(raw, t), SECRET));
  assert.ok(!stripeVerify(raw, undefined, SECRET));
});
