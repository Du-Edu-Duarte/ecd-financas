// ECD Auth v2 — login com e-mail e senha, cadastro complementar e aprovação do dono.
// Módulo compartilhado pelos sistemas da ECD Tecnologia (mesmo login em todos).
//
// Fluxo: Criar conta (nome, e-mail, senha) → Completar cadastro (setor, WhatsApp, campos extras)
// → Aguardando aprovação (pedido vai para o e-mail do dono) → dono aprova e envia o link de liberação
// → a pessoa abre o link no mesmo aparelho e entra.
// O link de liberação é assinado com Ed25519: só quem tem a chave de aprovação do dono consegue gerar.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = (n = 8) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const initials = n => (n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';
const fmtD = t => t ? new Date(t).toLocaleDateString('pt-BR') : '';
const fmtDT = t => t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').toLowerCase().slice(0, 30);
const digits = s => String(s || '').replace(/\D/g, '');
function toast(msg) { let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2800); }

const LS = {
  get(k, d) { try { const v = localStorage.getItem('ecd-auth-' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ecd-auth-' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ecd-auth-' + k); } catch {} },
};

/* ---------- constantes do dono ---------- */
export const OWNER_EMAIL = 'eduardoduartecostaduarte@gmail.com';
const OWNER_WHATS = '5511934969956';
// Chave pública de aprovação (Ed25519). A frase secreta que gera a chave privada fica só com o dono.
const APPROVAL_PUB = 'Rlx2yWoqXtPdUZibBNB-sFBUWaWHwqtkmKuuEJK71Wk';
const NOTIFY_URL = `https://formsubmit.co/ajax/${OWNER_EMAIL}`;
export const DEMO_EMAIL = 'demo@ecdtecnologia.com.br';

const defaultConfig = () => ({
  empresa: 'ECD Tecnologia', dominio: '', demo: true,
  setores: ['Administrativo', 'Comercial', 'Financeiro', 'Marketing e Conteúdo', 'Operações', 'Pessoal / uso próprio', 'TI'],
  extras: [],
});
export const getConfig = () => ({ ...defaultConfig(), ...(LS.get('config', null) || {}) });
const OWNER = () => ({ id: 'owner', nome: 'Eduardo Costa Duarte', email: OWNER_EMAIL, setor: 'Administrativo', extras: {}, role: 'admin', owner: true, status: 'ativo', createdAt: Date.now() });
const statusOf = u => u.blocked ? 'bloqueado' : (u.status || 'ativo');
export const getUsers = () => {
  let u = LS.get('users', null);
  if (!u) u = [{ id: 'demo', nome: 'Usuário Demonstração', email: DEMO_EMAIL, setor: 'Administrativo', extras: {}, role: 'admin', status: 'ativo', demo: true, createdAt: Date.now() }];
  let o = u.find(x => x.email === OWNER_EMAIL);
  if (!o) { u.unshift(OWNER()); LS.set('users', u); }
  else if (!o.owner || o.role !== 'admin' || o.blocked || o.status !== 'ativo') { Object.assign(o, { owner: true, role: 'admin', blocked: false, status: 'ativo' }); LS.set('users', u); }
  else if (!LS.get('users', null)) LS.set('users', u);
  return u;
};
const saveUser = u => { const all = getUsers(); const i = all.findIndex(x => x.id === u.id); if (i >= 0) all[i] = u; else all.push(u); LS.set('users', all); };
const sessionUser = () => { const s = LS.get('session', null); if (!s || Date.now() - s.at > 7 * 864e5) return null; return getUsers().find(u => u.id === s.userId) || null; };
// me() = usuário com acesso liberado (o app só usa este)
export const me = () => { const u = sessionUser(); return u && statusOf(u) === 'ativo' ? u : null; };
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
function login(u) { LS.set('session', { userId: u.id, at: Date.now() }); paintUser(); }

