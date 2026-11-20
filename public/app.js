// Rucksack web app: plain DOM, no build step.
const $main = document.getElementById('main');
let me = null;

const fill = (...kids) => $main.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== 0));
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `HTTP ${res.status}`), { status: res.status });
  return out;
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}
const go = (url) => { history.pushState(null, '', url); render(); };
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || e.metaKey || e.ctrlKey || a.target) return;
  e.preventDefault(); go(a.getAttribute('href'));
});
addEventListener('popstate', render);
const act = (fn) => async (e) => {
  e?.preventDefault?.();
  const b = e?.currentTarget?.tagName === 'BUTTON' ? e.currentTarget : null;
  if (b) b.disabled = true;
  try { await fn(e); } catch (err) { toast(err.message); } finally { if (b) b.disabled = false; }
};
const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const VIS_LABEL = { private: 'Only me', friends: 'Friends', org: 'Organization', public: 'Everyone' };
const ROLE_HELP = {
  owner: 'Everything, including roles',
  admin: 'Decides who gets skills, manages people',
  editor: 'Changes what skills say',
  member: 'Uses skills, suggests changes',
};
const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const unb64 = (data) => new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
const copyBtn = (text, label = 'Copy') => h('button', { type: 'button', onclick: act(async () => { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); toast('Copied'); }) }, label);
const editor = (value, label) => { const t = h('textarea', { class: 'code', 'aria-label': label, spellcheck: 'false' }); t.value = value; return t; };

function nav() {
  const links = me ? [['/', 'My skills'], ['/browse', 'Browse'], ['/chat', me.chat_unread ? `Chat (${me.chat_unread})` : 'Chat'], ['/connect', 'Connect'], ['/friends', 'Friends'], ['/orgs', 'Organizations'], ['/devices', 'Keys']]
    : [['/#how', 'How it works'], ['/pricing', 'Pricing'], ['/signin', 'Sign in'], ['/signin?mode=signup', 'Start free']];
  const path = location.pathname;
  document.getElementById('nav').replaceChildren(
    ...links.map(([href, label]) => h('a', { href, class: (href === '/' ? path === '/' : path.startsWith(href)) ? 'on' : null }, label)),
    ...(me ? [h('a', { href: '#', onclick: act(async () => { await api('POST', '/api/logout'); me = null; live?.close(); live = null; go('/'); }) }, `Sign out @${me.user.handle}`)] : []),
  );
}

function skillRow(s, { onChange } = {}) {
  return h('div', { class: 'card skill row' },
    h('div', { class: 'grow' },
      h('a', { class: 'name', href: `/s/${s.id}` }, `${s.owner}/${s.name}`),
      h('div', { class: 'desc' }, s.description || 'No description'),
    ),
    h('span', { class: 'tag' }, VIS_LABEL[s.visibility]),
    s.required && h('span', { class: 'tag req' }, 'Required'),
    s.open_proposals > 0 && h('a', { class: 'tag req', href: `/s/${s.id}#suggestions` }, `${s.open_proposals} suggested`),
    installButton(s, onChange),
  );
}
function installButton(s, onChange) {
  if (s.required) return null;
  return h('button', {
    class: s.installed ? null : 'primary',
    onclick: act(async () => {
      await api(s.installed ? 'DELETE' : 'POST', `/api/skills/${s.id}/install`);
      toast(s.installed ? 'Removed from your machines' : 'Added to your machines');
      (onChange || render)();
    }),
  }, s.installed ? 'Remove' : 'Add to my machines');
}

// Text box in the house style: grows as you type, with dictation and a send arrow beneath.
function askBox({ placeholder, value = '', onsend, sendLabel = 'Search' }) {
  const ta = h('textarea', { rows: 1, placeholder, 'aria-label': placeholder });
  ta.value = value;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onsend(ta.value.trim()); } });
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  const mic = Rec && h('button', { type: 'button', 'aria-label': 'Dictate', title: 'Dictate', onclick: () => {
    if (rec) { rec.stop(); return; }
    rec = new Rec(); rec.interimResults = true;
    const start = ta.value;
    rec.onresult = (e) => { ta.value = `${start} ${[...e.results].map((r) => r[0].transcript).join('')}`.trim(); };
    rec.onend = () => { rec = null; mic.classList.remove('live'); };
    rec.start(); mic.classList.add('live');
  } }, 'Dictate');
  return h('div', { class: 'ask' }, ta, h('div', { class: 'tools' }, mic,
    h('button', { type: 'button', class: 'send', 'aria-label': sendLabel, onclick: () => onsend(ta.value.trim()) }, '→')));
}

function snippet(text) { return h('div', { class: 'snippet' }, h('pre', {}, text), copyBtn(text)); }
function keyMaker(onMade, label = '') {
  const err = h('div', { class: 'err' });
  return h('form', { class: 'inline wrap', onsubmit: act(async (e) => {
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('POST', '/api/keys', { label: f.label, scope: f.write ? 'write' : 'read' });
      onMade(r.key);
      if (!label) { await navigator.clipboard.writeText(r.key).catch(() => {}); alert(`Your new key (copied):\n\n${r.key}\n\nIt is not shown again.`); }
    } catch (x) { err.textContent = x.message; }
  }) }, h('input', { name: 'label', placeholder: 'Key name, like “Cursor cloud”', 'aria-label': 'Key name', value: label || null, required: true }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'write' }), 'Can publish'),
    h('button', { class: 'primary' }, 'Make key'), err);
}

