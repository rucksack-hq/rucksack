// Skillnet web app: plain DOM, no build step.
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
  const links = me ? [['/', 'My skills'], ['/browse', 'Browse'], ['/connect', 'Connect'], ['/friends', 'Friends'], ['/orgs', 'Organizations'], ['/devices', 'Keys']] : [];
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
      fill(
        h('h1', {}, up ? 'Create your Skillnet account' : 'Sign in to Skillnet'),
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
      h('p', { class: 'muted' }, 'Every machine also gets the skillnet skill, so you can ask your agent things like “which skills does Acme require?” or “suggest a fix to acme/handbook”.'),
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
            if (s.can_edit) { await api('POST', '/api/skills/push', { org: isOrg ? s.owner : undefined, name: s.name, files: next, note: note.value }); toast('Saved; machines update in seconds'); }
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
      proposals.length > 0 && [h('h2', { id: 'suggestions' }, 'Suggested changes'), h('div', { class: 'list' }, proposals.map((p) => h('div', { class: 'card' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', {}, `@${p.author}`), ` ${p.note || '(no note)'}`,
          h('div', { class: 'muted' }, `${when(p.created)}, based on version ${p.base_version}${p.base_version !== s.version ? `; it is now version ${s.version}, so approving replaces the newer changes` : ''}`)),
          p.can_approve && h('button', { class: 'primary', onclick: act(async () => { await api('POST', `/api/proposals/${p.id}/approve`); toast('Approved; machines update in seconds'); render(); }) }, 'Approve'),
          h('button', { onclick: act(async () => { await api('POST', `/api/proposals/${p.id}/decline`); render(); }) }, p.can_approve ? 'Decline' : 'Withdraw')),
        h('details', {}, h('summary', {}, 'Proposed SKILL.md'), h('pre', {}, p.skill_md)))))],
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
    const d = await api('GET', `/api/orgs/${slug}`);
    const o = d.org, admin = ['owner', 'admin'].includes(o.role), owner = o.role === 'owner';
    fill(
      h('h1', {}, o.name),
      h('p', { class: 'lead' }, `You are ${o.role === 'owner' ? 'the owner' : `${o.role === 'admin' || o.role === 'editor' ? 'an' : 'a'} ${o.role}`}: ${ROLE_HELP[o.role].toLowerCase()}.`),
      admin && h('div', { class: 'card' }, h('label', {}, 'Invite link (anyone with it can join)'),
        h('div', { class: 'row' }, h('code', { class: 'grow' }, o.invite),
          h('button', { onclick: act(async () => { await navigator.clipboard.writeText(o.invite); toast('Copied'); }) }, 'Copy'),
          h('button', { onclick: act(async () => { await api('POST', `/api/orgs/${slug}/invite`); toast('Old link no longer works'); render(); }) }, 'New link'))),
      h('h2', {}, 'Skills'),
      h('div', { class: 'list' }, d.skills.length ? d.skills.map((s) => skillRow(s)) : h('p', { class: 'muted' }, 'No skills yet.')),
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
    const signIn = 'Sign in to Skillnet in the window that opens and choose Allow.';
    const PLACES = {
      claude: ['Claude', () => [
        steps('In Claude (desktop app, claude.ai or the phone app) open Settings, then Connectors, then Add custom connector.',
          ['Name it Skillnet and paste this address:', snippet(url)], `Choose Connect. ${signIn}`),
        h('p', {}, 'That covers Claude Code too, including cloud sessions. On a Team or Enterprise plan an owner can add it once for everyone in Organization settings, Connectors. If Claude Code asks, type /mcp and choose Skillnet to sign in.')]],
      cursor: ['Cursor', () => [
        h('p', {}, h('a', { class: 'btn primary', href: `cursor://anysphere.cursor-deeplink/mcp/install?name=skillnet&config=${btoa(JSON.stringify({ url }))}` }, 'Add to Cursor')),
        h('p', {}, `Then choose Connect next to Skillnet in Cursor's MCP settings. ${signIn} Or add it by hand in Settings, MCP, with this address:`), snippet(url)]],
      vscode: ['VS Code', () => [
        h('p', {}, h('a', { class: 'btn primary', href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'skillnet', type: 'http', url }))}` }, 'Add to VS Code')),
        h('p', {}, `Then start the server when VS Code asks. ${signIn}`)]],
      chatgpt: ['ChatGPT', () => [
        steps('In ChatGPT open Settings, then Apps and Connectors, then Create (turn on developer mode under Advanced if you do not see it).',
          ['Name it Skillnet, paste this address and choose OAuth:', snippet(url)], signIn)]],
      other: ['Codex, Grok and others', () => [
        h('p', {}, `Any app that takes a remote MCP server: add one with this address. No key or header is needed; ${signIn.toLowerCase()}`), snippet(url),
        h('p', {}, 'For apps that take a config file:'), snippet(JSON.stringify({ mcpServers: { skillnet: { url } } }, null, 2))]],
      scripts: ['Scripts and cloud jobs', () => [
        h('p', {}, 'Only for jobs with no one there to sign in, like CI. Make a key, store it as a secret named SKILLNET_KEY, and this line writes your skills into the agent folders:'),
        key ? h('p', { class: 'card notice' }, 'Your new key: ', h('code', {}, key), ' ', copyBtn(key), h('br'), 'Copy it now; it is not shown again.')
          : keyMaker((k) => { key = k; sessionStorage.setItem('sn-new-key', k); draw(); }, 'Cloud job'),
        snippet(pull()),
        h('p', {}, 'Or call the API with the key as a bearer token:'), snippet(`curl -H "Authorization: Bearer $SKILLNET_KEY" "${origin}/api/skills?q=deploy"`)]],
    };
    let place = new URLSearchParams(location.search).get('for');
    if (!PLACES[place]) place = 'claude';
    const body = h('div', { class: 'stack-gap' });
    const tabs = h('div', { class: 'seg wrap', role: 'tablist' });
    const draw = () => {
      tabs.replaceChildren(...Object.entries(PLACES).map(([k, [label]]) => h('button', { role: 'tab', 'aria-selected': String(k === place), class: k === place ? 'on' : null,
        onclick: () => { place = k; history.replaceState(null, '', `/connect?for=${k}`); draw(); } }, label)));
      body.replaceChildren(...PLACES[place][1]().filter(Boolean));
    };
    fill(h('h1', {}, 'Connect an agent'),
      h('p', { class: 'lead' }, 'Add Skillnet to your app by its address and sign in. Your agent then sees your skills at the start of every session, and updates show up without reinstalling anything.'),
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

  // The OAuth consent screen an app opens when someone adds Skillnet as a connector.
  async authorize() {
    const q = new URLSearchParams(location.search);
    const p = Object.fromEntries(['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state'].map((k) => [k, q.get(k)]));
    const scopes = (q.get('scope') || '').split(/\s+/);
    const scope = scopes.includes('read') && !scopes.includes('write') ? 'read' : 'write';
    const c = await api('GET', `/api/oauth/client?client_id=${encodeURIComponent(p.client_id || '')}&redirect_uri=${encodeURIComponent(p.redirect_uri || '')}`);
    const send = (allow) => act(async () => { location.href = (await api('POST', '/api/oauth/approve', { ...p, scope, allow })).redirect; });
    fill(h('h1', {}, `Connect ${c.name}`),
      h('p', { class: 'lead' }, `${c.name} wants to use Skillnet as @${me.user.handle}. It will be able to:`),
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
    if (!me) { if (p !== '/signin') history.replaceState(null, '', `/signin?next=${encodeURIComponent(p + location.search)}`); await pages.signin(); return; }
    if (p === '/signin') return go(new URLSearchParams(location.search).get('next') || '/');
    const m = p.match(/^\/s\/([\w-]+)$/), o = p.match(/^\/o\/([\w-]+)$/);
    if (p === '/oauth/authorize') await pages.authorize();
    else if (m) await pages.skill(m[1]);
    else if (o) await pages.org(o[1]);
    else await (pages[p.slice(1) || 'home'] || pages.home)();
  } catch (e) {
    fill(h('h1', {}, 'Something went wrong'), h('p', { class: 'err' }, e.message));
  } finally { $main.classList.remove('loading'); }
}
render();