/* ---------- criptografia ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const enc = s => new TextEncoder().encode(s);
const packJSON = o => b64u(enc(JSON.stringify(o)));
const unpackJSON = s => { try { return JSON.parse(new TextDecoder().decode(unb64u(s))); } catch { return null; } };
async function hashPass(pass, salt) {
  const k = await crypto.subtle.importKey('raw', enc(pass), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(salt), iterations: 150000 }, k, 256));
}
async function setPassword(u, pass) { u.salt = b64u(crypto.getRandomValues(new Uint8Array(16))); u.hash = await hashPass(pass, u.salt); }
const checkPassword = async (u, pass) => !!u.hash && (await hashPass(pass, u.salt)) === u.hash;
const normPhrase = p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{5})(?=.)/g, '$1-');
async function keyFromPhrase(phrase) {
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', enc('ECD-APROVACAO|' + normPhrase(phrase))));
  const pk = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pk, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return { key, ok: jwk.x === APPROVAL_PUB };
}
const approvalMsg = d => `ECD-APROVA|${d.id}|${d.email}|${d.at}|${d.role || 'user'}`;
async function verifyApproval(d, sig) {
  try {
    const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: APPROVAL_PUB }, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, pub, unb64u(sig), enc(approvalMsg(d)));
  } catch { return false; }
}

let APP = { name: 'ECD', tagline: '', bullets: [], home: '#/' };
const baseURL = () => `${location.origin}${location.pathname}`;
// Tema preto e branco (vale para todos os sistemas ECD neste navegador)
export const isPB = () => LS.get('theme', 'cor') === 'pb';
export function applyTheme() { document.documentElement.dataset.theme = isPB() ? 'pb' : 'cor'; document.dispatchEvent(new Event('ecd-theme')); }
export function toggleTheme() { LS.set('theme', isPB() ? 'cor' : 'pb'); applyTheme(); paintUser(); }
applyTheme();
window.__ecdTheme = () => { toggleTheme(); location.reload(); };
export function configureAuth(opts) { APP = { ...APP, ...opts }; }

export function paintUser() {
  const u = me(); const nav = $('.top nav'); if (!nav) return;
  $('#userBox')?.remove();
  nav.style.display = u ? '' : 'none';
  if (!u) return;
  const box = document.createElement('div'); box.id = 'userBox'; box.className = 'userbox';
  box.innerHTML = `<button class="uchip" id="uBtn"><span class="av" style="background:#c8952e;border-color:#2a2213">${initials(u.nome)}</span><span class="un">${esc(u.nome.split(' ')[0])}</span></button>
    <div class="umenu" hidden><div class="uhead"><b>${esc(u.nome)}</b><span>${esc(u.email)}</span><span>${esc(u.setor || '')}${u.owner ? ' · Dono (acesso total)' : u.role === 'admin' ? ' · Administrador' : ''}</span></div>${u.role === 'admin' && !u.demo ? '<a href="#/config">⚙️ Usuários e aprovações</a>' : ''}${(APP.links || []).map(l => `<a href="${l.href}">${l.text}</a>`).join('')}<button id="themeBtn">◐ Preto e branco: ${isPB() ? 'ligado' : 'desligado'}</button><button id="logout">Sair</button></div>`;
  nav.appendChild(box);
  const m = $('.umenu', box); $('#uBtn').onclick = e => { e.stopPropagation(); m.hidden = !m.hidden; if (!m.hidden) document.addEventListener('click', () => m.hidden = true, { once: true }); };
  $('#logout').onclick = () => { LS.del('session'); paintUser(); location.hash = '#/entrar'; };
  $('#themeBtn').onclick = e => { e.stopPropagation(); toggleTheme(); toast(isPB() ? 'Preto e branco ligado' : 'Cores ligadas'); };
}
const steps = n => `<div class="asteps">${['Conta', 'Cadastro', 'Aprovação'].map((s, i) => `<span class="${i < n ? 'done' : i === n ? 'now' : ''}"><b>${i < n ? '✓' : i + 1}</b>${s}</span>`).join('<i></i>')}</div>`;
const shell = inner => `<div class="auth"><div class="auth-side"><img src="logo.jpg" alt=""><h2>${esc(APP.tagline)}</h2><ul>${APP.bullets.map(b => `<li>${esc(b)}</li>`).join('')}<li>Acesso liberado pela ECD Tecnologia</li></ul><small>${esc(APP.name)} · ECD Tecnologia · <button class="link" style="color:inherit" onclick="window.__ecdTheme()">◐ ${isPB() ? 'Cores' : 'Preto e branco'}</button></small></div><div class="auth-main card">${inner}</div></div>`;
const view = () => $('#view');
const passField = (name, label, ac = 'current-password') => `<label class="f">${label}<span class="pw"><input name="${name}" type="password" autocomplete="${ac}" required minlength="${ac === 'new-password' ? 8 : 1}"><button type="button" class="link sm" data-eye>mostrar</button></span></label>`;
const wireEyes = () => $$('[data-eye]').forEach(b => b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? 'mostrar' : 'ocultar'; });
const goNext = () => { const n = LS.get('next', null); LS.del('next'); location.hash = n || APP.home; };
function routeFor(u) { const s = statusOf(u); return s === 'ativo' ? null : s === 'perfil' ? '#/perfil' : s === 'pendente' ? '#/aguardando' : '#/entrar'; }

/* ---------- Entrar ---------- */
export function Entrar(msg = '') {
  const cfg = getConfig();
  view().innerHTML = shell(`
    <div class="eyebrow">Entrar</div><h1>Acesse sua conta</h1><p class="mut" style="margin:6px 0 22px">Use o e-mail e a senha do seu cadastro.</p>
    ${msg ? `<div class="tip" style="margin-bottom:14px">${msg}</div>` : ''}
    <form id="fl" class="grid"><label class="f">E-mail<input name="email" type="email" autocomplete="email" placeholder="voce@email.com" required></label>
      ${passField('senha', 'Senha')}
      <div id="err" class="sm" style="color:var(--bad)"></div>
      <button class="btn primary">Entrar</button></form>
    <div class="row between sm" style="margin-top:16px"><a href="#/cadastro"><b>Criar conta</b></a><a href="#/esqueci">Esqueci a senha</a></div>
    ${cfg.demo ? `<div class="or"><span>ou</span></div><button class="btn" id="demo" style="width:100%">Ver a demonstração (dados fictícios)</button>` : ''}`);
  wireEyes();
  $('#fl').onsubmit = async e => {
    e.preventDefault(); const f = e.target; const email = normEmail(f.email.value); const err = t => $('#err').innerHTML = t;
    const u = getUsers().find(x => x.email === email && !x.demo);
    if (!u) return err(`Não encontramos <b>${esc(email)}</b>. <a href="#/cadastro?email=${encodeURIComponent(email)}"><b>Criar conta</b></a>`);
    if (statusOf(u) === 'bloqueado') return err('Seu acesso está bloqueado. Fale com a ECD Tecnologia.');
    if (!u.hash) { LS.set('setpass', u.id); location.hash = '#/nova-senha'; return; }
    f.querySelector('button.primary').disabled = true;
    if (!(await checkPassword(u, f.senha.value))) { f.querySelector('button.primary').disabled = false; return err('E-mail ou senha incorretos.'); }
    login(u); const r = routeFor(u); if (r) location.hash = r; else { goNext(); setTimeout(() => toast(`Olá, ${u.nome.split(' ')[0]}!`), 300); }
  };
  const d = $('#demo'); if (d) d.onclick = () => {
    if (window.__ecdHasRealData?.()) return toast('Este aparelho já tem dados reais: a demonstração fica indisponível aqui.');
    login(getUsers().find(u => u.demo) || getUsers()[0]); location.hash = APP.home;
  };
}

