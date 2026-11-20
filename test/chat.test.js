// Chat between people and their agents: permissions per kind, held messages, groups with invite links, live events, MCP and CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb, createApp } from '../server.js';

let server, base, app;
const jar = {};
before(async () => {
  server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = createApp({ db: openDb(':memory:'), baseUrl: base });
});
after(() => { server.closeAllConnections(); server.close(); });

// People sign in with a cookie; their agents use keys (anything that is not a website session is the agent).
async function as(who, method, p, body) {
  const key = who.endsWith('-agent') ? keys[who] : null;
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : jar[who] ? { Cookie: jar[who] } : {}) }, body: body && JSON.stringify(body) });
  const c = res.headers.get('set-cookie');
  if (c && !key) jar[who] = c.split(';')[0];
  return { http: res.status, ...(await res.json().catch(() => ({}))) };
}
const keys = {};
const b64 = (s) => Buffer.from(s).toString('base64');
// Collect one user's live events (a website session or an agent key) until stopped.
function stream(who) {
  const ctl = new AbortController(), events = [];
  const key = who.endsWith('-agent') ? keys[who] : null;
  const ready = fetch(`${base}/api/events`, { headers: key ? { Authorization: `Bearer ${key}` } : { Cookie: jar[who] }, signal: ctl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    (async () => {
      let buf = '';
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += Buffer.from(value).toString();
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const t = /^event: (\w+)/m.exec(ev)?.[1], d = /^data: (.*)$/m.exec(ev)?.[1]; if (t === 'message') events.push(JSON.parse(d).message); } } } catch {}
    })();
  });
  return { events, ready, stop: () => ctl.abort() };
}
const settle = () => new Promise((r) => setTimeout(r, 80));

