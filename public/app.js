// Skillnet web app: plain DOM, no build step.
const $main = document.getElementById('main');
let me = null;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
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

function nav() {
  const links = me ? [['/', 'My skills'], ['/browse', 'Browse'], ['/friends', 'Friends'], ['/orgs', 'Organizations'], ['/devices', 'Devices']] : [];
  const path = location.pathname;
  document.getElementById('nav').replaceChildren(
    ...links.map(([href, label]) => h('a', { href, class: (href === '/' ? path === '/' : path.startsWith(href)) ? 'on' : null }, label)),
    me && h('a', { href: '#', onclick: act(async () => { await api('POST', '/api/logout'); me = null; go('/'); }) }, `Sign out @${me.user.handle}`),
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
function askBox({ placeholder, value = '', onsend }) {
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
    h('button', { type: 'button', class: 'send', 'aria-label': 'Search', onclick: () => onsend(ta.value.trim()) }, '→')));
}

const pages = {
  async signin() {
    const next = new URLSearchParams(location.search).get('next') || '/';
    let mode = 'signin';
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
      $main.replaceChildren(
        h('h1', {}, up ? 'Create your Skillnet account' : 'Sign in to Skillnet'),
        h('p', { class: 'lead' }, 'Share agent skills with friends and your organization. They sync to Claude Code, Pi, Codex and other agents on every machine you use.'),
        form,
        h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = up ? 'signin' : 'signup'; draw(); } }, up ? 'I already have an account' : 'Create an account')),
      );
    };
    draw();
  },

  async home() {
    const [{ skills }, mine] = await Promise.all([api('GET', '/api/manifest'), api('GET', '/api/skills')]);
    const own = mine.skills.filter((s) => s.owner === me.user.handle);
    const origin = location.origin;
    $main.replaceChildren(
      h('h1', {}, 'My skills'),
      h('p', { class: 'lead' }, 'Everything here is kept in sync on each machine you set up.'),
      h('div', { class: 'list' }, skills.length ? mine.skills.filter((s) => skills.some((m) => m.id === s.id)).map((s) => skillRow(s)) : h('p', { class: 'muted' }, 'Nothing yet. Add skills from Browse, or publish your own.')),
      h('h2', {}, 'Set up a machine'),
      h('p', {}, 'Run this in a terminal (needs Node 22 or newer). It signs the machine in, syncs your skills into each agent, and keeps them updated in the background.'),
      h('pre', {}, `curl -fsSL ${origin}/install.sh | sh`),
      h('h2', {}, 'Publish a skill'),
      h('p', {}, 'From the skill folder (the one with SKILL.md):'),
      h('pre', {}, `skillnet push . --visibility friends\nskillnet push . --org your-org --required   # push to everyone in an organization`),
      own.length > 0 && [h('h2', {}, 'Published by you'), h('div', { class: 'list' }, own.map((s) => skillRow(s)))],
    );
  },

  async browse() {
    const q = new URLSearchParams(location.search).get('q') || '';
    const list = h('div', { class: 'list' });
    const load = async () => {
      const { skills } = await api('GET', `/api/skills?q=${encodeURIComponent(q)}`);
      list.replaceChildren(...(skills.length ? skills.map((s) => skillRow(s, { onChange: load })) : [h('p', { class: 'muted' }, 'No skills match.')]));
    };
    $main.replaceChildren(h('h1', {}, 'Browse'),
      h('p', { class: 'lead' }, 'Skills you can see: your own, your friends’, your organizations’ and public ones.'),
      askBox({ placeholder: 'Search skills', value: q, onsend: (v) => go(`/browse${v ? `?q=${encodeURIComponent(v)}` : ''}`) }), list);
    await load();
  },

  async skill(id) {
    const d = await api('GET', `/api/skills/${id}`);
    const s = d.skill, isOrg = s.owner_kind === 'org';
    const patch = (body) => act(async () => { await api('PATCH', `/api/skills/${s.id}`, body); toast('Saved'); render(); });
    $main.replaceChildren(
      h('h1', {}, `${s.owner}/${s.name}`),
      h('p', { class: 'lead' }, s.description || 'No description'),
      h('div', { class: 'row' }, h('span', { class: 'muted grow' }, `Version ${s.version} · updated ${when(s.updated)}`), installButton(s),
        s.required && h('span', { class: 'tag req' }, 'Required for everyone in the organization')),
      s.can_edit && h('div', { class: 'card', style: 'margin-top:16px' },
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
  },

  async friends() {
    const d = await api('GET', '/api/friends');
    const err = h('div', { class: 'err' });
    const person = (u, ...btns) => h('div', { class: 'card row' }, h('div', { class: 'grow' }, h('strong', {}, u.name), ' ', h('span', { class: 'muted' }, `@${u.handle}`)), ...btns);
    const remove = (u, label) => h('button', { onclick: act(async () => { await api('DELETE', `/api/friends/${u.id}`); render(); }) }, label);
    $main.replaceChildren(
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
    $main.replaceChildren(
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
    const d = await api('GET', `/api/orgs/${slug}`);
    const o = d.org, admin = ['owner', 'admin'].includes(o.role), owner = o.role === 'owner';
    $main.replaceChildren(
      h('h1', {}, o.name),
      h('p', { class: 'lead' }, `You are ${o.role === 'admin' ? 'an admin' : `the ${o.role}`.replace('the member', 'a member')}. Publish with `, h('code', {}, `skillnet push . --org ${o.slug} --required`), '.'),
      admin && h('div', { class: 'card' }, h('label', {}, 'Invite link (anyone with it can join)'),
        h('div', { class: 'row' }, h('code', { class: 'grow' }, o.invite),
          h('button', { onclick: act(async () => { await navigator.clipboard.writeText(o.invite); toast('Copied'); }) }, 'Copy'),
          h('button', { onclick: act(async () => { await api('POST', `/api/orgs/${slug}/invite`); toast('Old link no longer works'); render(); }) }, 'New link'))),
      h('h2', {}, 'Skills'),
      h('div', { class: 'list' }, d.skills.length ? d.skills.map((s) => skillRow(s)) : h('p', { class: 'muted' }, 'No skills yet.')),
      h('h2', {}, 'Members'),
      h('table', {}, d.members.map((m) => h('tr', {},
        h('td', {}, m.name, ' ', h('span', { class: 'muted' }, `@${m.handle}`)),
        h('td', {}, owner ? h('select', { 'aria-label': `Role for ${m.handle}`, onchange: act(async (e) => { await api('POST', `/api/orgs/${slug}/members/${m.id}`, { role: e.target.value }); toast('Role saved'); }) },
          ['owner', 'admin', 'member'].map((r) => h('option', { value: r, selected: r === m.role }, r))) : m.role),
        h('td', {}, (admin || m.id === me.user.id) && h('button', { class: 'danger', onclick: act(async () => {
          await api('DELETE', `/api/orgs/${slug}/members/${m.id}`);
          if (m.id === me.user.id) go('/orgs'); else render();
        }) }, m.id === me.user.id ? 'Leave' : 'Remove'))))),
    );
  },

  async devices() {
    const { tokens } = await api('GET', '/api/tokens');
    $main.replaceChildren(h('h1', {}, 'Devices'),
      h('p', { class: 'lead' }, 'Machines signed in with the skillnet command. Sign one out and it stops syncing.'),
      h('div', { class: 'list' }, tokens.length ? tokens.map((t) => h('div', { class: 'card row' },
        h('div', { class: 'grow' }, h('strong', {}, t.label), h('div', { class: 'muted' }, `Added ${when(t.created)} · last seen ${when(t.used)}`)),
        h('button', { class: 'danger', onclick: act(async () => { await api('DELETE', `/api/tokens/${t.id}`); render(); }) }, 'Sign out'))) : h('p', { class: 'muted' }, 'No machines yet.')));
  },

  async device() {
    const code = new URLSearchParams(location.search).get('code') || '';
    const msg = h('div', { class: 'err' });
    $main.replaceChildren(h('h1', {}, 'Sign in a machine'),
      h('p', {}, 'Check that this code matches the one in your terminal.'),
      h('form', { class: 'stack', onsubmit: act(async (e) => {
        try { const r = await api('POST', '/api/device/approve', { user_code: new FormData(e.target).get('code') }); $main.replaceChildren(h('h1', {}, 'Approved'), h('p', {}, `${r.label} is signed in. You can close this tab.`)); }
        catch (x) { msg.textContent = x.message; }
      }) }, h('label', { for: 'd-code' }, 'Code'), h('input', { id: 'd-code', name: 'code', value: code, required: true, autocapitalize: 'characters' }), h('button', { class: 'primary' }, 'Approve'), msg));
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
    if (!me) { if (p !== '/signin') history.replaceState(null, '', `/signin?next=${encodeURIComponent(p + location.search)}`); await pages.signin(); return; }
    if (p === '/signin') return go(new URLSearchParams(location.search).get('next') || '/');
    const m = p.match(/^\/s\/([\w-]+)$/), o = p.match(/^\/o\/([\w-]+)$/);
    if (m) await pages.skill(m[1]);
    else if (o) await pages.org(o[1]);
    else await (pages[p.slice(1) || 'home'] || pages.home)();
  } catch (e) {
    $main.replaceChildren(h('h1', {}, 'Something went wrong'), h('p', { class: 'err' }, e.message));
  } finally { $main.classList.remove('loading'); }
}
render();