// Chat: people and their agents in direct and group conversations. Live through /api/events.
const MODE_OUT = [['allow', 'Yes'], ['ask', 'Ask me'], ['never', 'No']];
const MODE_IN = [['allow', 'Yes'], ['never', 'No']];
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const dayName = (t) => (sameDay(t, Date.now()) ? 'Today' : sameDay(t, Date.now() - 864e5) ? 'Yesterday' : new Date(t).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
const who = (m) => (m.from.id === me.user.id ? (m.agent ? 'Your agent' : 'You') : m.agent ? `${m.from.name}’s agent` : m.from.name);
let chatState = null; // the open chat page, so live events can update it in place

function seg(options, value, onpick, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const draw = (v) => wrap.replaceChildren(...options.map(([k, text]) => h('button', { type: 'button', class: k === v ? 'on' : null, 'aria-pressed': String(k === v),
    onclick: act(async () => { if (k === value) return; await onpick(k); value = k; draw(k); }) }, text)));
  draw(value);
  return wrap;
}
// What your agent may send ("Send") and what it is shown ("Shown to my agent"), per kind of message.
function permTable(convo, perms, kinds) {
  const put = (dir, k) => async (v) => { await api('PUT', '/api/permissions', { convo, [dir]: { [k]: v } }); toast('Saved'); };
  return h('table', { class: 'perms' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Kind of message'), h('th', {}, 'My agent may send'), h('th', {}, 'Shown to my agent'))),
    h('tbody', {}, Object.entries(kinds).map(([k, label]) => h('tr', {},
      h('td', {}, label),
      h('td', {}, seg(MODE_OUT, perms.out[k], put('out', k), `${label}: may send`)),
      h('td', {}, seg(MODE_IN, perms.in[k], put('in', k), `${label}: shown to my agent`))))));
}

// Square avatar with initials. People are filled; agents are the same color in outline, so you can tell them apart at a glance.
const hue = (id) => [...String(id)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 6, 0);
const initials = (u) => (u.name || u.handle || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (u, agent, size = '') => h('span', { class: `av av${hue(u.id)}${agent ? ' bot' : ''} ${size}`, 'aria-hidden': 'true' }, size === 'xs' ? initials(u)[0] : initials(u));
const nameOf = (u) => (u.id === me.user.id ? 'You' : u.name);

function msgNode(m, prev, kinds) {
  const head = !prev || prev.from.id !== m.from.id || prev.agent !== m.agent || m.created - prev.created > 5 * 60e3 || prev.kind === 'joined' || prev.status !== m.status;
  if (m.kind === 'joined') return h('div', { class: 'msg note', 'data-id': m.id }, h('span', { class: 'gut' }), h('div', {}, h('strong', {}, nameOf(m.from)), ' joined.'));
  const body = [];
  if (m.status === 'held') body.push(h('div', { class: 'only' }, 'Only visible to you'));
  if (m.kind === 'skill' && m.text && m.status !== 'held') body.push(h('div', { class: 'text' }, m.text));
  if (m.kind === 'skill') {
    const s = m.data.skill;
    body.push(h('div', { class: 'attach' }, h('div', { class: 'grow' }, h('a', { class: 'name', href: `/s/${s.id}` }, s.ref), h('div', { class: 'desc' }, s.description || 'No description')),
      h('button', { onclick: act(async () => { await api('POST', `/api/skills/${s.id}/install`); toast('Added to your machines'); }) }, 'Add to my machines')));
  }
  if (m.status === 'held') {
    const ta = h('textarea', { rows: 1, 'aria-label': 'Edit before sending' }); ta.value = m.text;
    const decide = (path, extra = {}) => act(async () => { await api('POST', `/api/messages/${m.id}/${path}`, { text: ta.value, ...extra }); });
    body.push(h('div', { class: 'held' },
      h('p', {}, `Your agent wants to send this${m.kind === 'chat' || m.kind === 'skill' ? '' : ` (${kinds[m.kind].toLowerCase()})`}. You can change it first.`),
      m.kind !== 'skill' && ta,
      h('div', { class: 'acts' }, h('button', { class: 'primary', onclick: decide('approve') }, 'Send'),
        h('button', { onclick: decide('approve', { always: true }) }, 'Send, and always allow this here'),
        h('button', { class: 'danger', onclick: decide('decline') }, 'Don’t send'))));
  } else if (m.text && m.kind !== 'skill') body.push(h('div', { class: 'text' }, m.text));
  if (m.status === 'declined') body.push(h('div', { class: 'only' }, 'Not sent. Only visible to you.'));
  const time = h('time', { datetime: new Date(m.created).toISOString() }, clock(m.created));
  return h('div', { class: `msg${head ? ' head' : ''}${m.status !== 'sent' ? ' off' : ''}`, 'data-id': m.id },
    head ? avatar(m.from, m.agent) : h('span', { class: 'gut' }, time),
    h('div', { class: 'body' },
      head && h('div', { class: 'who' }, h('strong', {}, m.agent ? `${nameOf(m.from) === 'You' ? 'Your' : `${m.from.name}’s`} agent` : nameOf(m.from)),
        m.agent && h('span', { class: 'tag bot', title: `Signed in as the key “${m.agent}”` }, 'Agent'),
        m.kind !== 'chat' && m.kind !== 'skill' && h('span', { class: 'tag' }, kinds[m.kind]), time),
      body));
}

function convoRow(c, open) {
  const other = c.kind === 'dm' && (c.members.find((x) => x.id !== me.user.id) || c.members[0]);
  return h('a', { class: `convo${c.id === open ? ' on' : ''}${c.unread || c.waiting ? ' unread' : ''}`, href: `/chat/${c.id}`, 'aria-current': c.id === open ? 'page' : null },
    other ? avatar(other, false, 'sm') : h('span', { class: 'hash', 'aria-hidden': 'true' }, '#'),
    h('span', { class: 'grow' }, c.name),
    c.waiting > 0 && h('span', { class: 'count wait', title: `${c.waiting} waiting for you` }, `${c.waiting} to send`),
    c.unread > 0 && c.id !== open && h('span', { class: 'count', 'aria-label': `${c.unread} unread` }, c.unread));
}

function newConvo(friends) {
  const err = h('div', { class: 'err' });
  return h('div', { class: 'newconvo' },
    h('h2', {}, 'Message a friend'),
    friends.length ? h('div', { class: 'people' }, friends.map((u) => h('button', { class: 'person', onclick: act(async () => { const r = await api('POST', '/api/convos', { with: u.handle }); go(`/chat/${r.convo.id}`); }) }, avatar(u, false, 'sm'), u.name)))
      : h('p', { class: 'muted' }, h('a', { href: '/friends' }, 'Add friends'), ' to message them, or start a group and share its link.'),
    h('h2', {}, 'Start a group'),
    h('form', { class: 'stack wide', onsubmit: act(async (e) => {
      const f = new FormData(e.target);
      try { const r = await api('POST', '/api/convos', { name: f.get('name'), people: f.getAll('people') }); go(`/chat/${r.convo.id}`); } catch (x) { err.textContent = x.message; }
    }) }, h('input', { name: 'name', placeholder: 'Group name, like launch-crew', 'aria-label': 'Group name', required: true }),
      friends.length > 0 && h('div', { class: 'picks' }, friends.map((u) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'people', value: u.handle }), u.name))),
      h('p', { class: 'muted small' }, 'Anyone with the group’s link can join. Agents come in only when their person turns them on.'),
      h('div', { class: 'acts' }, h('button', { class: 'primary' }, 'Start group')), err));
}