/* ---------- Criar conta ---------- */
export function Cadastro() {
  const pre = new URLSearchParams(location.hash.split('?')[1] || '').get('email') || '';
  view().innerHTML = shell(`
    ${steps(0)}<div class="eyebrow">Criar conta</div><h1>Seu acesso</h1><p class="mut" style="margin:6px 0 22px">Crie seu login. Depois você completa o cadastro e a ECD libera o acesso.</p>
    <form id="fc" class="grid">
      <label class="f">Nome completo *<input name="nome" autocomplete="name" required></label>
      <label class="f">E-mail *<input name="email" type="email" autocomplete="email" value="${esc(pre)}" placeholder="voce@email.com" required></label>
      <div class="form2">${passField('senha', 'Senha * (mín. 8)', 'new-password')}${passField('senha2', 'Repita a senha *', 'new-password')}</div>
      <div class="pwbar"><i></i></div>
      <label class="row sm" style="gap:8px;align-items:flex-start"><input type="checkbox" required style="margin-top:3px"> Concordo com o uso dos meus dados para acesso ao sistema e registro das minhas ações (LGPD).</label>
      <div id="err" class="sm" style="color:var(--bad)"></div>
      <button class="btn primary">Criar conta</button></form>
    <p class="sm" style="margin:18px 0 0">Já tem conta? <a href="#/entrar"><b>Entrar</b></a></p>`);
  wireEyes();
  const bar = $('.pwbar i'); $('#fc').senha.oninput = e => { const v = e.target.value; const sc = (v.length >= 8) + (v.length >= 12) + /[A-Z]/.test(v) + /\d/.test(v) + /[^\w]/.test(v); bar.style.width = sc * 20 + '%'; bar.style.background = sc < 2 ? 'var(--bad)' : sc < 4 ? 'var(--gold)' : 'var(--ok, #2e8b57)'; };
  $('#fc').onsubmit = async e => {
    e.preventDefault(); const f = e.target; const email = normEmail(f.email.value); const err = t => $('#err').innerHTML = t;
    if (!validEmail(email)) return err('Confira o e-mail.');
    if (f.senha.value.length < 8) return err('A senha precisa ter pelo menos 8 caracteres.');
    if (f.senha.value !== f.senha2.value) return err('As senhas não conferem.');
    if (email === OWNER_EMAIL) return err('Este e-mail é do administrador. Use "Entrar".');
    if (getUsers().some(u => u.email === email)) return err('Este e-mail já tem cadastro. <a href="#/entrar"><b>Entrar</b></a>');
    const u = { id: rid(10), nome: f.nome.value.trim(), email, role: 'user', status: 'perfil', extras: {}, createdAt: Date.now() };
    await setPassword(u, f.senha.value); saveUser(u); login(u); location.hash = '#/perfil';
  };
}

/* ---------- Senha nova (conta antiga sem senha, dono no 1º acesso, ou esqueci) ---------- */
export function NovaSenha() {
  const id = LS.get('setpass', null); const u = getUsers().find(x => x.id === id); if (!u) { location.hash = '#/entrar'; return; }
  const dono = !!u.owner;
  view().innerHTML = shell(`
    <div class="eyebrow">${dono ? 'Primeiro acesso do administrador' : 'Nova senha'}</div><h1>Crie sua senha</h1>
    <p class="mut" style="margin:6px 0 22px">${dono ? 'Para provar que é você, informe também a <b>chave de aprovação</b> da ECD. Ela fica guardada neste aparelho e serve para liberar novos cadastros.' : `Conta: <b>${esc(u.email)}</b>. Depois de criar a senha, a ECD precisa aprovar o acesso de novo.`}</p>
    <form id="fn" class="grid">${dono ? `<label class="f">Chave de aprovação<input name="frase" autocomplete="off" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required style="font:700 15px 'DejaVu Sans Mono',monospace;text-transform:uppercase"></label>` : ''}
      <div class="form2">${passField('senha', 'Senha (mín. 8)', 'new-password')}${passField('senha2', 'Repita a senha', 'new-password')}</div>
      <div id="err" class="sm" style="color:var(--bad)"></div><button class="btn primary">Salvar senha</button></form>
    <p class="sm" style="margin:18px 0 0"><a href="#/entrar">← Voltar</a></p>`);
  wireEyes();
  $('#fn').onsubmit = async e => {
    e.preventDefault(); const f = e.target; const err = t => $('#err').innerHTML = t;
    if (f.senha.value.length < 8) return err('A senha precisa ter pelo menos 8 caracteres.');
    if (f.senha.value !== f.senha2.value) return err('As senhas não conferem.');
    if (dono) { const k = await keyFromPhrase(f.frase.value).catch(() => ({ ok: false })); if (!k.ok) return err('Chave de aprovação incorreta.'); LS.set('owner-phrase', normPhrase(f.frase.value)); }
    await setPassword(u, f.senha.value);
    if (!dono && statusOf(u) === 'ativo') { u.status = u.setor ? 'pendente' : 'perfil'; u.requestedAt = 0; }
    saveUser(u); LS.del('setpass'); login(u);
    const r = routeFor(u); if (r) location.hash = r; else { goNext(); setTimeout(() => toast('Senha criada. Bem-vindo!'), 300); }
  };
}
export function Esqueci() {
  view().innerHTML = shell(`
    <div class="eyebrow">Esqueci a senha</div><h1>Redefinir senha</h1><p class="mut" style="margin:6px 0 22px">Por segurança, depois de trocar a senha a ECD precisa liberar seu acesso de novo. Você recebe o link pelo WhatsApp.</p>
    <form id="fe" class="grid"><label class="f">E-mail do cadastro<input name="email" type="email" required></label><div id="err" class="sm" style="color:var(--bad)"></div><button class="btn primary">Continuar</button></form>
    <p class="sm" style="margin:18px 0 0"><a href="#/entrar">← Voltar</a></p>`);
  $('#fe').onsubmit = e => {
    e.preventDefault(); const email = normEmail(e.target.email.value); const u = getUsers().find(x => x.email === email && !x.demo);
    if (!u) return $('#err').textContent = 'Não há cadastro com este e-mail neste aparelho.';
    LS.set('setpass', u.id); location.hash = '#/nova-senha';
  };
}

