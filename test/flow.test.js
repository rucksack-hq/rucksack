// End-to-end: server in-process, real HTTP, real sync into temp folders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createApp } from '../server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillnet-'));
process.env.SKILLNET_HOME = path.join(tmp, 'conf');
const cli = await import('../cli/skillnet.js');
let server, base;
const jar = {};

before(async () => {
  server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ db: openDb(':memory:'), baseUrl: base });
});
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
let app;

async function as(who, method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body && JSON.stringify(body) });
  const c = res.headers.get('set-cookie');
  if (c) jar[who] = c.split(';')[0];
  const out = await res.json().catch(() => ({}));
  return { http: res.status, ...out };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const skill = (name, extra = '') => ({ 'SKILL.md': b64(`---\nname: ${name}\ndescription: ${name} does things\n---\nBody ${extra}`), 'run.sh': b64('#!/bin/sh\necho hi\n') });
const names = (r) => r.skills.map((s) => s.name).sort();

test('accounts, friends, organizations, sync', async (t) => {
  for (const u of ['alice', 'bob', 'carol']) assert.equal((await as(u, 'POST', '/api/signup', { email: `${u}@x.com`, handle: u, password: 'password123' })).http, 200);
  const ids = {};
  for (const u of ['alice', 'bob', 'carol']) ids[u] = (await as(u, 'GET', '/api/me')).user.id;

  await t.test('private skill is hidden until shared with friends', async () => {
    const p = await as('alice', 'POST', '/api/skills/push', { files: skill('notes') });
    assert.equal(p.skill.visibility, 'private');
    assert.equal(p.skill.owner, 'alice');
    assert.deepEqual(names(await as('bob', 'GET', '/api/skills')), []);
    await as('alice', 'PATCH', `/api/skills/${p.skill.id}`, { visibility: 'friends' });
    assert.deepEqual(names(await as('bob', 'GET', '/api/skills')), [], 'not friends yet');
    assert.equal((await as('alice', 'POST', '/api/friends', { who: 'bob' })).http, 200);
    assert.deepEqual((await as('bob', 'GET', '/api/friends')).incoming.map((u) => u.handle), ['alice']);
    assert.equal((await as('bob', 'POST', '/api/friends', { who: 'alice' })).status, 'accepted');
    assert.deepEqual(names(await as('bob', 'GET', '/api/skills')), ['notes']);
    assert.deepEqual(names(await as('carol', 'GET', '/api/skills')), []);
    await as('bob', 'POST', `/api/skills/${p.skill.id}/install`);
    assert.deepEqual(names(await as('bob', 'GET', '/api/manifest')), ['notes']);
    assert.deepEqual(names(await as('alice', 'GET', '/api/manifest')), ['notes'], 'authors get their own skill');
    // Unfriending takes it away again.
    await as('alice', 'DELETE', `/api/friends/${ids.bob}`);
    assert.deepEqual(names(await as('bob', 'GET', '/api/manifest')), []);
    await as('alice', 'POST', '/api/friends', { who: 'bob' }); await as('bob', 'POST', '/api/friends', { who: 'alice' });
  });

  await t.test('organization required skills reach every member and leave with them', async () => {
    const o = await as('alice', 'POST', '/api/orgs', { slug: 'acme', name: 'Acme' });
    assert.equal(o.org.role, 'owner');
    const code = new URL((await as('alice', 'GET', '/api/orgs/acme')).org.invite).searchParams.get('code');
    assert.equal((await as('bob', 'POST', '/api/join', { code })).org.slug, 'acme');
    assert.equal((await as('bob', 'GET', '/api/orgs/acme')).org.invite, null, 'members do not see the invite');
    assert.equal((await as('bob', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook') })).http, 403, 'members cannot publish');
    const p = await as('alice', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook'), required: true });
    assert.equal(p.skill.required, true);
    assert.equal(p.skill.visibility, 'org');
    assert.deepEqual(names(await as('bob', 'GET', '/api/manifest')), ['handbook', 'notes']);
    assert.deepEqual(names(await as('carol', 'GET', '/api/manifest')), []);
    assert.equal((await as('carol', 'GET', `/api/skills/${p.skill.id}`)).http, 404);
    await as('alice', 'DELETE', `/api/orgs/acme/members/${ids.bob}`);
    assert.deepEqual(names(await as('bob', 'GET', '/api/manifest')), ['notes']);
    await as('bob', 'POST', '/api/join', { code });
  });

  await t.test('versions and rollback', async () => {
    const id = (await as('alice', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook', 'v2') })).skill.id;
    const same = await as('alice', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook', 'v2') });
    assert.equal(same.changed, false);
    const r = await as('alice', 'POST', `/api/skills/${id}/rollback`, { version: 1 });
    assert.equal(r.skill.version, 3);
    assert.match((await as('bob', 'GET', `/api/skills/${id}`)).skill_md, /Body $/);
  });

  await t.test('rejects unsafe input', async () => {
    assert.equal((await as('alice', 'POST', '/api/skills/push', { files: { 'SKILL.md': b64('---\nname: x\n---'), '../evil': b64('x') } })).http, 400);
    assert.equal((await as('alice', 'POST', '/api/skills/push', { files: { 'a.md': b64('x') }, name: 'y' })).http, 400);
    assert.equal((await as('alice', 'POST', '/api/skills/push', { files: skill('Bad Name') })).http, 400);
    assert.equal((await as('alice', 'POST', '/api/skills/push', { files: skill('notes') }, { 'Content-Type': 'text/plain' })).http, 415);
    assert.equal((await as('nobody', 'GET', '/api/manifest')).http, 401);
  });

  await t.test('device sign-in, sync into folders, live push', async () => {
    const d = await as('dev', 'POST', '/api/device/start', { label: 'bob@laptop' });
    assert.equal((await as('dev', 'POST', '/api/device/poll', { device_code: d.device_code })).http, 428);
    assert.equal((await as('bob', 'POST', '/api/device/approve', { user_code: d.user_code })).ok, true);
    const { token } = await as('dev', 'POST', '/api/device/poll', { device_code: d.device_code });
    assert.match(token, /^sn_/);

    const A = path.join(tmp, 'claude-skills'), B = path.join(tmp, 'pi-skills'), link = path.join(tmp, 'link-to-a');
    fs.mkdirSync(A); fs.mkdirSync(B); fs.symlinkSync(A, link);
    fs.mkdirSync(path.join(A, 'notes')); fs.writeFileSync(path.join(A, 'notes', 'SKILL.md'), 'mine');
    fs.mkdirSync(process.env.SKILLNET_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.SKILLNET_HOME, 'config.json'), JSON.stringify({ server: base, token, targets: [A, B, link] }));
    assert.equal(cli.targets().length, 2, 'linked folders are synced once');

    const r = await cli.sync({ quiet: true });
    assert.equal(r.skills, 2);
    assert.equal(fs.readFileSync(path.join(A, 'notes', 'SKILL.md'), 'utf8'), 'mine', 'own folder untouched');
    assert.match(fs.readFileSync(path.join(B, 'notes', 'SKILL.md'), 'utf8'), /name: notes/);
    assert.ok(fs.statSync(path.join(B, 'handbook', 'run.sh')).mode & 0o100, 'scripts are executable');
    assert.ok(fs.existsSync(path.join(process.env.SKILLNET_HOME, 'changed')));
    assert.equal((await cli.sync({ quiet: true })).changed, 0, 'second sync is a no-op');

    // Live push: bob's stream hears about alice's update.
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const reader = res.body.getReader();
    let seen = '';
    const heard = (async () => { while (!seen.includes('event: sync')) seen += Buffer.from((await reader.read()).value).toString(); })();
    await as('alice', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook', 'v4') });
    await Promise.race([heard, new Promise((_, no) => setTimeout(() => no(new Error('no push event')), 3000))]);
    ctl.abort();
    assert.equal((await cli.sync({ quiet: true })).changed, 2);
    assert.match(fs.readFileSync(path.join(A, 'handbook', 'SKILL.md'), 'utf8'), /v4/);

    // Local edits are never overwritten or deleted.
    fs.appendFileSync(path.join(B, 'handbook', 'SKILL.md'), 'my edit');
    await as('alice', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook', 'v5') });
    await cli.sync({ quiet: true });
    assert.match(fs.readFileSync(path.join(B, 'handbook', 'SKILL.md'), 'utf8'), /my edit/);
    assert.match(fs.readFileSync(path.join(A, 'handbook', 'SKILL.md'), 'utf8'), /v5/);

    // Making it optional removes it from machines that did not add it.
    const hb = (await as('alice', 'GET', '/api/orgs/acme')).skills[0];
    await as('alice', 'PATCH', `/api/skills/${hb.id}`, { required: false });
    await cli.sync({ quiet: true });
    assert.ok(!fs.existsSync(path.join(A, 'handbook')));
    assert.ok(fs.existsSync(path.join(B, 'handbook')), 'edited copy kept');

    // Signing the device out stops it.
    const { tokens } = await as('bob', 'GET', '/api/tokens');
    await as('bob', 'DELETE', `/api/tokens/${tokens[0].id}`);
    await assert.rejects(cli.sync({ quiet: true }), /sign in/);
  });
});