async function chatPage(id) {
  const [{ convos, kinds }, friends] = await Promise.all([api('GET', '/api/convos'), api('GET', '/api/friends')]);
  if (!id && convos.length && matchMedia('(min-width: 721px)').matches) return history.replaceState(null, '', `/chat/${convos[0].id}`), chatPage(convos[0].id);
  const list = h('nav', { class: 'convos', 'aria-label': 'Conversations' });
  const st = { id, kinds, list, msgs: new Map(), log: null };
  chatState = st;
  const section = (title, cs) => cs.length > 0 && [h('div', { class: 'sect' }, title), ...cs.map((c) => convoRow(c, id))];
  const drawList = (cs) => list.replaceChildren(...[section('Groups', cs.filter((c) => c.kind === 'group')), section('Direct messages', cs.filter((c) => c.kind !== 'group')),
    !cs.length && h('p', { class: 'empty' }, 'No conversations yet.')].flat().filter(Boolean));
  st.refreshList = async () => { const r = await api('GET', '/api/convos'); drawList(r.convos); setBadge(r.convos); };
  drawList(convos); setBadge(convos);
  const side = h('aside', { class: 'side' },
    h('div', { class: 'sidehead' }, h('h1', {}, 'Chat'), h('a', { class: 'compose', href: '/chat/new', 'aria-label': 'New conversation', title: 'New conversation' }, '+ New')),
    list, h('a', { class: 'sidefoot', href: '/chat/settings' }, 'What my agent may say'));
  if (!id || id === 'new') {
    fill(h('div', { class: `chat${id ? ' open' : ''}` }, side, h('section', { class: 'thread' },
      id ? [h('header', { class: 'thead' }, h('a', { class: 'back', href: '/chat' }, '‹ All chats'), h('h2', {}, 'New conversation')), h('div', { class: 'pane' }, newConvo(friends.friends))]
        : h('div', { class: 'pane center' }, h('p', { class: 'muted' }, 'Talk with friends and their agents.'), h('a', { class: 'btn primary', href: '/chat/new' }, 'Start a conversation')))));
    return;
  }
  const d = await api('GET', `/api/convos/${id}`);
  const c = d.convo;
  const log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  st.log = log;
  const near = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const draw = () => {
    const ms = [...st.msgs.values()].sort((a, b) => a.created - b.created);
    log.replaceChildren(...[h('div', { class: 'intro' },
      c.kind === 'group' ? h('span', { class: 'hash big', 'aria-hidden': 'true' }, '#') : avatar(c.members.find((x) => x.id !== me.user.id) || c.members[0], false, 'lg'),
      h('h3', {}, c.kind === 'group' ? `This is the start of #${c.name}` : `This is the start of your conversation with ${c.name}`),
      h('p', { class: 'muted' }, c.kind === 'group' ? 'Bring people in with the invite link. Their agents join only when they turn them on.' : 'Turn your agent in above to let it talk here, within what you allow.'),
      c.invite && copyBtn(c.invite, 'Copy invite link')),
    ...ms.flatMap((m, i) => [(!i || !sameDay(ms[i - 1].created, m.created)) && h('div', { class: 'day' }, h('span', {}, dayName(m.created))), msgNode(m, (i && sameDay(ms[i - 1].created, m.created)) ? ms[i - 1] : null, kinds)])].filter(Boolean));
  };
  st.upsert = (m, fresh) => {
    const stick = near() || m.from.id === me.user.id;
    const known = st.msgs.has(m.id);
    st.msgs.set(m.id, m); draw();
    if (stick) log.scrollTop = log.scrollHeight;
    if (fresh && !known) log.querySelector(`[data-id="${m.id}"]`)?.classList.add('arrive');
  };
  for (const m of d.messages) st.msgs.set(m.id, m);

  const roster = c.members.map((x) => `${nameOf(x)}${x.agent ? ' (agent in)' : ''}`).join(', ');
  const perms = h('div', { class: 'permpanel', hidden: true },
    h('p', {}, 'What your agent may do here. People are never limited; this is only about your agent.'),
    permTable(id, d.permissions, kinds),
    h('p', { class: 'muted small' }, '“Ask me” holds the message here until you send it. ', h('a', { href: '/chat/settings' }, 'Change the defaults for every conversation.')),
    c.kind === 'group' && h('button', { class: 'danger', onclick: act(async () => { if (!confirm(`Leave ${c.name}?`)) return; await api('DELETE', `/api/convos/${id}/members/me`); go('/chat'); }) }, 'Leave this group'));
  const nAgents = c.members.filter((x) => x.agent).length;
  const head = h('header', { class: 'thead' },
    h('div', { class: 'bar' },
      h('a', { class: 'back', href: '/chat', 'aria-label': 'All chats' }, '‹'),
      h('h2', { class: 'grow' }, c.kind === 'group' ? `# ${c.name}` : c.name),
      h('span', { class: 'faces', title: roster }, c.members.slice(0, 3).map((x) => avatar(x, false, 'xs')), h('span', {}, `${c.members.length}${nAgents ? ` + ${nAgents} ${nAgents === 1 ? 'agent' : 'agents'}` : ''}`)),
      h('button', { class: 'ghost', 'aria-expanded': 'false', onclick: (e) => { perms.hidden = !perms.hidden; e.currentTarget.setAttribute('aria-expanded', String(!perms.hidden)); } }, 'Permissions')),
    h('div', { class: 'bar sub' }, h('span', { class: 'muted small' }, 'My agent'),
      seg([[true, 'In'], [false, 'Out']], c.my_agent, async (v) => { await api('PATCH', `/api/convos/${id}`, { agent: v }); toast(v ? 'Your agent can talk here now' : 'Your agent left this conversation'); }, 'My agent in this conversation'),
      c.invite && copyBtn(c.invite, 'Invite')),
    perms);

  const send = async (body) => { const r = await api('POST', `/api/convos/${id}/messages`, body); st.upsert(r.message); st.refreshList(); };
  const box = askBox({ placeholder: `Message ${c.kind === 'group' ? '#' : ''}${c.name}`, sendLabel: 'Send', onsend: async (text) => { if (!text) return; const ta = box.querySelector('textarea'); ta.value = ''; try { await send({ text }); } catch (x) { ta.value = text; toast(x.message); } } });
  const share = h('button', { type: 'button', onclick: act(async () => {
    if (box.querySelector('select')) return box.querySelector('select').remove();
    const { skills } = await api('GET', '/api/skills');
    const pick = h('select', { 'aria-label': 'Skill to share', onchange: act(async () => { if (!pick.value) return; await send({ kind: 'skill', skill: pick.value, text: box.querySelector('textarea').value.trim() }); box.querySelector('textarea').value = ''; pick.remove(); }) },
      h('option', { value: '' }, 'Share a skill…'), skills.filter((s) => !s.builtin && ['public', 'friends'].includes(s.visibility)).map((s) => h('option', { value: s.id }, `${s.owner}/${s.name}`)));
    box.querySelector('.tools').before(pick); pick.focus();
  }) }, 'Share a skill');
  box.querySelector('.tools').prepend(share);

  fill(h('div', { class: 'chat open' }, side, h('section', { class: 'thread' }, head, log, h('div', { class: 'composer' }, box))));
  draw(); log.scrollTop = log.scrollHeight;
  if (matchMedia('(hover: hover)').matches) box.querySelector('textarea').focus({ preventScroll: true });
}

async function chatSettings() {
  const p = await api('GET', '/api/permissions');
  fill(h('a', { href: '/chat' }, 'All chats'), h('h1', {}, 'What my agent may say'),
    h('p', { class: 'lead' }, 'These are your defaults for every conversation. You can change them for one conversation from its Permissions button.'),
    h('div', { class: 'card' }, permTable(null, p.permissions, p.kinds)),
    h('p', { class: 'muted' }, 'Your agent labels each message with its kind. “Personal” covers anything about you: your calendar, contacts, files, places, money and health. Other people’s agents are never allowed to ask yours to run commands or reveal secrets; the built-in skill tells it so.'));
}

// The page an invite link opens: who is in the group, and one tap to join (or sign up and join).
async function invitePage() {
  const code = new URLSearchParams(location.search).get('code') || '';
  const g = await api('GET', `/api/convos/invite/${encodeURIComponent(code)}`);
  const names = g.faces.slice(0, 3).join(', ') + (g.people > 3 ? ` and ${g.people - 3} more` : '');
  fill(h('div', { class: 'invite card' }, h('h1', {}, `Join ${g.name}`),
    h('p', {}, `${names} ${g.people === 1 ? 'is' : 'are'} here${g.agents ? `, with ${g.agents} ${g.agents === 1 ? 'agent' : 'agents'}` : ''}.`),
    h('p', { class: 'muted' }, 'Rucksack is a place to share agent skills and talk with people and their agents. Your agent joins only if you turn it on, and you choose what it may say.'),
    me ? h('button', { class: 'primary', onclick: act(async () => { const r = await api('POST', '/api/convos/join', { code }); go(`/chat/${r.convo.id}`); }) }, 'Join the conversation')
      : h('a', { class: 'btn primary', href: `/signin?mode=signup&next=${encodeURIComponent(location.pathname + location.search)}` }, 'Sign up to join')));
}

// Unread chats on the Chat link, kept current by live events on every page.
function setBadge(convos) { if (me) { me.chat_unread = convos.reduce((n, c) => n + c.unread + c.waiting, 0); nav(); } }
let live = null;
function connectLive() {
  if (live || !me) return;
  live = new EventSource('/api/events');
  const onChat = async (e, kind) => {
    const d = JSON.parse(e.data), st = location.pathname.startsWith('/chat') ? chatState : null;
    if (st && kind === 'message' && d.convo === st.id && st.upsert) { st.upsert(d.message, true); await api('GET', `/api/convos/${st.id}?since=${Date.now()}`).catch(() => {}); }
    if (st) st.refreshList(); else setBadge((await api('GET', '/api/convos')).convos);
  };
  live.addEventListener('message', (e) => onChat(e, 'message'));
  live.addEventListener('convo', (e) => onChat(e, 'convo'));
}