/* ---------- Completar cadastro ---------- */
function extraInput(f, v = '') {
  const req = f.required ? 'required' : '';
  if (f.type === 'select') return `<label class="f">${esc(f.label)}${f.required ? ' *' : ''}<select name="x_${f.id}" ${req}><option value="">Selecione</option>${(f.options || []).map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  const t = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'phone' ? 'tel' : 'text';
  return `<label class="f">${esc(f.label)}${f.required ? ' *' : ''}<input name="x_${f.id}" type="${t}" value="${esc(v)}" ${req} ${f.type === 'cpf' ? 'inputmode="numeric" placeholder="000.000.000-00"' : ''}></label>`;
}
const maskPhone = i => i.oninput = () => { const d = digits(i.value).slice(0, 11); i.value = d.length > 6 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d; };
export function Perfil() {
  const u = sessionUser(); if (!u) { location.hash = '#/entrar'; return; }
  const cfg = getConfig();
  view().innerHTML = shell(`
    ${steps(1)}<div class="eyebrow">Completar cadastro</div><h1>Quase lá, ${esc(u.nome.split(' ')[0])}</h1><p class="mut" style="margin:6px 0 22px">Mais alguns dados para a ECD liberar seu acesso.</p>
    <form id="fp" class="grid">
      <div class="form2"><label class="f">Setor / área *<select name="setor" required><option value="">Selecione</option>${cfg.setores.map(s => `<option ${s === u.setor ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label class="f">WhatsApp *<input name="whats" type="tel" inputmode="numeric" placeholder="(11) 90000-0000" value="${esc(u.whatsapp || '')}" required></label></div>
      <label class="f">Como vai usar o ${esc(APP.name)}? *<select name="uso" required><option value="">Selecione</option>${['Finanças pessoais', 'Finanças da minha empresa', 'Os dois', 'Só conhecendo o sistema'].map(o => `<option ${o === u.extras?.uso ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      ${cfg.extras.length ? `<div class="form2">${cfg.extras.map(f => extraInput(f, u.extras?.[f.id])).join('')}</div>` : ''}
      <div id="err" class="sm" style="color:var(--bad)"></div>
      <button class="btn primary">Enviar para aprovação</button></form>
    <p class="sm" style="margin:18px 0 0"><button class="link" id="sair">Sair</button></p>`);
  maskPhone($('#fp').whats);
  $('#sair').onclick = () => { LS.del('session'); location.hash = '#/entrar'; };
  $('#fp').onsubmit = e => {
    e.preventDefault(); const f = e.target; const err = t => $('#err').textContent = t;
    const w = digits(f.whats.value); if (w.length < 10) return err('Confira o WhatsApp com DDD.');
    const extras = { uso: f.uso.value }; for (const x of cfg.extras) { const v = (f['x_' + x.id]?.value || '').trim(); if (x.type === 'cpf' && v && digits(v).length !== 11) return err(`${x.label}: CPF incompleto.`); extras[x.id] = v; }
    Object.assign(u, { setor: f.setor.value, whatsapp: w, extras, status: 'pendente', requestedAt: Date.now(), notify: null }); saveUser(u);
    location.hash = '#/aguardando';
  };
}

/* ---------- Aguardando aprovação ---------- */
const requestLink = u => `${baseURL()}#/aprovar?r=${packJSON({ v: 1, id: u.id, nome: u.nome, email: u.email, setor: u.setor, whatsapp: u.whatsapp, extras: u.extras, at: u.requestedAt, app: APP.name })}`;
async function notifyOwner(u) {
  const cfg = getConfig(); const ex = cfg.extras.map(f => [f.label, u.extras?.[f.id]]).filter(([, v]) => v);
  const body = { _subject: `Novo cadastro aguardando aprovação · ${APP.name}`, _template: 'table', _captcha: 'false', Sistema: APP.name, Nome: u.nome, 'E-mail': u.email, Setor: u.setor, WhatsApp: u.whatsapp, Uso: u.extras?.uso || '', ...Object.fromEntries(ex), 'Pedido em': fmtDT(u.requestedAt), 'Aprovar ou recusar': requestLink(u) };
  try {
    const r = await fetch(NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return String(j.success) === 'true' ? 'ok' : /activat/i.test(j.message || '') ? 'ativar' : 'erro';
  } catch { return 'erro'; }
}
export async function Aguardando() {
  const u = sessionUser(); if (!u) { location.hash = '#/entrar'; return; }
  if (statusOf(u) === 'ativo') { location.hash = APP.home; return; }
  const wa = `https://wa.me/${OWNER_WHATS}?text=${encodeURIComponent(`Olá, Eduardo! Fiz meu cadastro no ${APP.name} e estou aguardando aprovação.\n${u.nome} · ${u.email}\nLink para aprovar: ${requestLink(u)}`)}`;
  const paint = () => {
    const n = u.notify;
    view().innerHTML = shell(`
      ${steps(2)}<div class="eyebrow">Aguardando aprovação</div><h1>Cadastro enviado ✓</h1>
      <p class="mut" style="margin:6px 0 18px">A ECD Tecnologia vai conferir seus dados e liberar o acesso. Quando aprovar, você recebe um <b>link de liberação</b> no WhatsApp <b>${esc(u.whatsapp.replace(/(\d{2})(\d+)(\d{4})$/, '($1) $2-$3'))}</b>. Abra o link <b>neste mesmo aparelho e navegador</b>.</p>
      <div class="card pad" style="background:var(--soft,#faf7f0);display:grid;gap:6px;margin-bottom:16px"><div class="sm mut">Seu cadastro</div><b>${esc(u.nome)}</b><span class="sm">${esc(u.email)} · ${esc(u.setor)}</span><span class="sm">Enviado em ${fmtDT(u.requestedAt)}</span>
        <span class="sm" id="nst">${n === 'ok' ? '📧 Pedido enviado por e-mail para a ECD.' : n === 'enviando' || !n ? '📧 Enviando pedido por e-mail…' : '⚠️ Não deu para enviar o e-mail agora. Use o botão do WhatsApp abaixo.'}</span></div>
      <a class="btn wa" style="width:100%;justify-content:center" href="${wa}" target="_blank" rel="noopener">Avisar a ECD pelo WhatsApp</a>
      <details style="margin-top:16px"><summary class="sm">Já recebeu o link de liberação?</summary><form id="fk" class="row" style="margin-top:10px"><input class="search" name="l" placeholder="Cole o link aqui" style="flex:1" required><button class="btn sm primary">Liberar</button></form></details>
      <div class="row between sm" style="margin-top:18px"><a href="#/perfil">Corrigir cadastro</a><button class="link" id="sair">Sair</button></div>`);
    $('#sair').onclick = () => { LS.del('session'); location.hash = '#/entrar'; };
    $('#fk').onsubmit = e => { e.preventDefault(); const v = e.target.l.value.trim(); const h = v.slice(v.indexOf('#')); if (!h.startsWith('#/liberar')) return toast('Este não é um link de liberação.'); location.hash = h; };
  };
  paint();
  if (!u.notify || u.notify === 'erro' || u.notifiedAt !== u.requestedAt) {
    u.notify = 'enviando'; paint(); const r = await notifyOwner(u); u.notify = r === 'ativar' ? 'ok' : r; u.notifiedAt = u.requestedAt; saveUser(u); if (location.hash.startsWith('#/aguardando')) paint();
  }
}

/* ---------- Dono: aprovar ---------- */
async function ownerKey() { const p = LS.get('owner-phrase', null); if (!p) return null; const k = await keyFromPhrase(p).catch(() => null); return k?.ok ? k.key : null; }
const getLog = () => LS.get('approvals', []);
export async function Aprovar() {
  const r = unpackJSON(new URLSearchParams(location.hash.split('?')[1] || '').get('r') || '');
  const u = me();
  if (!r || !r.id || !r.email) { view().innerHTML = '<div class="card pad"><h2>Link de aprovação inválido</h2><p class="mut">O link chegou incompleto. Peça para a pessoa reenviar.</p></div>'; return; }
  if (!u || !u.owner) { view().innerHTML = '<div class="card pad"><h2>Só o administrador aprova cadastros</h2><p class="mut">Entre com a conta do administrador para continuar.</p><a class="btn primary" href="#/entrar">Entrar</a></div>'; return; }
  let key = await ownerKey();
  const log = getLog(); const prev = log.find(x => x.id === r.id && x.at === r.at);
  view().innerHTML = `<div class="head"><div><div class="eyebrow">Aprovação de cadastro</div><h1>${esc(r.nome)}</h1><p class="mut" style="margin:6px 0 0">Pediu acesso ao ${esc(r.app || APP.name)} em ${fmtDT(r.at)}</p></div><a class="btn" href="#/config">Usuários e aprovações</a></div>
    <div class="g2" style="align-items:start"><div class="card pad grid">
      <table class="items"><tbody>${[['Nome', r.nome], ['E-mail', r.email], ['Setor', r.setor], ['WhatsApp', r.whatsapp], ['Uso', r.extras?.uso], ...Object.entries(r.extras || {}).filter(([k]) => k !== 'uso').map(([k, v]) => [(getConfig().extras.find(f => f.id === k)?.label || k), v])].filter(([, v]) => v).map(([k, v]) => `<tr><td class="mut sm" style="width:120px">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</tbody></table>
      ${prev ? `<div class="tip">Você já ${prev.decisao === 'aprovado' ? 'aprovou' : 'recusou'} este pedido em ${fmtDT(prev.em)}.</div>` : ''}
      ${key ? '' : `<form id="fkey" class="grid"><label class="f">Chave de aprovação (só na primeira vez neste aparelho)<input name="frase" autocomplete="off" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" style="font:700 15px 'DejaVu Sans Mono',monospace;text-transform:uppercase" required></label><button class="btn">Salvar chave</button></form>`}
      <label class="f">Perfil de acesso<select id="role"><option value="user">Usuário</option><option value="admin">Administrador</option></select></label>
      <div class="row"><button class="btn primary" id="ok" ${key ? '' : 'disabled'}>✓ Aprovar acesso</button><button class="btn" id="no">Recusar</button></div>
    </div><div class="card pad grid" id="out"><div class="eyebrow">Como funciona</div><p class="sm mut" style="margin:0">Ao aprovar, o sistema gera um link de liberação assinado com a sua chave. Envie para a pessoa pelo WhatsApp: ela abre o link no aparelho onde fez o cadastro e o acesso é liberado na hora.</p></div></div>`;
  const fk = $('#fkey'); if (fk) fk.onsubmit = async e => { e.preventDefault(); const k = await keyFromPhrase(e.target.frase.value).catch(() => ({ ok: false })); if (!k.ok) return toast('Chave incorreta'); LS.set('owner-phrase', normPhrase(e.target.frase.value)); toast('Chave salva neste aparelho'); Aprovar(); };
  const record = (decisao, link = '') => { const l = getLog().filter(x => !(x.id === r.id && x.at === r.at)); l.unshift({ id: r.id, at: r.at, nome: r.nome, email: r.email, whatsapp: r.whatsapp, decisao, em: Date.now(), link }); LS.set('approvals', l.slice(0, 200)); };
  const phoneWa = w => `55${digits(w).replace(/^55(?=\d{10,11}$)/, '')}`;
  $('#ok').onclick = async () => {
    key = key || await ownerKey(); if (!key) return toast('Salve a chave de aprovação primeiro');
    const d = { id: r.id, email: r.email, at: r.at, role: $('#role').value, nome: r.nome };
    const sig = b64u(await crypto.subtle.sign({ name: 'Ed25519' }, key, enc(approvalMsg(d))));
    const link = `${baseURL()}#/liberar?d=${packJSON(d)}&s=${sig}`; record('aprovado', link);
    const msg = `Olá, ${r.nome.split(' ')[0]}! Seu acesso ao ${r.app || APP.name} foi aprovado ✅\nAbra este link no mesmo celular/navegador onde você fez o cadastro:\n${link}`;
    $('#out').innerHTML = `<div class="eyebrow">Aprovado ✓</div><h2>Envie o link de liberação</h2><p class="sm mut" style="margin:0">Ele só funciona para ${esc(r.email)} e não pode ser falsificado.</p><textarea class="search" style="height:110px;font-size:12px" readonly>${esc(link)}</textarea><div class="row"><a class="btn wa primary" target="_blank" rel="noopener" href="https://wa.me/${phoneWa(r.whatsapp)}?text=${encodeURIComponent(msg)}">Enviar pelo WhatsApp</a><button class="btn" id="cp">Copiar link</button></div>`;
    $('#cp').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link copiado'); } catch { toast('Copie o link na caixa acima'); } };
    toast('Cadastro aprovado');
  };
  $('#no').onclick = () => { record('recusado'); $('#out').innerHTML = `<div class="eyebrow">Recusado</div><p class="sm">Pedido marcado como recusado. Se quiser, avise a pessoa:</p><a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/${phoneWa(r.whatsapp)}?text=${encodeURIComponent(`Olá, ${r.nome.split(' ')[0]}. Recebemos seu cadastro no ${r.app || APP.name}, mas por enquanto o acesso não foi liberado. Qualquer dúvida, é só chamar.`)}">Avisar pelo WhatsApp</a>`; };
}

/* ---------- Pessoa: abrir link de liberação ---------- */
export async function Liberar() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''); const d = unpackJSON(qs.get('d') || ''); const s = qs.get('s') || '';
  const box = (t, m, btn = '<a class="btn primary" href="#/entrar">Ir para o login</a>') => view().innerHTML = shell(`<div class="eyebrow">Liberação de acesso</div><h1>${t}</h1><p class="mut" style="margin:6px 0 22px">${m}</p>${btn}`);
  if (!d || !s || !(await verifyApproval(d, s))) return box('Link inválido', 'Este link de liberação não é válido ou foi alterado. Peça um novo para a ECD Tecnologia.');
  const u = getUsers().find(x => x.id === d.id && x.email === d.email);
  if (!u) return box('Abra no aparelho do cadastro', `Este link é de <b>${esc(d.email)}</b>, mas o cadastro não está neste aparelho/navegador. Abra o link no mesmo celular e navegador em que você criou a conta.`);
  if (u.requestedAt && d.at !== u.requestedAt && statusOf(u) !== 'ativo') return box('Link antigo', 'Este link é de um pedido anterior. Peça para a ECD aprovar o pedido mais recente.');
  Object.assign(u, { status: 'ativo', role: d.role === 'admin' ? 'admin' : 'user', approvedAt: Date.now(), blocked: false }); saveUser(u); login(u);
  view().innerHTML = shell(`${steps(3)}<div class="eyebrow">Acesso liberado</div><h1>Bem-vindo, ${esc(u.nome.split(' ')[0])}! 🎉</h1><p class="mut" style="margin:6px 0 22px">Seu acesso ao ${esc(APP.name)} está liberado. Tudo o que você lançar fica salvo neste aparelho.</p><a class="btn primary" href="${APP.home}" id="go">Começar a usar</a>`);
  $('#go').onclick = () => LS.set('welcome', u.id);
}

/* ---------- Administração ---------- */
export function Config() {
  const u = me(); if (!u || u.role !== 'admin' || u.demo) { view().innerHTML = '<div class="card pad"><h2>Só administradores</h2><a class="btn" href="#/">Voltar</a></div>'; return; }
  const cfg = getConfig(); const users = getUsers().filter(x => !x.demo);
  const TYPES = { text: 'Texto', number: 'Número', date: 'Data', phone: 'Telefone', cpf: 'CPF', select: 'Lista de opções' };
  const ST = { ativo: ['Liberado', 'b-ok'], pendente: ['Aguardando', 'b-info'], perfil: ['Cadastro incompleto', 'b-mut'], bloqueado: ['Bloqueado', 'b-mut'] };
  const draw = async () => {
    const hasKey = !!(await ownerKey()); const log = getLog();
    view().innerHTML = `
    <div class="head"><div><div class="eyebrow">Administração</div><h1>Usuários e aprovações</h1><p class="mut" style="margin:6px 0 0">Quem cria conta completa o cadastro e fica aguardando. O pedido chega no e-mail ${esc(OWNER_EMAIL)} com o botão de aprovar.</p></div><a class="btn" href="${APP.home}">← Voltar</a></div>
    <div class="detail"><div class="grid">
      <div class="card pad grid"><div class="row between"><h2>Chave de aprovação</h2><span class="badge ${hasKey ? 'b-ok' : 'b-mut'}">${hasKey ? 'Salva neste aparelho' : 'Não configurada'}</span></div>
        <p class="mut sm" style="margin:-6px 0 0">É ela que assina os links de liberação. Guarde a frase em lugar seguro e não envie para ninguém.</p>
        ${hasKey ? '<button class="link sm" id="rmKey" style="justify-self:start">Remover chave deste aparelho</button>' : `<form id="fkey" class="row"><input class="search" name="frase" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" style="flex:1;font-family:'DejaVu Sans Mono',monospace;text-transform:uppercase" required><button class="btn sm primary">Salvar</button></form>`}</div>
      <div class="card" style="overflow:hidden"><div class="pad" style="padding-bottom:6px"><h2>Decisões recentes (${log.length})</h2></div>
        ${log.length ? `<table class="list"><thead><tr><th>Pessoa</th><th>Decisão</th><th></th></tr></thead><tbody>${log.map(x => `<tr style="cursor:default"><td class="doc-t">${esc(x.nome)}<small>${esc(x.email)} · ${fmtDT(x.em)}</small></td><td><span class="badge ${x.decisao === 'aprovado' ? 'b-ok' : 'b-mut'}">${x.decisao === 'aprovado' ? 'Aprovado' : 'Recusado'}</span></td><td style="text-align:right">${x.link ? `<button class="btn sm" data-cp="${esc(x.link)}">Copiar link</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="pad mut sm" style="padding-top:0">Os pedidos chegam por e-mail. Ao abrir o link do e-mail, a decisão aparece aqui.</p>'}</div>
      <div class="card pad grid"><h2>Setores</h2>
        <div class="row">${cfg.setores.map((s, i) => `<span class="tagx">${esc(s)}<button data-rs="${i}" title="Remover">✕</button></span>`).join('')}</div>
        <form id="fs" class="row"><input class="search" name="s" placeholder="Novo setor" required><button class="btn sm">+ Adicionar</button></form></div>
      <div class="card pad grid"><div><h2>Campos extras do cadastro</h2><p class="mut sm" style="margin:4px 0 0">Nome, e-mail, senha, setor e WhatsApp são pedidos sempre. Aqui você inclui o que mais precisa.</p></div>
        ${cfg.extras.length ? `<table class="items"><thead><tr><th>Campo</th><th>Tipo</th><th>Opções (para lista)</th><th>Obrigatório</th><th></th></tr></thead><tbody>
        ${cfg.extras.map((f, i) => `<tr data-i="${i}"><td><input data-k="label" value="${esc(f.label)}"></td><td><select data-k="type" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:7px">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
          <td><input data-k="options" value="${esc((f.options || []).join(', '))}" placeholder="Separe por vírgula" ${f.type === 'select' ? '' : 'disabled'}></td><td style="text-align:center"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''}></td><td><button class="link" data-rf="${i}">✕</button></td></tr>`).join('')}
        </tbody></table>` : ''}
        <form id="ff" class="row"><input class="search" name="l" placeholder="Novo campo (ex.: Cidade)"><button class="btn sm">+ Adicionar campo</button>${['CPF', 'Cidade', 'Empresa', 'Data de nascimento'].filter(n => !cfg.extras.some(f => f.label === n)).map(n => `<button type="button" class="chipbtn" data-q="${n}">+ ${n}</button>`).join('')}</form>
        <label class="row sm" style="gap:8px"><input type="checkbox" id="cDemo" ${cfg.demo ? 'checked' : ''}> Mostrar o botão "Ver a demonstração" na tela de entrada</label></div>
      <div class="card" style="overflow:hidden"><div class="pad" style="padding-bottom:6px"><h2>Contas neste aparelho (${users.length})</h2></div>
        <table class="list"><thead><tr><th>Nome</th><th>Situação</th><th class="hide-m">E-mail</th><th>Perfil</th></tr></thead><tbody>
        ${users.map(x => { const [t, c] = ST[statusOf(x)] || ST.ativo; return `<tr style="cursor:default"><td class="doc-t">${esc(x.nome)}<small>${esc(x.setor || '')}${x.whatsapp ? ' · ' + esc(x.whatsapp) : ''} · desde ${fmtD(x.createdAt)}</small></td><td><span class="badge ${x.owner ? 'b-ok' : c}">${x.owner ? 'Dono · acesso total' : t}</span></td><td class="hide-m sm">${esc(x.email)}</td><td><select data-role="${x.id}" ${x.id === u.id || x.owner ? 'disabled hidden' : ''} style="border:1px solid var(--line);border-radius:8px;padding:5px"><option value="user" ${x.role !== 'admin' && !x.blocked ? 'selected' : ''}>Usuário</option><option value="admin" ${x.role === 'admin' && !x.blocked ? 'selected' : ''}>Administrador</option><option value="blocked" ${x.blocked ? 'selected' : ''}>Bloqueado</option></select></td></tr>`; }).join('')}
        </tbody></table></div>
    </div>
    <aside class="grid" style="position:sticky;top:84px"><div class="card pad"><div class="eyebrow">Como entra uma pessoa nova</div><ol class="sm" style="margin:10px 0 0;padding-left:18px;display:grid;gap:8px"><li>Cria conta com nome, e-mail e senha</li><li>Completa o cadastro: setor, WhatsApp${cfg.extras.length ? ', ' + cfg.extras.map(f => esc(f.label)).join(', ') : ''}</li><li>O pedido chega no seu e-mail</li><li>Você abre, aprova e envia o link de liberação pelo WhatsApp</li><li>A pessoa abre o link e entra</li></ol>
      <p class="sm mut" style="margin:14px 0 0">Link de cadastro para enviar:</p><div class="row" style="margin-top:6px"><input class="search" readonly value="${esc(baseURL())}#/cadastro" style="flex:1;font-size:12px"><button class="btn sm" data-cp="${esc(baseURL())}#/cadastro">Copiar</button></div></div></aside>
    </div>`;
    const save = (redraw = false) => { LS.set('config', cfg); if (redraw) draw(); };
    const fk = $('#fkey'); if (fk) fk.onsubmit = async e => { e.preventDefault(); const k = await keyFromPhrase(e.target.frase.value).catch(() => ({ ok: false })); if (!k.ok) return toast('Chave incorreta'); LS.set('owner-phrase', normPhrase(e.target.frase.value)); toast('Chave salva'); draw(); };
    const rk = $('#rmKey'); if (rk) rk.onclick = () => { LS.del('owner-phrase'); draw(); };
    $('#cDemo').onchange = e => { cfg.demo = e.target.checked; save(); };
    $$('[data-cp]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.cp); toast('Link copiado'); } catch { toast(b.dataset.cp); } });
    $('#fs').onsubmit = e => { e.preventDefault(); const v = e.target.s.value.trim(); if (v && !cfg.setores.includes(v)) { cfg.setores.push(v); cfg.setores.sort((a, b) => a.localeCompare(b)); } save(true); };
    $$('[data-rs]').forEach(b => b.onclick = () => { cfg.setores.splice(+b.dataset.rs, 1); save(true); });
    $$('tr[data-i]').forEach(tr => { const f = cfg.extras[+tr.dataset.i]; $$('[data-k]', tr).forEach(el => el.onchange = () => { const k = el.dataset.k; f[k] = k === 'required' ? el.checked : k === 'options' ? el.value.split(',').map(s => s.trim()).filter(Boolean) : el.value; save(true); }); });
    $$('[data-rf]').forEach(b => b.onclick = () => { cfg.extras.splice(+b.dataset.rf, 1); save(true); });
    const add = (label, type = 'text') => { cfg.extras.push({ id: slug(label) + '_' + rid(3).toLowerCase(), label, type, required: false, options: type === 'select' ? ['Opção 1', 'Opção 2'] : [] }); save(true); };
    $('#ff').onsubmit = e => { e.preventDefault(); const v = e.target.l.value.trim(); if (v) add(v); };
    $$('[data-q]').forEach(b => b.onclick = () => { const n = b.dataset.q; add(n, n === 'CPF' ? 'cpf' : n === 'Data de nascimento' ? 'date' : 'text'); });
    $$('[data-role]').forEach(s => s.onchange = () => { const all = getUsers(); const x = all.find(y => y.id === s.dataset.role); x.blocked = s.value === 'blocked'; if (!x.blocked) x.role = s.value; LS.set('users', all); toast('Perfil atualizado'); });
  };
  draw();
}

/* ---------- Rotas ---------- */
const PUBLIC = ['entrar', 'cadastro', 'esqueci', 'nova-senha', 'liberar'];
const ONBOARD = ['perfil', 'aguardando'];
// Proteção de rotas: devolve true se a rota pode seguir.
export function guard(route, publicRoutes = []) {
  const su = sessionUser();
  if (su && statusOf(su) === 'bloqueado') { LS.del('session'); location.hash = '#/entrar'; return false; }
  if (route === 'liberar' || publicRoutes.includes(route)) { paintUser(); return true; }
  if (su && statusOf(su) !== 'ativo') {
    const r = routeFor(su); if (ONBOARD.includes(route) || PUBLIC.includes(route) && route !== 'entrar') { paintUser(); return true; }
    location.hash = r; return false;
  }
  if (!su && !PUBLIC.includes(route)) { if (route === 'aprovar') LS.set('next', location.hash); location.hash = '#/entrar'; return false; }
  if (su && [...PUBLIC, ...ONBOARD].includes(route)) { location.hash = APP.home; return false; }
  paintUser(); return true;
}
export function authRoute(route) {
  const R = { entrar: Entrar, cadastro: Cadastro, esqueci: Esqueci, 'nova-senha': NovaSenha, perfil: Perfil, aguardando: Aguardando, aprovar: Aprovar, liberar: Liberar, config: Config };
  if (R[route]) { R[route](); return true; }
  return false;
}
export const AUTH_ROUTES = ['entrar', 'cadastro', 'esqueci', 'nova-senha', 'perfil', 'aguardando', 'aprovar', 'liberar', 'config'];
export const takeWelcome = () => { const u = me(); const w = LS.get('welcome', null); if (u && w === u.id) { LS.del('welcome'); return true; } return false; };
