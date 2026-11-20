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
const names = (r) => r.skills.filter((s) => !s.builtin).map((s) => s.name).sort();
import { execFileSync } from 'node:child_process';

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

  await t.test('roles: editors change content, admins decide who gets it, members suggest', async () => {
    await as('alice', 'POST', `/api/orgs/acme/members/${ids.bob}`, { role: 'editor' });
    const id = (await as('alice', 'GET', '/api/orgs/acme')).skills[0].id;
    const e = await as('bob', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook', 'by bob') });
    assert.equal(e.http, 200, 'editors can change a skill');
    assert.equal((await as('bob', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook', 'x'), required: false })).http, 403, 'but not who gets it');
    assert.equal((await as('bob', 'PATCH', `/api/skills/${id}`, { visibility: 'public' })).http, 403);
    assert.equal((await as('bob', 'DELETE', `/api/skills/${id}`)).http, 403);
    await as('alice', 'POST', `/api/orgs/acme/members/${ids.bob}`, { role: 'member' });
    assert.equal((await as('bob', 'POST', '/api/skills/push', { org: 'acme', files: skill('handbook', 'y') })).http, 403);
    assert.equal((await as('carol', 'POST', `/api/skills/${id}/proposals`, { files: skill('handbook', 'z') })).http, 404, 'outsiders cannot see it');
    const p = await as('bob', 'POST', `/api/skills/${id}/proposals`, { files: skill('handbook', 'suggested'), note: 'typo' });
    assert.equal(p.proposal.status, 'open');
    assert.equal((await as('bob', 'POST', `/api/proposals/${p.proposal.id}/approve`)).http, 403, 'members cannot approve their own');
    const list = (await as('alice', 'GET', '/api/proposals')).proposals;
    assert.deepEqual(list.map((x) => [x.author, x.can_approve]), [['bob', true]]);
    const before = (await as('alice', 'GET', `/api/skills/${id}`)).skill.version;
    const a = await as('alice', 'POST', `/api/proposals/${p.proposal.id}/approve`);
    assert.equal(a.skill.version, before + 1);
    const d = await as('alice', 'GET', `/api/skills/${id}`);
    assert.match(d.skill_md, /suggested/);
    assert.equal(d.versions[0].author, 'bob', 'credit goes to whoever suggested it');
    assert.equal((await as('alice', 'GET', '/api/proposals')).proposals.length, 0);
    assert.equal((await as('bob', 'GET', '/api/resolve?ref=acme/handbook')).skill.id, id);
    assert.equal((await as('bob', 'GET', '/api/resolve?ref=nope')).http, 404);
  });

  await t.test('API keys: read keys sync and search, write keys publish; pull script and MCP for cloud runs', async () => {
    const read = (await as('bob', 'POST', '/api/keys', { label: 'Cursor cloud' })).key;
    const write = (await as('alice', 'POST', '/api/keys', { label: 'CI', scope: 'write' })).key;
    const bear = (k) => ({ Authorization: `Bearer ${k}`, Cookie: '' });
    assert.equal((await as('anon', 'GET', '/api/me', null, bear(read))).user.handle, 'bob');
    assert.equal((await as('anon', 'POST', '/api/skills/push', { files: skill('x') }, bear(read))).http, 403);
    assert.equal((await as('anon', 'POST', '/api/skills/push', { files: skill('ci-skill') }, bear(write))).http, 200);
    assert.ok((await as('bob', 'GET', '/api/tokens')).tokens.some((k) => k.kind === 'key' && k.scope === 'read'));
    assert.match((await as('anon', 'GET', '/api/skills?q=suggested', null, bear(read))).skills[0].name, /handbook/, 'search reads SKILL.md text');

    // The pull script needs only sh, curl and base64.
    const res = await fetch(`${base}/api/pull.sh`, { headers: { Authorization: `Bearer ${read}` } });
    const dir = path.join(tmp, 'cloud');
    fs.mkdirSync(path.join(dir, 'mine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mine', 'SKILL.md'), 'own');
    const say = execFileSync('sh', ['-c', await res.text()], { env: { ...process.env, SKILLNET_DIRS: dir } }).toString();
    assert.match(say, /skills written/);
    assert.match(fs.readFileSync(path.join(dir, 'handbook', 'SKILL.md'), 'utf8'), /suggested/);
    assert.match(fs.readFileSync(path.join(dir, 'skillnet', 'SKILL.md'), 'utf8'), new RegExp(base.replace(/[.:/]/g, '\\$&')), 'the guide skill names this server');
    assert.ok(fs.statSync(path.join(dir, 'handbook', 'run.sh')).mode & 0o100);
    assert.equal(fs.readFileSync(path.join(dir, 'mine', 'SKILL.md'), 'utf8'), 'own');

    // MCP: same answers as the command line.
    const mcp = async (key, method, params) => (await as('anon', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, bear(key))).result;
    assert.equal((await mcp(read, 'initialize', {})).serverInfo.name, 'rucksack');
    assert.ok((await mcp(read, 'tools/list')).tools.some((x) => x.name === 'suggest_change'));
    const text = async (key, name, args) => (await mcp(key, 'tools/call', { name, arguments: args })).content[0].text;
    assert.match(await text(read, 'search_skills', { query: 'hand' }), /acme\/handbook/);
    assert.match(await text(read, 'read_skill', { skill: 'acme/handbook' }), /suggested/);
    assert.match(await text(read, 'skill_info', { skill: 'acme/handbook' }), /suggest changes to it/);
    assert.match(await text(read, 'my_account', {}), /acme \(member\)/);
    assert.match(await text(read, 'publish_skill', { name: 'nope', files: { 'SKILL.md': '---\nname: nope\n---' } }), /read-only/);
    const bobWrite = (await as('bob', 'POST', '/api/keys', { label: 'laptop agent', scope: 'write' })).key;
    assert.match(await text(bobWrite, 'suggest_change', { skill: 'acme/handbook', files: { 'SKILL.md': '---\nname: handbook\ndescription: d\n---\nfrom mcp' }, note: 'via mcp' }), /Suggested change/);
    const p = (await as('alice', 'GET', '/api/proposals')).proposals[0];
    assert.equal(p.note, 'via mcp');
    assert.deepEqual(p.files, ['SKILL.md', 'run.sh'], 'files left out are kept');
    await as('alice', 'POST', `/api/proposals/${p.id}/decline`);
    assert.match(await text(write, 'publish_skill', { name: 'from-mcp', files: { 'SKILL.md': '---\nname: from-mcp\ndescription: d\n---\nhi' } }), /Published alice\/from-mcp/);
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
    assert.equal(r.skills, 3, 'notes, handbook and the skillnet guide');
    assert.ok(fs.existsSync(path.join(B, 'skillnet', 'SKILL.md')));
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

test('connector sign-in (OAuth with PKCE), skill list in instructions, prompts, revoke', async () => {
  const crypto = await import('node:crypto');
  const form = async (p, fields) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }); return { http: r.status, ...(await r.json()) }; };
  const rpc = async (token, method, params) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

  // Unauthenticated MCP call points the client at the discovery document.
  const r0 = await rpc(null, 'initialize', {});
  assert.equal(r0.status, 401);
  assert.match(r0.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.equal((await fetch(`${base}/mcp`, { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), '*');

  // Registration rejects unsafe redirect addresses.
  assert.equal((await as('anon', 'POST', '/oauth/register', { redirect_uris: ['http://evil.example/cb'] })).http, 400);
  const reg = await as('anon', 'POST', '/oauth/register', { client_name: 'Claude', redirect_uris: ['http://127.0.0.1/callback', 'https://claude.ai/api/mcp/auth_callback'] });
  assert.equal(reg.http, 201);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirect_uri = 'http://127.0.0.1:53111/callback'; // any loopback port is fine
  const q = `client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}`;
  assert.equal((await as('alice', 'GET', `/api/oauth/client?${q}`)).name, 'Claude');
  assert.equal((await as('alice', 'GET', `/api/oauth/client?client_id=${reg.client_id}&redirect_uri=https://evil.example/cb`)).http, 400);

  // A bearer token cannot approve on someone's behalf; the browser session can.
  const ap = { client_id: reg.client_id, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', allow: true };
  const key = (await as('alice', 'POST', '/api/keys', { label: 'k', scope: 'write' })).key;
  assert.equal((await as('anon', 'POST', '/api/oauth/approve', ap, { Authorization: `Bearer ${key}` })).http, 403);
  const denied = new URL((await as('alice', 'POST', '/api/oauth/approve', { ...ap, allow: false })).redirect);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  const back = new URL((await as('alice', 'POST', '/api/oauth/approve', ap)).redirect);
  assert.equal(back.searchParams.get('state'), 'st8');
  const code = back.searchParams.get('code');

  assert.equal((await form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: 'wrong'.repeat(10), client_id: reg.client_id, redirect_uri })).error, 'invalid_grant');
  // The failed attempt used the code up, so get a fresh one.
  const code2 = new URL((await as('alice', 'POST', '/api/oauth/approve', ap)).redirect).searchParams.get('code');
  const tok = await form('/oauth/token', { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri });
  assert.equal(tok.http, 200);
  assert.equal(tok.expires_in, 3600);
  assert.equal((await form('/oauth/token', { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri })).error, 'invalid_grant');

  // Signed in: the skill list arrives in the instructions; skills are prompts; cookies are ignored on /mcp.
  const init = await (await rpc(tok.access_token, 'initialize', {})).json();
  assert.match(init.result.instructions, /acme\/handbook/);
  assert.match(init.result.instructions, /skillnet\/skillnet/);
  const prompts = (await (await rpc(tok.access_token, 'prompts/list')).json()).result.prompts;
  assert.ok(prompts.some((p) => p.name === 'handbook'));
  const got = (await (await rpc(tok.access_token, 'prompts/get', { name: 'handbook', arguments: { request: 'onboard Dana' } })).json()).result;
  assert.match(got.messages[0].content.text, /Request: onboard Dana/);
  assert.equal((await as('alice', 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).http, 401);
  // The refresh token is not an access token.
  assert.equal((await rpc(tok.refresh_token, 'ping')).status, 401);

  // Refresh rotates: the old refresh token and old access token stop working.
  const tok2 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id });
  assert.equal(tok2.http, 200);
  assert.equal((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id })).error, 'invalid_grant');
  assert.equal((await rpc(tok.access_token, 'ping')).status, 401);
  assert.equal((await rpc(tok2.access_token, 'ping')).status, 200);

  // The app shows on the Keys page; revoking it ends both tokens.
  const app_ = (await as('alice', 'GET', '/api/tokens')).tokens.find((t) => t.kind === 'connector');
  assert.equal(app_.label, 'Claude');
  await as('alice', 'DELETE', `/api/tokens/${app_.id}`);
  assert.equal((await rpc(tok2.access_token, 'ping')).status, 401);
  assert.equal((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok2.refresh_token, client_id: reg.client_id })).error, 'invalid_grant');
});