// Signed-out pages: what it is and what it costs.
const plansP = fetch('/api/plans').then((r) => r.json()).catch(() => ({ team: '$8 per person a month', free_seats: 3 }));
function planCards(plans) {
  const card = (name, price, unit, items, cta, hot) => h('div', { class: `plan cut${hot ? ' hot' : ''}` }, h('h3', {}, name),
    h('p', { class: 'price' }, price, unit && h('span', {}, unit)), h('ul', {}, items.map((t) => h('li', {}, t))), cta);
  const [amount, ...per] = String(plans.team).split(' ');
  return h('div', { class: 'plans' },
    card('Free', '$0', null, ['Private skills, shared with friends or published', 'Sign in from Claude, Claude Code, Cursor, ChatGPT and more', `Organizations of up to ${plans.free_seats} people`],
      h('a', { class: 'key', href: '/signin?mode=signup' }, 'Start free')),
    card('Team', amount, per.join(' '), ['Everything in Free', 'Any number of people', 'Required skills pushed to every member', 'Roles: owner, admin, editor, member', 'Suggested changes with review'],
      h('a', { class: 'key key--primary', href: '/signin?mode=signup&next=/orgs' }, 'Start a team'), true),
    card('Enterprise', 'Talk to us', null, ['Everything in Team', 'Single sign-on', 'Central control over which agents reach which tools', 'Your own server, if you need it'],
      h('a', { class: 'key', href: 'mailto:lance@servantventures.com?subject=Rucksack%20Enterprise' }, 'Email us')));
}
async function landing() {
  const plans = await plansP;
  const page = document.getElementById('landing-page').content.cloneNode(true);
  page.querySelector('[data-plan-note]').textContent = `Free for up to ${plans.free_seats} people. Team is ${plans.team}.`;
  page.querySelector('[data-plans]').replaceWith(planCards(plans));
  fill(page);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
async function pricing() {
  fill(h('section', { class: 'pricing container page-top' }, h('div', { class: 'sec-head' }, h('h1', {}, 'Pricing'),
    h('p', { class: 'lead' }, 'Free for people and small groups. Pay per person when your team grows.')), planCards(await plansP),
    h('p', { class: 'fine' }, 'Team is billed monthly by card through Stripe. When someone joins or leaves, the next bill adjusts. Cancel any time from the billing page.')));
}

// Line diff (longest common subsequence), for reviewing changes. Removed lines are marked -, added +.
function diffView(a, b) {
  const x = a.split('\n'), y = b.split('\n'), n = x.length, m = y.length;
  if (n * m > 4e6) return h('pre', {}, b);
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && x[i] === y[j]) { out.push(['same', x[i]]); i++; j++; } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push(['add', y[j++]]); else out.push(['del', x[i++]]);
  }
  // Keep three lines of context around each change.
  const keep = out.map((_, k) => out.slice(Math.max(0, k - 3), k + 4).some(([t]) => t !== 'same'));
  return h('pre', { class: 'diff' }, out.map(([t, line], k) => (keep[k] ? h('span', { class: t }, `${t === 'add' ? '+' : t === 'del' ? '-' : ' '} ${line}\n`) : keep[k - 1] ? h('span', { class: 'gap' }, '…\n') : null)));
}

const LEVEL_HELP = { none: 'No access', read: 'Read only', ask: 'Read; changes wait for an admin', write: 'Read and change' };

// Shared services: the organization keeps an API key here; each person gets a level; agents call through Rucksack.
function serviceSection(slug, d, svc, requests) {
  const admin = ['owner', 'admin'].includes(d.org.role);
  if (!svc.enabled) return h('p', { class: 'muted' }, 'Shared services are not switched on for this server yet.');
  const decide = (x, how) => act(async () => { await api('POST', `/api/access-requests/${x.id}/${how}`); toast(how === 'approve' ? 'Approved and sent' : 'Rejected'); render(); });
  const waiting = requests.filter((x) => x.status === 'waiting');
  const levelPick = (c, p) => h('select', { 'aria-label': `Access for ${p.handle} to ${c.name}`, onchange: act(async (e) => {
    await api('PUT', `/api/orgs/${slug}/connections/${c.name}/access`, { user: p.id, level: e.target.value === 'default' ? null : e.target.value }); toast('Saved'); }) },
  h('option', { value: 'default', selected: !p.set }, `Default (${LEVEL_HELP[c.default_level].toLowerCase()})`),
  svc.levels.map((l) => h('option', { value: l, selected: p.set && p.level === l }, LEVEL_HELP[l])));
  const adder = () => {
    const f = { name: h('input', { placeholder: 'Name, like stripe', 'aria-label': 'Name' }), base_url: h('input', { placeholder: 'https://api.stripe.com/v1', 'aria-label': 'Base address' }),
      auth_header: h('input', { placeholder: 'Authorization', 'aria-label': 'Header the key goes in' }), secret: h('input', { type: 'password', placeholder: 'Bearer sk_live_…', 'aria-label': 'Key', autocomplete: 'off' }),
      description: h('input', { placeholder: 'What it is for (agents read this)', 'aria-label': 'Description' }) };
    const lvl = h('select', { 'aria-label': 'Default access' }, svc.levels.map((l) => h('option', { value: l }, `Everyone: ${LEVEL_HELP[l].toLowerCase()}`)));
    const err = h('div', { class: 'err' });
    return h('details', { class: 'card' }, h('summary', {}, 'Add a service'), h('div', { class: 'stack-gap' }, Object.values(f), lvl,
      h('p', { class: 'muted' }, 'The key is stored encrypted and never shown again, to you or to any agent.'),
      h('button', { class: 'primary', onclick: act(async () => {
        try { await api('POST', `/api/orgs/${slug}/connections`, { ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim() || undefined])), default_level: lvl.value }); toast('Added'); render(); }
        catch (x) { err.textContent = x.message; }
      }) }, 'Add service'), err));
  };
  return [
    h('p', { class: 'muted' }, 'Keys for the tools your team uses stay here. Agents call them through Rucksack with the access each person has, and every call is logged.'),
    admin && waiting.length > 0 && h('div', { class: 'list' }, waiting.map((x) => h('div', { class: 'card notice row' },
      h('div', { class: 'grow' }, h('strong', {}, `@${x.by}${x.agent ? '’s agent' : ''} wants to ${x.method} ${x.connection}${x.path ? `/${x.path.replace(/^\//, '')}` : ''}`),
        x.reason && h('div', {}, x.reason), x.body && h('details', {}, h('summary', {}, 'Body'), h('pre', {}, x.body))),
      h('button', { class: 'primary', onclick: decide(x, 'approve') }, 'Approve'), h('button', { onclick: decide(x, 'reject') }, 'Reject')))),
    h('div', { class: 'list' }, svc.connections.length ? svc.connections.map((c) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', {}, c.name), ` ${c.description}`, h('div', { class: 'muted' }, `${c.base_url}. You: ${LEVEL_HELP[c.my_level].toLowerCase()}.`)),
        admin && h('button', { class: 'danger', onclick: act(async () => { if (!confirm(`Remove ${c.name}? Agents lose it at once.`)) return; await api('DELETE', `/api/orgs/${slug}/connections/${c.name}`); render(); }) }, 'Remove')),
      admin && h('details', {}, h('summary', {}, 'Who may use it'), h('table', {}, c.people.map((p) => h('tr', {}, h('td', {}, p.name, ' ', h('span', { class: 'muted' }, `@${p.handle}`)), h('td', {}, levelPick(c, p)))))))) : h('p', { class: 'muted' }, 'No services yet.')),
    admin && adder(),
    requests.length > 0 && h('details', {}, h('summary', {}, admin ? 'Recent calls' : 'Your recent calls'), h('table', {}, requests.slice(0, 30).map((x) => h('tr', {},
      h('td', {}, when(x.created)), h('td', {}, `@${x.by}${x.agent ? ' (agent)' : ''}`), h('td', {}, h('code', {}, `${x.method} ${x.connection}/${x.path.replace(/^\//, '')}`)),
      h('td', {}, x.status === 'done' ? `${x.http}` : x.status))))),
  ];
}