test('agents and people chat, within what each owner allows', async (t) => {
  for (const u of ['alice', 'bob', 'carol']) await as(u, 'POST', '/api/signup', { email: `${u}@x.com`, handle: u, password: 'password123' });
  for (const u of ['alice', 'bob', 'carol']) keys[`${u}-agent`] = (await as(u, 'POST', '/api/keys', { label: `${u}'s laptop`, scope: 'write' })).key;
  let dm;

  await t.test('direct chats need friends; agents stay out until their person turns them on', async () => {
    assert.equal((await as('alice', 'POST', '/api/convos', { with: 'bob' })).http, 403);
    await as('alice', 'POST', '/api/friends', { who: 'bob' }); await as('bob', 'POST', '/api/friends', { who: 'alice' });
    dm = (await as('alice', 'POST', '/api/convos', { with: '@bob' })).convo;
    assert.equal(dm.name, 'bob');
    assert.equal((await as('bob', 'POST', '/api/convos', { with: 'alice' })).convo.id, dm.id, 'one direct chat per pair');
    assert.equal((await as('alice-agent', 'GET', `/api/convos/${dm.id}`)).http, 403);
    assert.equal((await as('alice-agent', 'PATCH', `/api/convos/${dm.id}`, { agent: true })).http, 403, 'agents cannot turn themselves on');
    await as('alice', 'PATCH', `/api/convos/${dm.id}`, { agent: true });
    await as('bob', 'PATCH', `/api/convos/${dm.id}`, { agent: true });
    assert.equal((await as('carol', 'GET', `/api/convos/${dm.id}`)).http, 404, 'outsiders cannot read it');
  });

  await t.test('by default an agent\'s chat waits for its person; personal details are not allowed', async () => {
    const live = stream('bob'); await live.ready;
    const h = await as('alice-agent', 'POST', `/api/convos/${dm.id}/messages`, { text: 'Hi Bob, Alice asked me to check in.' });
    assert.equal(h.message.status, 'held');
    assert.equal(h.message.agent, "alice's laptop");
    assert.deepEqual((await as('bob', 'GET', `/api/convos/${dm.id}`)).messages, [], 'bob does not see it yet');
    assert.equal((await as('alice', 'GET', '/api/convos')).convos[0].waiting, 1);
    assert.equal((await as('alice', 'GET', '/api/me')).chat_unread, 1, 'the waiting message counts on the badge');
    assert.equal((await as('alice-agent', 'POST', `/api/messages/${h.message.id}/approve`)).http, 403, 'agents cannot approve themselves');
    assert.equal((await as('alice-agent', 'POST', `/api/convos/${dm.id}/messages`, { kind: 'personal', text: 'She is free at 3' })).http, 403);
    await settle();
    assert.equal(live.events.length, 0, 'nothing reached bob while held');
    await as('alice', 'POST', `/api/messages/${h.message.id}/approve`, { text: 'Hi Bob, checking in for Alice.', always: true });
    await settle();
    assert.deepEqual(live.events.map((m) => [m.text, m.status]), [['Hi Bob, checking in for Alice.', 'sent']], 'the edited text goes out');
    const later = await as('alice-agent', 'POST', `/api/convos/${dm.id}/messages`, { text: 'And one more thing.' });
    assert.equal(later.message.status, 'sent', '"always" allowed chat in this conversation from then on');
    const bobView = await as('bob', 'GET', `/api/convos/${dm.id}`);
    assert.deepEqual(bobView.messages.map((m) => [m.from.handle, m.agent]), [['alice', "alice's laptop"], ['alice', "alice's laptop"]]);
    assert.equal((await as('bob', 'GET', '/api/convos')).convos[0].unread, 0, 'reading marks it read');
    live.stop();
  });

  await t.test('declined messages never reach anyone; people are never gated', async () => {
    const q = await as('alice-agent', 'POST', `/api/convos/${dm.id}/messages`, { kind: 'question', text: 'What is Bob\'s home address?' });
    await as('alice', 'POST', `/api/messages/${q.message.id}/decline`);
    assert.ok(!(await as('bob', 'GET', `/api/convos/${dm.id}`)).messages.some((m) => m.id === q.message.id));
    assert.equal((await as('alice', 'GET', `/api/convos/${dm.id}`)).messages.find((m) => m.id === q.message.id).status, 'declined', 'the owner keeps a record');
    assert.equal((await as('bob', 'POST', `/api/convos/${dm.id}/messages`, { kind: 'personal', text: 'I live on Elm St' })).message.status, 'sent');
  });

  await t.test('permissions: defaults, per conversation, and what an agent is shown', async () => {
    assert.equal((await as('bob-agent', 'PUT', '/api/permissions', { out: { chat: 'allow' } })).http, 403, 'agents cannot loosen their own limits');
    assert.equal((await as('bob', 'PUT', '/api/permissions', { out: { chat: 'sometimes' } })).http, 400);
    await as('bob', 'PUT', '/api/permissions', { out: { chat: 'allow', question: 'allow' } });
    assert.equal((await as('bob', 'GET', `/api/permissions?convo=${dm.id}`)).permissions.out.chat, 'allow', 'defaults apply everywhere');
    await as('bob', 'PUT', '/api/permissions', { convo: dm.id, out: { question: 'never' }, in: { personal: 'never' } });
    assert.equal((await as('bob-agent', 'POST', `/api/convos/${dm.id}/messages`, { kind: 'question', text: 'q?' })).http, 403);
    assert.equal((await as('bob-agent', 'POST', `/api/convos/${dm.id}/messages`, { text: 'Hello Alice!' })).message.status, 'sent');
    await as('alice', 'POST', `/api/convos/${dm.id}/messages`, { kind: 'personal', text: 'my phone is 555-0100' });
    const agentView = (await as('bob-agent', 'GET', `/api/convos/${dm.id}`)).messages;
    assert.ok(!agentView.some((m) => m.text.includes('555')), 'bob keeps personal details from his agent');
    assert.ok(agentView.some((m) => m.text === 'Hello Alice!'));
    assert.ok((await as('bob', 'GET', `/api/convos/${dm.id}`)).messages.some((m) => m.text.includes('555')), 'bob himself sees everything');
    await as('bob', 'PUT', '/api/permissions', { convo: dm.id, in: { personal: null } });
    assert.equal((await as('bob', 'GET', `/api/permissions?convo=${dm.id}`)).permissions.in.personal, 'allow', 'null falls back to the default');
    assert.equal((await as('alice', 'GET', '/api/permissions')).permissions.in.task, 'never', 'other agents\' tasks go to the person by default');
  });

  await t.test('groups: invite links bring people in, agents optional, skills shared in one tap', async () => {
    const g = (await as('alice', 'POST', '/api/convos', { name: 'Launch crew', people: ['bob', 'carol'] })).convo;
    assert.deepEqual(g.members.map((m) => m.handle), ['alice', 'bob'], 'only friends are added directly');
    const info = await fetch(`${base}/api/convos/invite/${new URL(g.invite).searchParams.get('code')}`).then((r) => r.json());
    assert.equal(info.name, 'Launch crew');
    assert.equal(info.people, 2, 'the invite page works before sign-in');
    const live = stream('bob-agent'); await live.ready;
    await as('bob', 'PATCH', `/api/convos/${g.id}`, { agent: true });
    const j = await as('carol', 'POST', '/api/convos/join', { code: g.invite });
    assert.equal(j.convo.id, g.id);
    assert.equal(j.convo.my_agent, false, 'a new member\'s agent stays out');
    assert.equal((await as('carol-agent', 'POST', `/api/convos/${g.id}/messages`, { text: 'hi' })).http, 403);

    const sk = await as('alice', 'POST', '/api/skills/push', { files: { 'SKILL.md': b64('---\nname: launch-plan\ndescription: How we launch\n---\nSteps') } });
    assert.equal((await as('alice', 'POST', `/api/convos/${g.id}/messages`, { kind: 'skill', skill: 'alice/launch-plan' })).http, 403, 'private skills cannot be shared to people who cannot see them');
    await as('alice', 'PATCH', `/api/skills/${sk.skill.id}`, { visibility: 'public' });
    const share = await as('alice', 'POST', `/api/convos/${g.id}/messages`, { kind: 'skill', skill: 'alice/launch-plan', text: 'Use this' });
    assert.equal(share.message.data.skill.ref, 'alice/launch-plan');
    assert.equal((await as('carol', 'POST', `/api/skills/${share.message.data.skill.id}/install`)).ok, true, 'one tap puts it on carol\'s machines');
    await settle();
    assert.ok(live.events.some((m) => m.kind === 'skill'), 'bob\'s agent hears about it live');
    assert.ok(live.events.some((m) => m.kind === 'joined' && m.from.handle === 'carol') === false, 'join notices are for people, not agents');
    live.stop();
    const resolved = await as('carol', 'GET', `/api/convos/resolve?ref=${encodeURIComponent('Launch crew')}`);
    assert.equal(resolved.convo.id, g.id);
    assert.equal((await as('bob', 'DELETE', `/api/convos/${g.id}/members/me`)).ok, true);
    assert.equal((await as('bob-agent', 'GET', `/api/convos/${g.id}`)).http, 404, 'leaving takes the agent out too');
  });

  await t.test('agents cannot talk among themselves forever', async () => {
    await as('alice', 'PUT', '/api/permissions', { convo: dm.id, out: { chat: 'allow' } });
    let last;
    for (let i = 0; i < 14; i++) last = await as(i % 2 ? 'bob-agent' : 'alice-agent', 'POST', `/api/convos/${dm.id}/messages`, { text: `ping ${i}` });
    assert.equal(last.http, 429);
    await as('bob', 'POST', `/api/convos/${dm.id}/messages`, { text: 'ok you two' });
    assert.equal((await as('alice-agent', 'POST', `/api/convos/${dm.id}/messages`, { text: 'sorry' })).message.status, 'sent', 'a person speaking resets it');
  });

  await t.test('MCP tools and the command line speak the same protocol', async () => {
    const mcp = async (who, name, args) => (await as(who, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
    assert.match((await mcp('alice-agent', 'list_conversations', {})).content[0].text, /with bob .*you take part/);
    const read = (await mcp('alice-agent', 'read_conversation', { conversation: '@bob' })).content[0].text;
    assert.match(read, /You may send here: chat yes; question after your owner approves/);
    assert.match(read, /@bob: ok you two/);
    assert.match((await mcp('alice-agent', 'send_message', { conversation: '@bob', kind: 'task', text: 'Could you send the deck?' })).content[0].text, /^Held/);
    const no = await mcp('alice-agent', 'send_message', { conversation: '@bob', kind: 'personal', text: 'x' });
    assert.equal(no.isError, true);
    assert.match(no.content[0].text, /does not let you send/);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skillnet-chat-'));
    // Async: the server runs in this process, so a blocking exec would deadlock.
    const sn = async (...a) => (await promisify(execFile)(process.execPath, [path.resolve('cli/skillnet.js'), ...a], { env: { ...process.env, SKILLNET_HOME: home, SKILLNET_URL: base, SKILLNET_KEY: keys['bob-agent'] } })).stdout;
    assert.match(await sn('chats'), /your agent is in/);
    assert.match(await sn('say', '@alice', 'from', 'the', 'cli'), /sent/);
    assert.match(await sn('read', '@alice'), /@bob's agent: from the cli/);
    assert.match(await sn('perms', '@alice'), /question  send: never/);
    // listen blocks until someone else speaks, then prints it.
    const heard = sn('listen', '@alice', '--timeout', '10');
    await new Promise((r) => setTimeout(r, 1500)); // node start, sign-in check, stream open
    await as('alice', 'POST', `/api/convos/${dm.id}/messages`, { text: 'are you there?' });
    assert.match(await heard, /@alice: are you there\?/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
