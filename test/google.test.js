// Sign in with Google: verifies email, creates accounts, and takes an account back from someone who typed another person's email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, createApp } from '../server.js';

test('sign in with Google verifies the email and locks out impostors', async () => {
  const ids = {}; // code -> id token claims Google would return
  const db = openDb(':memory:');
  let app;
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ db, baseUrl: base, google: { clientId: 'cid', clientSecret: 's', exchange: async (code) => ids[code] } });

  const jar = {};
  const call = async (who, method, p, body) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body && JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0], k = kv.split('=')[0];
      jar[who] = [...(jar[who] || '').split('; ').filter((x) => x && !x.startsWith(`${k}=`)), kv].join('; ');
    }
    return { http: res.status, location: res.headers.get('location'), ...(await res.json().catch(() => ({}))) };
  };
  const google = async (who, claims, next = '/orgs') => {
    const start = await call(who, 'GET', `/api/auth/google?next=${encodeURIComponent(next)}`);
    assert.equal(start.http, 302);
    const state = new URL(start.location).searchParams.get('state');
    const code = `c${Object.keys(ids).length}`;
    ids[code] = { iss: 'https://accounts.google.com', aud: 'cid', email_verified: true, ...claims };
    return call(who, 'GET', `/api/auth/google/callback?state=${state}&code=${code}`);
  };
  try {
    assert.equal((await call('x', 'GET', '/api/plans')).google, true);

    // New person: account made, verified, signed in, sent where they were going.
    const first = await google('barb', { sub: 'g1', email: 'Barbara@WBG.com', name: 'Barbara P' });
    assert.equal(first.location, '/orgs');
    const meB = await call('barb', 'GET', '/api/me');
    assert.equal(meB.email, 'barbara@wbg.com');
    assert.equal(meB.email_verified, true);
    assert.equal(meB.user.handle, 'barbara');

    // Wrong state, wrong audience and unconfirmed Google emails are refused.
    assert.match((await call('y', 'GET', '/api/auth/google/callback?state=nope&code=c0')).location, /^\/signin\?error=/);
    assert.match((await google('y', { sub: 'g9', email: 'y@wbg.com', aud: 'other' })).location, /^\/signin\?error=/);
    assert.match((await google('y', { sub: 'g9', email: 'y@wbg.com', email_verified: false })).location, /^\/signin\?error=/);
    assert.equal((await call('y', 'GET', '/api/me')).http, 401);

    // Someone signs up with Megan's address and a password; the account stays unverified.
    await call('mallory', 'POST', '/api/signup', { handle: 'megan', email: 'megan@wbg.com', password: 'password123' });
    assert.equal((await call('mallory', 'GET', '/api/me')).email_verified, false);
    // The real Megan signs in with Google: she gets the account, the impostor's session and password stop working.
    await google('megan', { sub: 'g2', email: 'megan@wbg.com' });
    assert.equal((await call('megan', 'GET', '/api/me')).email_verified, true);
    assert.equal((await call('mallory', 'GET', '/api/me')).http, 401);
    assert.equal((await call('mallory2', 'POST', '/api/login', { email: 'megan@wbg.com', password: 'password123' })).http, 401);

    // A verified password user later signs in with Google: same account, sessions kept.
    await call('dan', 'POST', '/api/signup', { handle: 'dan', email: 'dan@wbg.com', password: 'password123' });
    const before = await call('dan', 'GET', '/api/me');
    await google('dan', { sub: 'g3', email: 'dan@wbg.com' }); // signed in already: confirms the address
    const after = await call('dan', 'GET', '/api/me');
    assert.equal(after.user.id, before.user.id);
    assert.equal(after.email_verified, true);
    // Signed in as Dan, confirming with someone else's Google account is refused.
    assert.match(decodeURIComponent((await google('dan', { sub: 'g1', email: 'barbara@wbg.com' })).location), /another Rucksack account/);
    // Handles never collide: a second "megan" from another domain gets megan2.
    await google('m2', { sub: 'g4', email: 'megan@other.com' });
    assert.equal((await call('m2', 'GET', '/api/me')).user.handle, 'megan2');
  } finally {
    server.closeAllConnections(); server.close();
  }
});