const pages = {
  async signin() {
    const next = new URLSearchParams(location.search).get('next') || '/';
    let mode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin';
    const err = h('div', { class: 'err' });
    const draw = () => {
      const up = mode === 'signup';
      const form = h('form', { class: 'stack', onsubmit: act(async (e) => {
        const f = Object.fromEntries(new FormData(e.target));
        try { await api('POST', up ? '/api/signup' : '/api/login', f); } catch (x) { err.textContent = x.message; return; }
        me = await api('GET', '/api/me'); go(next);
      }) },
        up && [h('label', { for: 'f-name' }, 'Name'), h('input', { id: 'f-name', name: 'name', autocomplete: 'name' }),
          h('label', { for: 'f-handle' }, 'Handle (how friends find you)'), h('input', { id: 'f-handle', name: 'handle', required: true, pattern: '[a-z0-9][a-z0-9\\-]*', autocapitalize: 'none' })],
        h('label', { for: 'f-email' }, 'Email'), h('input', { id: 'f-email', name: 'email', type: 'email', required: true, autocomplete: 'email' }),
        h('label', { for: 'f-pw' }, 'Password'), h('input', { id: 'f-pw', name: 'password', type: 'password', required: true, minlength: 8, autocomplete: up ? 'new-password' : 'current-password' }),
        h('button', { class: 'primary' }, up ? 'Create account' : 'Sign in'), err);
      fill(
        h('h1', {}, up ? 'Create your Rucksack account' : 'Sign in to Rucksack'),
        h('p', { class: 'lead' }, 'Share agent skills with friends and your organization. They sync to Claude Code, Pi, Codex and other agents on every machine you use.'),
        form,
        h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = up ? 'signin' : 'signup'; draw(); } }, up ? 'I already have an account' : 'Create an account')),
      );
    };
    draw();
  },

  async home() {
    const [{ skills }, mine, { proposals }] = await Promise.all([api('GET', '/api/manifest'), api('GET', '/api/skills'), api('GET', '/api/proposals')]);
    const own = mine.skills.filter((s) => s.owner === me.user.handle);
    const mineIds = new Set(skills.map((m) => m.id));
    const review = proposals.filter((p) => p.can_approve);
    fill(
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'My skills'), h('a', { class: 'btn primary', href: '/new' }, 'New skill')),
      h('p', { class: 'lead' }, 'Everything here is kept in sync on each machine and cloud run you connect.'),
      review.length > 0 && h('div', { class: 'card notice' }, h('strong', {}, `${review.length} suggested ${review.length === 1 ? 'change' : 'changes'} to review: `),
        review.map((p, i) => [i ? ', ' : '', h('a', { href: `/s/${p.skill_id}#suggestions` }, p.skill)])),
      h('div', { class: 'list' }, mine.skills.filter((s) => mineIds.has(s.id)).map((s) => skillRow(s)),
        mineIds.size <= 1 && h('p', { class: 'muted' }, 'Nothing yet. Add skills from Browse, or make a new one.')),
      h('p', { class: 'muted' }, 'Every machine also gets the Rucksack guide skill, so you can ask your agent things like “which skills does Acme require?” or “suggest a fix to acme/handbook”.'),
      skills.length <= 1 && h('p', {}, h('a', { href: '/connect' }, 'Connect your first agent')),
      own.length > 0 && [h('h2', {}, 'Published by you'), h('div', { class: 'list' }, own.map((s) => skillRow(s)))],
    );
  },

  async new() {
    const err = h('div', { class: 'err' });
    const places = [['', 'Me'], ...me.orgs.filter((o) => o.role !== 'member').map((o) => [o.slug, o.name])];
    const md = editor('---\nname: my-skill\ndescription: Use when ...\n---\n\n# My skill\n\nSteps the agent should follow.\n', 'SKILL.md');
    fill(h('h1', {}, 'New skill'),
      h('p', { class: 'lead' }, 'Write the SKILL.md here, or publish a folder with scripts from your terminal: skillnet push ./my-skill.'),
      h('form', { class: 'stack wide', onsubmit: act(async (e) => {
        const f = Object.fromEntries(new FormData(e.target));
        try {
          const r = await api('POST', '/api/skills/push', { files: { 'SKILL.md': b64(md.value) }, org: f.org || undefined, visibility: f.org ? 'org' : f.visibility, note: 'first version' });
          toast('Published'); go(`/s/${r.skill.id}`);
        } catch (x) { err.textContent = x.message; }
      }) },
        h('label', { for: 'n-org' }, 'Belongs to'), h('select', { id: 'n-org', name: 'org' }, places.map(([v, l]) => h('option', { value: v }, l))),
        h('label', { for: 'n-vis' }, 'Who can see it (personal skills)'), h('select', { id: 'n-vis', name: 'visibility' }, ['private', 'friends', 'public'].map((v) => h('option', { value: v }, VIS_LABEL[v]))),
        h('label', {}, 'SKILL.md (the name line becomes the skill name)'), md,
        h('button', { class: 'primary' }, 'Publish'), err));
  },

  async browse() {
    const q = new URLSearchParams(location.search).get('q') || '';
    const list = h('div', { class: 'list' });
    const load = async () => {
      const { skills } = await api('GET', `/api/skills?q=${encodeURIComponent(q)}`);
      list.replaceChildren(...(skills.length ? skills.map((s) => skillRow(s, { onChange: load })) : [h('p', { class: 'muted' }, 'No skills match.')]));
    };
    fill(h('h1', {}, 'Browse'),
      h('p', { class: 'lead' }, 'Skills you can see: your own, your friends’, your organizations’ and public ones.'),
      askBox({ placeholder: 'Search skills', value: q, onsend: (v) => go(`/browse${v ? `?q=${encodeURIComponent(v)}` : ''}`) }), list);
    await load();
  },

  async skill(id) {
    const [d, { proposals }] = await Promise.all([api('GET', `/api/skills/${id}`), api('GET', `/api/proposals?skill=${id}`)]);
    const s = d.skill, isOrg = s.owner_kind === 'org';
    const patch = (body) => act(async () => { await api('PATCH', `/api/skills/${s.id}`, body); toast('Saved'); render(); });
    // Edit or suggest: same box. Editors save a new version; everyone else sends a suggestion to the editors.
    const box = h('div', { hidden: true, class: 'card stack-gap' });
    const openBox = act(async () => {
      const { files } = await api('GET', `/api/skills/${s.id}/bundle`);
      const md = editor(unb64(files['SKILL.md']), 'SKILL.md'), note = h('input', { placeholder: s.can_edit ? 'What changed (optional)' : 'Why (helps the editor decide)', 'aria-label': 'Note' });
      const err = h('div', { class: 'err' });
      box.replaceChildren(h('label', {}, 'SKILL.md'), md, note, h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: act(async () => {
          const next = { ...files, 'SKILL.md': b64(md.value) };
          try {
            if (s.can_edit) {
              const r = await api('POST', '/api/skills/push', { org: isOrg ? s.owner : undefined, name: s.name, files: next, note: note.value });
              toast(r.proposal ? `Sent for review: it needs ${r.proposal.needs} approval${r.proposal.needs > 1 ? 's' : ''} from another editor` : 'Saved; machines update in seconds');
            }
            else { await api('POST', `/api/skills/${s.id}/proposals`, { files: next, note: note.value }); toast('Sent to the editors'); }
            render();
          } catch (x) { err.textContent = x.message; }
        }) }, s.can_edit ? 'Save new version' : 'Send suggestion'),
        h('button', { onclick: () => { box.hidden = true; } }, 'Cancel')), err);
      box.hidden = false; md.focus();
    });
    fill(
      h('h1', {}, `${s.owner}/${s.name}`),
      h('p', { class: 'lead' }, s.description || 'No description'),
      h('div', { class: 'row' }, h('span', { class: 'muted grow' }, `Version ${s.version}, updated ${when(s.updated)}`),
        s.required && h('span', { class: 'tag req' }, 'Required for the organization'),
        h('button', { onclick: openBox }, s.can_edit ? 'Edit' : 'Suggest a change'), installButton(s)),
      box,
      s.version === 0 && h('p', { class: 'card notice' }, 'Not published yet: this new skill reaches people once its change request below is approved.'),
      proposals.length > 0 && [h('h2', { id: 'suggestions' }, 'Changes waiting for review'), h('div', { class: 'list' }, proposals.map((p) => h('div', { class: 'card' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', {}, `@${p.author}`), ` ${p.note || '(no note)'}`,
          h('div', { class: 'muted' }, [`${when(p.created)}${p.branch ? `, from git branch ${p.branch}` : ''}. Changes ${p.changed.join(', ')}. `,
            `Approved by ${p.approvals.length ? p.approvals.map((x) => `@${x}`).join(', ') : 'nobody yet'} (${p.approvals.length} of ${p.needs} needed).`,
            p.base_version !== s.version && !p.conflicts.length ? ` Started from version ${p.base_version}; the newer changes are kept.` : '']),
          p.conflicts.length > 0 && h('div', { class: 'err' }, `Version ${s.version} also changed ${p.conflicts.join(', ')}. @${p.author} needs to update this request before it can merge.`)),
          p.can_approve && !p.conflicts.length && h('button', { class: 'primary', onclick: act(async () => {
            const r = await api('POST', `/api/proposals/${p.id}/approve`);
            toast(r.merged ? 'Approved and published; machines update in seconds' : `Approved; ${r.needs - r.approvals} more needed`); render();
          }) }, 'Approve'),
          (p.can_close) && h('button', { onclick: act(async () => { await api('POST', `/api/proposals/${p.id}/decline`); render(); }) }, p.mine ? 'Withdraw' : 'Decline')),
        h('details', {}, h('summary', {}, 'What changed in SKILL.md'), diffView(p.base_md, p.skill_md)))))],
      s.can_manage && h('div', { class: 'card', style: 'margin-top:16px' },
        h('label', {}, 'Who can see it'),
        h('div', { class: 'seg' }, (isOrg ? ['org', 'public'] : ['private', 'friends', 'public']).map((v) =>
          h('button', { class: v === s.visibility ? 'on' : null, onclick: patch({ visibility: v }) }, VIS_LABEL[v]))),
        isOrg && [h('label', {}, 'For organization members'), h('div', { class: 'seg' },
          h('button', { class: s.required ? 'on' : null, onclick: patch({ required: true }) }, 'Required on every machine'),
          h('button', { class: s.required ? null : 'on', onclick: patch({ required: false }) }, 'Optional'))],
        h('p', {}, h('button', { class: 'danger', onclick: act(async () => {
          if (!confirm(`Delete ${s.owner}/${s.name}? It is removed from every machine that has it.`)) return;
          await api('DELETE', `/api/skills/${s.id}`); toast('Deleted'); go('/');
        }) }, 'Delete skill'))),
      h('h2', {}, 'SKILL.md'), h('pre', {}, d.skill_md),
      h('h2', {}, 'Files'),
      h('table', {}, h('tr', {}, h('th', {}, 'Path'), h('th', {}, 'Size')), d.files.map((f) => h('tr', {}, h('td', {}, h('code', {}, f.path)), h('td', {}, `${f.size.toLocaleString()} bytes`)))),
      h('h2', {}, 'Versions'),
      h('table', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'By'), h('th', {}, 'When'), h('th', {}, 'Note'), s.can_edit && h('th', {}, '')),
        d.versions.map((v) => h('tr', {}, h('td', {}, v.version), h('td', {}, `@${v.author}`), h('td', {}, when(v.created)), h('td', {}, v.note),
          s.can_edit && h('td', {}, v.version !== s.version && h('button', { onclick: act(async () => {
            await api('POST', `/api/skills/${s.id}/rollback`, { version: v.version }); toast(`Back to version ${v.version}`); render();
          }) }, 'Roll back to this'))))),
    );
    if (location.hash === '#suggestions') document.getElementById('suggestions')?.scrollIntoView();
  },

  async friends() {
    const d = await api('GET', '/api/friends');
    const err = h('div', { class: 'err' });
    const person = (u, ...btns) => h('div', { class: 'card row' }, h('div', { class: 'grow' }, h('strong', {}, u.name), ' ', h('span', { class: 'muted' }, `@${u.handle}`)), ...btns);
    const remove = (u, label) => h('button', { onclick: act(async () => { await api('DELETE', `/api/friends/${u.id}`); render(); }) }, label);
    fill(
      h('h1', {}, 'Friends'),
      h('p', { class: 'lead' }, 'Friends can see and add the skills you share with “Friends”.'),
      h('form', { class: 'inline', onsubmit: act(async (e) => {
        const who = new FormData(e.target).get('who');
        try { const r = await api('POST', '/api/friends', { who }); toast(r.status === 'accepted' ? `You and @${r.user.handle} are friends` : `Request sent to @${r.user.handle}`); render(); }
        catch (x) { err.textContent = x.message; }
      }) }, h('input', { name: 'who', placeholder: 'Handle or email', 'aria-label': 'Handle or email', required: true, autocapitalize: 'none' }), h('button', { class: 'primary' }, 'Add friend')),
      err,
      d.incoming.length > 0 && [h('h2', {}, 'Requests'), h('div', { class: 'list' }, d.incoming.map((u) => person(u,
        h('button', { class: 'primary', onclick: act(async () => { await api('POST', '/api/friends', { who: u.handle }); render(); }) }, 'Accept'), remove(u, 'Decline'))))],
      h('h2', {}, 'Your friends'),
      h('div', { class: 'list' }, d.friends.length ? d.friends.map((u) => person(u, remove(u, 'Remove'))) : h('p', { class: 'muted' }, 'No friends yet.')),
      d.outgoing.length > 0 && [h('h2', {}, 'Waiting for them'), h('div', { class: 'list' }, d.outgoing.map((u) => person(u, remove(u, 'Cancel'))))],
    );
  },

  async orgs() {
    me = await api('GET', '/api/me');
    const err = h('div', { class: 'err' });
    fill(
      h('h1', {}, 'Organizations'),
      h('p', { class: 'lead' }, 'Admins publish skills for the whole organization. Required ones land on every member’s machines automatically.'),
      h('div', { class: 'list' }, me.orgs.length ? me.orgs.map((o) => h('div', { class: 'card row' }, h('a', { class: 'grow', href: `/o/${o.slug}` }, o.name), h('span', { class: 'tag' }, o.role))) : h('p', { class: 'muted' }, 'You are not in any organization yet.')),
      h('h2', {}, 'Start an organization'),
      h('form', { class: 'stack', onsubmit: act(async (e) => {
        try { const { org } = await api('POST', '/api/orgs', Object.fromEntries(new FormData(e.target))); go(`/o/${org.slug}`); } catch (x) { err.textContent = x.message; }
      }) }, h('label', { for: 'o-name' }, 'Name'), h('input', { id: 'o-name', name: 'name', required: true }),
        h('label', { for: 'o-slug' }, 'Short id (used in commands, like --org acme)'), h('input', { id: 'o-slug', name: 'slug', required: true, pattern: '[a-z0-9][a-z0-9\\-]*', autocapitalize: 'none' }),
        h('button', { class: 'primary' }, 'Create'), err),
    );
  },

  async org(slug) {
    const [d, svc, { requests }] = await Promise.all([api('GET', `/api/orgs/${slug}`), api('GET', `/api/orgs/${slug}/connections`),
      api('GET', `/api/orgs/${slug}/access-log`)]);
    const services = serviceSection(slug, d, svc, requests);
    const o = d.org, admin = ['owner', 'admin'].includes(o.role), owner = o.role === 'owner';
    if (new URLSearchParams(location.search).get('billing') === 'done') { history.replaceState(null, '', location.pathname); toast('Thanks. Your team plan starts as soon as Stripe confirms.'); }
    const openBilling = (kind) => act(async () => { location.href = (await api('POST', `/api/orgs/${slug}/billing/${kind}`)).url; });
    const team = o.plan === 'team';
    const plan = o.billing && h('div', { class: 'card row plan-bar' },
      h('div', { class: 'grow' }, h('strong', {}, team ? 'Team plan' : 'Free plan'),
        h('div', { class: 'muted' }, team ? `${d.members.length} ${d.members.length === 1 ? 'person' : 'people'}, ${o.price || 'billed per person'}. The bill follows the number of people.`
          : `${d.members.length} of ${o.free_seats} people. Upgrade to Team${o.price ? ` (${o.price})` : ''} for more.`)),
      o.can_bill && h('button', { class: team ? null : 'primary', onclick: openBilling(team ? 'portal' : 'checkout') }, team ? 'Manage billing' : 'Upgrade to Team'));
    fill(
      h('h1', {}, o.name),
      h('p', { class: 'lead' }, `You are ${o.role === 'owner' ? 'the owner' : `${o.role === 'admin' || o.role === 'editor' ? 'an' : 'a'} ${o.role}`}: ${ROLE_HELP[o.role].toLowerCase()}.`),
      admin && h('div', { class: 'card' }, h('label', {}, 'Invite link (anyone with it can join)'),
        h('div', { class: 'row' }, h('code', { class: 'grow' }, o.invite),
          h('button', { onclick: act(async () => { await navigator.clipboard.writeText(o.invite); toast('Copied'); }) }, 'Copy'),
          h('button', { onclick: act(async () => { await api('POST', `/api/orgs/${slug}/invite`); toast('Old link no longer works'); render(); }) }, 'New link'))),
      plan,
      h('h2', {}, 'Skills'),
      h('div', { class: 'list' }, d.skills.length ? d.skills.map((s) => skillRow(s)) : h('p', { class: 'muted' }, 'No skills yet.')),
      h('h2', {}, 'Changes and history'),
      h('div', { class: 'card stack-gap' },
        h('label', {}, 'Before a change reaches everyone'),
        admin ? h('div', { class: 'seg' }, [[0, 'Editors publish directly'], [1, '1 other editor approves'], [2, '2 approve']].map(([n, t]) =>
          h('button', { class: o.review === n ? 'on' : null, onclick: act(async () => { await api('POST', `/api/orgs/${slug}/settings`, { review: n }); toast('Saved'); render(); }) }, t)))
          : h('p', {}, o.review ? `${o.review} other editor${o.review > 1 ? 's' : ''} approve${o.review > 1 ? '' : 's'} every change.` : 'Editors publish directly; members suggest changes.'),
        h('p', { class: 'muted' }, o.review ? 'Editors and members send change requests; editors and admins approve them here, on each skill page, or by asking their agent.'
          : 'Members send change requests; an editor or admin approves them.'),
        o.git && [h('label', {}, 'Git repository (one folder per skill; every version is a commit)'), snippet(`git clone ${o.git}`),
          h('p', { class: 'muted' }, ['Sign in with your handle and an API key from ', h('a', { href: '/devices' }, 'Keys and devices'), ' as the password. ',
            o.review || !['owner', 'admin', 'editor'].includes(o.role) ? 'Push a branch (git push origin HEAD:my-change): each skill it changes becomes a change request.'
              : 'Editors push to main to publish; anyone can push a branch to ask for review.'])]),
      h('h2', {}, 'Shared services'),
      services,
      h('h2', {}, 'Members'),
      h('p', { class: 'muted' }, Object.entries(ROLE_HELP).map(([r, t]) => `${r[0].toUpperCase() + r.slice(1)}: ${t.toLowerCase()}.`).join(' ')),
      h('table', {}, d.members.map((m) => h('tr', {},
        h('td', {}, m.name, ' ', h('span', { class: 'muted' }, `@${m.handle}`)),
        h('td', {}, owner ? h('select', { 'aria-label': `Role for ${m.handle}`, onchange: act(async (e) => { await api('POST', `/api/orgs/${slug}/members/${m.id}`, { role: e.target.value }); toast('Role saved'); }) },
          Object.keys(ROLE_HELP).map((r) => h('option', { value: r, selected: r === m.role }, r))) : m.role),
        h('td', {}, (admin || m.id === me.user.id) && h('button', { class: 'danger', onclick: act(async () => {
          await api('DELETE', `/api/orgs/${slug}/members/${m.id}`);
          if (m.id === me.user.id) go('/orgs'); else render();
        }) }, m.id === me.user.id ? 'Leave' : 'Remove'))))),
    );
  },

  async devices() {
    const { tokens } = await api('GET', '/api/tokens');
    const keys = tokens.filter((t) => t.kind === 'key'), apps = tokens.filter((t) => t.kind === 'connector'), machines = tokens.filter((t) => t.kind === 'cli');
    const row = (t, sub) => h('div', { class: 'card row' },
      h('div', { class: 'grow' }, h('strong', {}, t.label), h('div', { class: 'muted' }, `${sub}Added ${when(t.created)}, last used ${when(t.used)}`)),
      h('button', { class: 'danger', onclick: act(async () => { if (!confirm(`Revoke ${t.label}? Anything using it stops syncing.`)) return; await api('DELETE', `/api/tokens/${t.id}`); render(); }) }, 'Revoke'));
    fill(h('h1', {}, 'Keys and devices'),
      h('h2', {}, 'Connected apps'),
      h('div', { class: 'list' }, apps.length ? apps.map((t) => row(t, `${t.scope === 'write' ? 'Read and write' : 'Read only'}. `)) : h('p', { class: 'muted' }, 'None yet. See Connect.')),
      h('h2', {}, 'API keys'),
      h('p', { class: 'muted' }, 'Only for scripts and cloud jobs with no one there to sign in: put one in a secret named SKILLNET_KEY. Read keys sync and search; write keys can also publish.'),
      keyMaker(() => render()),
      h('div', { class: 'list' }, keys.length ? keys.map((t) => row(t, `${t.scope === 'write' ? 'Read and write' : 'Read only'}. `)) : h('p', { class: 'muted' }, 'No keys yet.')),
      machines.length && h('h2', {}, 'Signed-in machines'),
      machines.length && h('div', { class: 'list' }, machines.map((t) => row(t, ''))));
  },

  // Where people run agents. Apps connect by address and a browser sign-in; only scripts with no browser need a key.
  async connect() {
    const origin = location.origin, url = `${origin}/mcp`;
    let key = sessionStorage.getItem('sn-new-key') || '';
    const pull = () => `curl -fsSL -H "Authorization: Bearer $SKILLNET_KEY" ${origin}/api/pull.sh | sh`;
    const steps = (...items) => h('ol', { class: 'steps' }, items.map((x) => h('li', {}, x)));
    const signIn = 'Sign in to Rucksack in the window that opens and choose Allow.';
    const PLACES = {
      claude: ['Claude', () => [
        steps('In Claude (desktop app, claude.ai or the phone app) open Settings, then Connectors, then Add custom connector.',
          ['Name it Rucksack and paste this address:', snippet(url)], `Choose Connect. ${signIn}`),
        h('p', {}, 'On a Team or Enterprise plan an owner can add it once for everyone in Organization settings, Connectors. It also reaches Claude Code cloud sessions. For Claude Code on your own computer, use the Claude Code tab: skills arrive as files there.')]],
      code: ['Claude Code', () => [
        h('p', {}, 'Run these two lines once in a terminal:'),
        snippet(`claude plugin marketplace add ${origin}/plugin.git\nclaude plugin install rucksack@rucksack`),
        steps('Start a new Claude Code session. It shows a link and a code: open the link and approve this computer.',
          'Your skills arrive in ~/.claude/skills within seconds and stay current as they change, with no restart. They work offline too.',
          `For search, chat and shared services, type /mcp, choose rucksack, then Authenticate. ${signIn}`)]],
      local: ['Codex, Pi and other coding agents', () => [
        h('p', {}, 'Run this once in a terminal. It signs this computer in and keeps your skills as files in each agent’s skill folder that exists here (Codex, Pi, Cursor, Gemini and ~/.agents/skills):'),
        snippet(`curl -fsSL ${origin}/install.sh | sh`),
        h('p', {}, 'Pi reloads skills by itself when they change. Codex and the others pick changes up in their next session.')]],
      cursor: ['Cursor', () => [
        h('p', {}, h('a', { class: 'btn primary', href: `cursor://anysphere.cursor-deeplink/mcp/install?name=rucksack&config=${btoa(JSON.stringify({ url }))}` }, 'Add to Cursor')),
        h('p', {}, `Then choose Connect next to Rucksack in Cursor's MCP settings. ${signIn} Or add it by hand in Settings, MCP, with this address:`), snippet(url)]],
      vscode: ['VS Code', () => [
        h('p', {}, h('a', { class: 'btn primary', href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'rucksack', type: 'http', url }))}` }, 'Add to VS Code')),
        h('p', {}, `Then start the server when VS Code asks. ${signIn}`)]],
      chatgpt: ['ChatGPT', () => [
        steps('In ChatGPT open Settings, then Apps and Connectors, then Create (turn on developer mode under Advanced if you do not see it).',
          ['Name it Rucksack, paste this address and choose OAuth:', snippet(url)], signIn)]],
      other: ['Other apps', () => [
        h('p', {}, `Any app that takes a remote MCP server: add one with this address. No key or header is needed; ${signIn.toLowerCase()}`), snippet(url),
        h('p', {}, 'For apps that take a config file:'), snippet(JSON.stringify({ mcpServers: { rucksack: { url } } }, null, 2))]],
      scripts: ['Scripts and cloud jobs', () => [
        h('p', {}, 'Only for jobs with no one there to sign in, like CI. Make a key, store it as a secret named SKILLNET_KEY, and this line writes your skills into the agent folders:'),
        key ? h('p', { class: 'card notice' }, 'Your new key: ', h('code', {}, key), ' ', copyBtn(key), h('br'), 'Copy it now; it is not shown again.')
          : keyMaker((k) => { key = k; sessionStorage.setItem('sn-new-key', k); draw(); }, 'Cloud job'),
        snippet(pull()),
        h('p', {}, 'Or call the API with the key as a bearer token:'), snippet(`curl -H "Authorization: Bearer $SKILLNET_KEY" "${origin}/api/skills?q=deploy"`)]],
    };
    let place = new URLSearchParams(location.search).get('for');
    // Coding agents on a computer get files; phones get the connector.
    if (!PLACES[place]) place = /iPhone|iPad|Android/.test(navigator.userAgent) ? 'claude' : 'code';
    const body = h('div', { class: 'stack-gap' });
    const tabs = h('div', { class: 'seg wrap', role: 'tablist' });
    const draw = () => {
      tabs.replaceChildren(...Object.entries(PLACES).map(([k, [label]]) => h('button', { role: 'tab', 'aria-selected': String(k === place), class: k === place ? 'on' : null,
        onclick: () => { place = k; history.replaceState(null, '', `/connect?for=${k}`); draw(); } }, label)));
      body.replaceChildren(...PLACES[place][1]().filter(Boolean));
    };
    fill(h('h1', {}, 'Connect an agent'),
      h('p', { class: 'lead' }, 'Coding agents on your computer get your skills as real files, kept current as they change. Chat apps and phones connect by address and sign in.'),
      tabs, body);
    draw();
  },

  async device() {
    const code = new URLSearchParams(location.search).get('code') || '';
    const msg = h('div', { class: 'err' });
    fill(h('h1', {}, 'Sign in a machine'),
      h('p', {}, 'Check that this code matches the one in your terminal.'),
      h('form', { class: 'stack', onsubmit: act(async (e) => {
        try { const r = await api('POST', '/api/device/approve', { user_code: new FormData(e.target).get('code') }); fill(h('h1', {}, 'Approved'), h('p', {}, `${r.label} is signed in. You can close this tab.`)); }
        catch (x) { msg.textContent = x.message; }
      }) }, h('label', { for: 'd-code' }, 'Code'), h('input', { id: 'd-code', name: 'code', value: code, required: true, autocapitalize: 'characters' }), h('button', { class: 'primary' }, 'Approve'), msg));
  },

  // The OAuth consent screen an app opens when someone adds Rucksack as a connector.
  async authorize() {
    const q = new URLSearchParams(location.search);
    const p = Object.fromEntries(['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state'].map((k) => [k, q.get(k)]));
    const scopes = (q.get('scope') || '').split(/\s+/);
    const scope = scopes.includes('read') && !scopes.includes('write') ? 'read' : 'write';
    const c = await api('GET', `/api/oauth/client?client_id=${encodeURIComponent(p.client_id || '')}&redirect_uri=${encodeURIComponent(p.redirect_uri || '')}`);
    const send = (allow) => act(async () => { location.href = (await api('POST', '/api/oauth/approve', { ...p, scope, allow })).redirect; });
    fill(h('h1', {}, `Connect ${c.name}`),
      h('p', { class: 'lead' }, `${c.name} wants to use Rucksack as @${me.user.handle}. It will be able to:`),
      h('ul', {}, h('li', {}, 'Read your skills, your friends\' and your organizations\''), scope === 'write' && h('li', {}, 'Publish skills and suggest changes in your name')),
      h('p', { class: 'muted' }, `You go back to ${c.host} after this. Disconnect it any time on the Keys page.`),
      h('div', { class: 'inline' }, h('button', { class: 'primary', onclick: send(true) }, 'Allow'), h('button', { onclick: send(false) }, 'Cancel')));
  },

  async join() {
    const code = new URLSearchParams(location.search).get('code') || '';
    const { org } = await api('POST', '/api/join', { code });
    toast(`You joined ${org.name}`); go(`/o/${org.slug}`);
  },
};

async function render() {
  const p = location.pathname;
  $main.classList.add('loading');
  try {
    if (!me) me = await api('GET', '/api/me').catch(() => null);
    nav();
    $main.classList.toggle('wide', p.startsWith('/chat'));
    document.body.classList.toggle('site', (!me && p === '/') || p === '/pricing');
    document.documentElement.style.setProperty('--toph', `${document.querySelector('.top').offsetHeight}px`);
    if (p !== '/chat' && !p.startsWith('/chat/')) chatState = null;
    if (p === '/c') { connectLive(); return await invitePage(); }
    if (!me && p === '/') return await landing();
    if (p === '/pricing') return await pricing();
    if (!me) { if (p !== '/signin') history.replaceState(null, '', `/signin?next=${encodeURIComponent(p + location.search)}`); await pages.signin(); return; }
    if (p === '/signin') return go(new URLSearchParams(location.search).get('next') || '/');
    connectLive();
    const m = p.match(/^\/s\/([\w-]+)$/), o = p.match(/^\/o\/([\w-]+)$/), ch = p.match(/^\/chat(?:\/([\w-]+))?$/);
    if (p === '/oauth/authorize') await pages.authorize();
    else if (p === '/chat/settings') await chatSettings();
    else if (ch) await chatPage(ch[1]);
    else if (m) await pages.skill(m[1]);
    else if (o) await pages.org(o[1]);
    else await (pages[p.slice(1) || 'home'] || pages.home)();
  } catch (e) {
    fill(h('h1', {}, 'Something went wrong'), h('p', { class: 'err' }, e.message));
  } finally { $main.classList.remove('loading'); }
}
render();
