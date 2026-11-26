// ECD Finanças — fluxo de caixa, contas a pagar e receber, cartões, metas e relatórios (demonstração estática)
// ECD Tecnologia · github.com/Du-Edu-Duarte
import { configureAuth, guard, authRoute, me, AUTH_ROUTES, takeWelcome } from './ecd-auth.js';
import { readComprovante } from './comprovante.js';
import { ic } from './icons.js';
const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
configureAuth({ name: 'ECD Finanças', tagline: 'Seu dinheiro com clareza: o que entra, o que sai e o que sobra.', bullets: ['Contas a pagar e receber no mesmo lugar', 'Previsão dos próximos meses', 'Relatórios em PDF e Excel'], home: '#/' });

/* ---------------- utilidades ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = (n = 8) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(v || 0);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const ymOf = s => s.slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const dayIn = (ym, d) => `${ym}-${pad(Math.min(d, lastDay(ym)))}`;
const monthName = (ym, short = false) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 15).toLocaleDateString('pt-BR', short ? { month: 'short' } : { month: 'long', year: 'numeric' }).replace('.', '').replace(/^./, c => short ? c : c.toUpperCase()); };
const fmtD = s => s ? s.split('-').reverse().join('/') : '';
const parseMoney = v => { if (typeof v === 'number') return v; const s = String(v || '').replace(/[^\d,.-]/g, ''); if (!s) return 0; return s.includes(',') ? parseFloat(s.replace(/\./g, '').replace(',', '.')) : parseFloat(s); };
const winSafe = s => String(s ?? '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x00-\xFF—–•…€]/g, '');
const who = () => me()?.nome?.split(' ')[0] || 'Usuário';
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2600); }
function download(data, name, type) { const url = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); }

/* ---------------- dados (IndexedDB) ---------------- */
const dbp = new Promise((res, rej) => { const r = indexedDB.open('ecd-financas', 1); r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idb = async (store, mode, fn) => { const d = await dbp; return new Promise((res, rej) => { const t = d.transaction(store, mode); const o = fn(t.objectStore(store)); t.oncomplete = () => res(o?.result); t.onerror = () => rej(t.error); }); };
let S = null; // estado
const load = () => idb('kv', 'readonly', s => s.get('state'));
const save = () => { clearTimeout(save._t); save._t = setTimeout(() => idb('kv', 'readwrite', s => s.put(S, 'state')), 150); };
const putFile = (id, blob) => idb('files', 'readwrite', s => s.put(blob, id));
const getFile = id => idb('files', 'readonly', s => s.get(id));

/* ---------------- regras de negócio ---------------- */
const cat = id => S.categorias.find(c => c.id === id) || { nome: 'Sem categoria', tipo: 'saida' };
const contato = id => S.contatos.find(c => c.id === id);
const centro = id => S.centros.find(c => c.id === id);
const cartao = id => S.cartoes.find(c => c.id === id);
const empresa = () => S.modo === 'empresa';
function statusOf(l) {
  if (l.pago) return ['pago', 'Pago'];
  const t = today(); if (l.venc < t) return ['atrasado', 'Atrasado']; if (l.venc === t) return ['hoje', 'Vence hoje']; return ['avencer', 'A vencer'];
}
// gera lançamentos das contas fixas até o mês pedido
function ensureMonth(ym) {
  let changed = false;
  for (const r of S.recorrentes) {
    if (r.inicio && ym < r.inicio) continue; if (r.fim && ym > r.fim) continue;
    const key = r.id + ':' + ym; if (S.gerados.includes(key)) continue;
    let valor = r.valor; if (r.percent) { const base = S.recorrentes.find(x => x.id === r.percent.de); valor = base ? Math.round(base.valor * r.percent.p) / 100 : 0; }
    S.lancamentos.push({ id: uid(), desc: r.desc, tipo: r.tipo, valor, venc: dayIn(ym, r.dia), categoria: r.categoria, contato: r.contato || '', centro: r.centro || '', recId: r.id, pago: null, por: 'Conta fixa' });
    S.gerados.push(key); changed = true;
  }
  if (changed) save();
}
// faturas de cartão: compras entre fechamentos viram uma conta só, que vence no dia do cartão
function faturaYm(c, data) { const ym = ymOf(data); const d = +data.slice(8); return d > c.fechamento ? addMonths(ym, 1) : ym; }
function faturas(ym) {
  return S.cartoes.map(c => {
    const itens = S.lancamentos.filter(l => l.cartao === c.id && faturaYm(c, l.venc) === ym);
    const total = itens.reduce((a, l) => a + l.valor, 0);
    const pago = (S.faturasPagas || {})[c.id + ':' + ym];
    return { id: 'fat:' + c.id + ':' + ym, fatura: true, cartaoId: c.id, desc: `Fatura ${c.nome}`, tipo: 'saida', valor: total, venc: dayIn(ym, c.vencimento), categoria: 'cartao', pago: pago || null, itens };
  }).filter(f => f.valor > 0);
}
// lançamentos que movem o caixa num mês (compras no cartão entram pela fatura)
function caixa(ym) { ensureMonth(ym); return [...S.lancamentos.filter(l => !l.cartao && ymOf(l.venc) === ym), ...faturas(ym)]; }
const sign = l => l.tipo === 'entrada' ? 1 : -1;
const valorReal = l => l.pago ? (l.pago.valor ?? l.valor) : l.valor;
function saldoAte(dateIso) { // saldo realizado até a data
  let s = S.saldoInicial.valor;
  const yms = new Set(S.lancamentos.map(l => ymOf(l.venc))); S.cartoes.forEach(() => {});
  const allYm = [...new Set([...yms, ...Object.keys(S.faturasPagas || {}).map(k => k.split(':')[1])])];
  for (const ym of allYm) for (const l of caixa(ym)) if (l.pago && l.pago.data >= S.saldoInicial.data && l.pago.data <= dateIso) s += sign(l) * valorReal(l);
  return s;
}
function resumoMes(ym) {
  const ls = caixa(ym); const ent = ls.filter(l => l.tipo === 'entrada'), sai = ls.filter(l => l.tipo === 'saida');
  const sum = a => a.reduce((x, l) => x + valorReal(l), 0);
  return { ls, entradas: sum(ent), saidas: sum(sai), entPagas: sum(ent.filter(l => l.pago)), saiPagas: sum(sai.filter(l => l.pago)), pendEnt: sum(ent.filter(l => !l.pago)), pendSai: sum(sai.filter(l => !l.pago)) };
}
function previsto(ym) { // saldo previsto no fim do mês
  const t = today(); const cur = ymOf(t);
  if (ym < cur) return saldoAte(dayIn(ym, 31));
  let s = saldoAte(t);
  for (let m = cur; m <= ym; m = addMonths(m, 1)) { const r = resumoMes(m); s += r.pendEnt - r.pendSai; }
  return s;
}
const GUESS = [[/energia|cpfl|enel|eletropaulo|light\b|sabesp|agua|saneamento|internet|vivo fibra|claro|net\b|gas\b|comgas/, /contas da casa|energia/], [/mercado|supermerc|padaria|acougue|hortifruti|ifood|restaurante|lanchonete|pizzaria|atacad|assai|carrefour/, /mercado|aliment/], [/posto|combust|shell|ipiranga|uber|99\b|onibus|metro|estaciona|pedagio/, /transporte|combust/], [/farmacia|drogaria|droga|clinica|hospital|laborat|odonto|consulta/, /saude/], [/aluguel|condominio|imobiliaria|iptu/, /moradia|aluguel/], [/escola|faculdade|curso|udemy|livraria/, /educa/], [/netflix|spotify|disney|amazon prime|youtube|celular|tim\b|recarga/, /celular|assinatura|sistemas/], [/cinema|bar\b|show|ingresso|viagem|hotel/, /lazer/], [/salario|folha|pagamento de salario/, /salario|folha/]];
function guessCat(text, tipo) { const t = norm(text); for (const [re, cat] of GUESS) if (re.test(t)) { const c = S.categorias.find(x => x.tipo === tipo && cat.test(norm(x.nome))); if (c) return c.id; } return null; }
function autoCategoria(desc, tipo) { const d = norm(desc); const r = S.regras.find(x => d.includes(norm(x.contem))); if (r) return r.categoria; return (S.categorias.find(c => c.tipo === tipo && /outr/i.test(c.nome)) || S.categorias.find(c => c.tipo === tipo))?.id; }

/* ---------------- modais ---------------- */
function modal(html, w = 620) { const md = $('#modal'); md.hidden = false; md.className = 'modal'; md.innerHTML = `<div class="box" style="width:min(${w}px,100%)">${html}</div>`; md.onclick = e => { if (e.target === md) closeModal(); }; return md; }
const closeModal = () => { const md = $('#modal'); md.hidden = true; md.innerHTML = ''; md.onclick = null; };
function confirmBox(title, text, ok = 'Confirmar') { return new Promise(res => { const md = modal(`<h2 style="margin-bottom:8px">${esc(title)}</h2><p class="mut">${esc(text)}</p><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-a="n">Cancelar</button><button class="btn dark" data-a="y">${esc(ok)}</button></div>`, 440); md.onclick = e => { const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; closeModal(); res(a === 'y'); }; }); }
const catOpts = (tipo, sel) => S.categorias.filter(c => c.tipo === tipo).map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.nome)}</option>`).join('') + `<option value="__new" data-kind="cat" data-tipo="${tipo}">+ Nova categoria…</option>`;
const contOpts = (tipo, sel) => `<option value="">—</option>${S.contatos.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}<option value="__new" data-kind="contato" data-tipo="${tipo === 'entrada' ? 'cliente' : 'fornecedor'}">+ Novo ${tipo === 'entrada' ? 'cliente' : 'fornecedor'}…</option>`;
const centroOpts = sel => `<option value="">—</option>${S.centros.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}<option value="__new" data-kind="centro">+ Novo centro de custo…</option>`;
/* "+ Nova …" dentro de qualquer lista: cria na hora, sem sair da tela */
const ADD_LABEL = { cat: 'Nome da nova categoria', contato: 'Nome do cliente ou fornecedor', centro: 'Nome do centro de custo' };
document.addEventListener('focusin', e => { if (e.target.tagName === 'SELECT' && e.target.value !== '__new') e.target.dataset.prev = e.target.value; });
document.addEventListener('change', e => { if (e.target.tagName === 'SELECT' && e.target.value !== '__new') e.target.dataset.prev = e.target.value; });
document.addEventListener('change', e => {
  const sel = e.target; if (sel.tagName !== 'SELECT' || sel.value !== '__new') return;
  e.stopImmediatePropagation();
  const opt = sel.selectedOptions[0]; const kind = opt.dataset.kind, tipo = opt.dataset.tipo;
  const box = document.createElement('div'); box.className = 'addrow';
  box.innerHTML = `<input placeholder="${ADD_LABEL[kind]}" maxlength="60"><button type="button" class="btn sm primary">Adicionar</button><button type="button" class="link sm" title="Cancelar">✕</button>`;
  sel.hidden = true; sel.after(box); const inp = box.querySelector('input'); inp.focus();
  const close = v => { box.remove(); sel.hidden = false; sel.value = v ?? sel.dataset.prev ?? sel.querySelector('option[selected]')?.value ?? ''; if (sel.selectedIndex < 0 || sel.value === '__new') sel.selectedIndex = 0; if (v) sel.dispatchEvent(new Event('change', { bubbles: true })); };
  const ok = () => {
    const nome = inp.value.trim(); if (!nome) return inp.focus();
    const list = kind === 'cat' ? S.categorias : kind === 'contato' ? S.contatos : S.centros;
    let it = list.find(x => norm(x.nome) === norm(nome) && (kind !== 'cat' || x.tipo === tipo));
    if (!it) { it = kind === 'cat' ? { id: uid(), nome, tipo, limite: 0 } : kind === 'contato' ? { id: uid(), nome, tipo } : { id: uid(), nome }; list.push(it); save(); toast(`“${nome}” adicionado`); }
    // coloca a opção nova em todas as listas iguais da tela
    document.querySelectorAll(`option[value="__new"][data-kind="${kind}"]${tipo ? `[data-tipo="${tipo}"]` : ''}`).forEach(o => { if (!o.parentElement.querySelector(`option[value="${it.id}"]`)) o.insertAdjacentHTML('beforebegin', `<option value="${it.id}">${esc(it.nome)}</option>`); });
    close(it.id);
  };
  box.querySelector('.primary').onclick = ok; box.querySelector('.link').onclick = () => close();
  inp.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); ok(); } if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } };
}, true);

function editLanc(l = null, preset = {}) {
  const isNew = !l; l = l ? { ...l } : { tipo: 'saida', desc: '', valor: '', venc: today(), categoria: '', contato: '', centro: '', ...preset };
  const md = modal(`<div class="eyebrow">${isNew ? 'Novo lançamento' : 'Editar lançamento'}</div><h2 style="margin-bottom:14px">${isNew ? 'O que entrou ou saiu?' : esc(l.desc)}</h2>
  <form id="fL" class="grid">
    <div class="seg" id="tipoSeg"><button type="button" data-t="saida" class="${l.tipo === 'saida' ? 'on' : ''}">${ic('up', 16)} Saída / a pagar</button><button type="button" data-t="entrada" class="${l.tipo === 'entrada' ? 'on' : ''}">${ic('down', 16)} Entrada / a receber</button></div>
    <label class="cdrop"><input name="anexo" type="file" accept="image/*,application/pdf" hidden><b>${ic('paperclip', 16)} ${l.anexo ? 'Trocar comprovante' : 'Tem o comprovante? Anexe aqui'}</b><span>${l.anexo ? 'Já tem um comprovante anexado.' : 'PDF ou foto do Pix, transferência ou boleto: o sistema lê e preenche tudo.'}</span><em id="cdName"></em></label>
    <div class="readbox" id="readBox" hidden></div>
    <div class="formgrid">
      <label class="f full">Descrição<input name="desc" required value="${esc(l.desc)}" placeholder="Ex.: Conta de energia, Serviço para cliente"></label>
      <label class="f">Valor (R$)<input name="valor" required inputmode="decimal" value="${l.valor !== '' ? String(l.valor).replace('.', ',') : ''}" placeholder="0,00"></label>
      <label class="f">${l.cartao ? 'Data da compra' : 'Vencimento'}<input name="venc" type="date" required value="${l.venc}"></label>
      <label class="f">Categoria<select name="categoria" id="selCat">${catOpts(l.tipo, l.categoria)}</select></label>
      ${empresa() ? `<label class="f"><span id="contLbl">${l.tipo === 'entrada' ? 'Cliente' : 'Fornecedor'}</span><select name="contato" id="selCont">${contOpts(l.tipo, l.contato)}</select></label>
      <label class="f">Centro de custo<select name="centro">${centroOpts(l.centro)}</select></label>` : ''}
      ${isNew ? `<label class="f" id="fForma">Forma<select name="forma"><option value="vista">À vista / boleto / Pix</option><option value="parc">Parcelado</option>${S.cartoes.map(c => `<option value="c:${c.id}">Cartão ${esc(c.nome)}</option>`).join('')}<option value="fixa">Repete todo mês (conta fixa)</option></select></label>
      <label class="f" id="fParc" hidden>Parcelas<input name="parcelas" type="number" min="2" max="48" value="10"></label>` : ''}
      <label class="f full">Observação<input name="obs" value="${esc(l.obs || '')}" placeholder="Opcional"></label>
      ${isNew ? '<label class="row sm full" style="gap:8px"><input type="checkbox" name="jaPago"> Já foi pago / recebido</label>' : ''}
    </div>
    <div class="hint" id="autoHint"></div>
    <div class="row between">${!isNew ? '<button type="button" class="btn" id="delL">Excluir</button>' : '<span></span>'}<div class="row"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Salvar</button></div></div>
  </form>`);
  const f = $('#fL');
  $$('#tipoSeg button').forEach(b => b.onclick = () => { l.tipo = b.dataset.t; $$('#tipoSeg button').forEach(x => x.classList.toggle('on', x === b)); $('#selCat').innerHTML = catOpts(l.tipo); const sc = $('#selCont'); if (sc) sc.innerHTML = contOpts(l.tipo, sc.value); const cl = $('#contLbl'); if (cl) cl.textContent = l.tipo === 'entrada' ? 'Cliente' : 'Fornecedor'; suggest(); });
  const suggest = () => { if (!isNew) return; const c = autoCategoria(f.desc.value, l.tipo); const r = S.regras.find(x => norm(f.desc.value).includes(norm(x.contem))); if (r && c) { f.categoria.value = c; $('#autoHint').textContent = `Categoria escolhida pela regra “${r.contem}”.`; } else $('#autoHint').textContent = ''; };
  f.desc.oninput = suggest;
  const setTipo = t => { const b = $(`#tipoSeg button[data-t="${t}"]`); if (b && l.tipo !== t) b.click(); };
  f.anexo.onchange = async () => {
    const file = f.anexo.files[0]; const rb = $('#readBox'); if (!file) return;
    $('#cdName').textContent = file.name; rb.hidden = false; rb.className = 'readbox'; rb.innerHTML = `<span class="spin"></span> Lendo o comprovante${/^image/.test(file.type) ? ' (foto: pode levar uns segundos)' : ''}…`;
    let r = null; try { r = await readComprovante(file, me()?.nome || ''); } catch (err) { console.warn(err); }
    if (!document.body.contains(rb)) return;
    if (!r || r.vazio || !(r.valor > 0)) { rb.className = 'readbox warn'; rb.innerHTML = 'Não consegui ler os dados desse comprovante. Ele fica anexado: preencha os campos acima.'; return; }
    if (r.tipo) setTipo(r.tipo);
    f.valor.value = r.valor.toFixed(2).replace('.', ',');
    if (r.data) f.venc.value = r.data;
    if (isNew || !f.desc.value) f.desc.value = r.desc;
    if (isNew) { const rg = S.regras.find(x => norm(r.desc + ' ' + r.texto).includes(norm(x.contem))); const c = rg?.categoria || guessCat(r.contraparte + ' ' + r.texto, l.tipo) || autoCategoria(r.desc, l.tipo); if (c) f.categoria.value = c; if (f.jaPago) f.jaPago.checked = true; }
    if (r.contraparte && f.contato) { let k = S.contatos.find(x => norm(x.nome) === norm(r.contraparte)); if (k) f.contato.value = k.id; }
    rb.className = 'readbox ok';
    rb.innerHTML = `<b>${ic('paperclip', 16)} Comprovante lido</b><span>${r.tipo === 'entrada' ? ic('down', 14) + ' Entrada' : r.tipo === 'saida' ? ic('up', 14) + ' Saída' : 'Tipo não identificado: escolha acima'}${r.meio ? ' · ' + r.meio : ''} · <b>${money(r.valor)}</b>${r.data ? ' · ' + fmtD(r.data) : ''}${r.contraparte ? ' · ' + esc(r.contraparte) : ''}</span><small>Confira os campos e toque em Salvar.</small>`;
  };
  if (f.forma) f.forma.onchange = () => { $('#fParc').hidden = f.forma.value !== 'parc'; if (f.forma.value.startsWith('c:')) $('#fParc').hidden = false; };
  $('[data-x]', md).onclick = closeModal;
  const del = $('#delL'); if (del) del.onclick = async () => { if (!(await confirmBox('Excluir lançamento?', l.parcela ? 'Exclui só esta parcela.' : 'Ele sai do fluxo de caixa.', 'Excluir'))) return; S.lancamentos = S.lancamentos.filter(x => x.id !== l.id); save(); route(); toast('Lançamento excluído'); };
  f.onsubmit = async e => {
    e.preventDefault(); const valor = parseMoney(f.valor.value); if (!(valor > 0)) return toast('Informe um valor maior que zero');
    const base = { desc: f.desc.value.trim(), tipo: l.tipo, valor, venc: f.venc.value, categoria: f.categoria.value, contato: f.contato?.value || '', centro: f.centro?.value || '', obs: f.obs.value.trim(), por: who() };
    let anexo = l.anexo; const file = f.anexo.files[0]; if (file) { anexo = { id: uid(), nome: file.name, tipo: file.type }; await putFile(anexo.id, file); }
    const jaPago = f.jaPago?.checked ? { data: f.venc.value, valor, por: who() } : null;
    if (!isNew) { Object.assign(S.lancamentos.find(x => x.id === l.id), base, { anexo }); save(); closeModal(); route(); return toast('Lançamento atualizado'); }
    const forma = f.forma.value;
    if (forma === 'fixa') { const r = { id: uid(), desc: base.desc, tipo: base.tipo, valor, dia: +base.venc.slice(8), categoria: base.categoria, contato: base.contato, centro: base.centro, inicio: ymOf(base.venc) }; S.recorrentes.push(r); ensureMonth(ymOf(base.venc)); save(); closeModal(); route(); return toast('Conta fixa criada: ela aparece todo mês'); }
    const n = forma === 'parc' || forma.startsWith('c:') ? Math.max(1, +f.parcelas.value || 1) : 1; const grupo = uid(); const card = forma.startsWith('c:') ? forma.slice(2) : null;
    for (let i = 0; i < n; i++) {
      const ym = addMonths(ymOf(base.venc), i); const venc = dayIn(ym, +base.venc.slice(8));
      S.lancamentos.push({ id: uid(), ...base, valor: Math.round(valor / n * 100) / 100, venc, cartao: card, parcela: n > 1 ? { n: i + 1, total: n, grupo } : null, pago: i === 0 && n === 1 && !card ? jaPago : null, anexo: i === 0 ? anexo : null });
    }
    save(); closeModal(); route(); toast(n > 1 ? `${n} parcelas criadas` : card ? 'Compra lançada no cartão' : 'Lançamento salvo');
  };
  setTimeout(() => f.desc.focus(), 30);
}
function pagar(l) {
  if (l.fatura) {
    const md = modal(`<div class="eyebrow">Pagar fatura</div><h2>${esc(l.desc)}</h2><p class="mut sm">${l.itens.length} compras · vence ${fmtD(l.venc)}</p><form id="fP" class="formgrid" style="margin-top:12px"><label class="f">Data do pagamento<input type="date" name="data" value="${today()}"></label><label class="f">Valor pago<input name="valor" value="${String(l.valor.toFixed(2)).replace('.', ',')}"></label><div class="row full" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Confirmar pagamento</button></div></form>`, 480);
    $('[data-x]', md).onclick = closeModal;
    $('#fP').onsubmit = e => { e.preventDefault(); (S.faturasPagas ||= {})[l.cartaoId + ':' + ymOf(l.venc)] = { data: e.target.data.value, valor: parseMoney(e.target.valor.value), por: who() }; save(); closeModal(); route(); toast('Fatura paga'); };
    return;
  }
  if (l.pago) { const x = S.lancamentos.find(z => z.id === l.id); x.pago = null; save(); route(); return toast('Marcado como não pago'); }
  const md = modal(`<div class="eyebrow">${l.tipo === 'entrada' ? 'Confirmar recebimento' : 'Confirmar pagamento'}</div><h2>${esc(l.desc)}</h2><p class="mut sm">Previsto ${money(l.valor)} · vence ${fmtD(l.venc)}</p>
    <form id="fP" class="formgrid" style="margin-top:12px"><label class="f">Data em que ${l.tipo === 'entrada' ? 'recebeu' : 'pagou'}<input type="date" name="data" value="${today()}"></label><label class="f">Valor ${l.tipo === 'entrada' ? 'recebido' : 'pago'} (com juros ou desconto)<input name="valor" value="${String(l.valor.toFixed(2)).replace('.', ',')}"></label>
    <label class="f full">Comprovante (opcional)<input type="file" name="anexo" accept="image/*,application/pdf"></label>
    <div class="row full" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Confirmar</button></div></form>`, 520);
  $('[data-x]', md).onclick = closeModal;
  $('#fP').onsubmit = async e => {
    e.preventDefault(); const x = S.lancamentos.find(z => z.id === l.id); x.pago = { data: e.target.data.value, valor: parseMoney(e.target.valor.value), por: who() };
    const file = e.target.anexo.files[0]; if (file) { x.anexo = { id: uid(), nome: file.name, tipo: file.type }; await putFile(x.anexo.id, file); }
    save(); closeModal(); route(); toast(l.tipo === 'entrada' ? 'Recebimento confirmado' : 'Pagamento confirmado');
  };
}
async function verAnexo(a) { const f = await getFile(a.id); if (!f) return toast('Comprovante não encontrado'); const url = URL.createObjectURL(f); const md = modal(`<div class="row between" style="margin-bottom:10px"><h2>${esc(a.nome)}</h2><button class="btn sm" data-x>Fechar</button></div>${/pdf/.test(a.tipo) ? `<iframe src="${url}" style="width:100%;height:70vh;border:0"></iframe>` : `<img src="${url}" style="max-width:100%;border-radius:10px">`}`, 760); $('[data-x]', md).onclick = closeModal; }

/* ---------------- telas ---------------- */
const view = () => $('#view');
let YM = ymOf(today());
const monthNav = () => `<div class="monthnav"><button data-m="-1" title="Mês anterior">‹</button><b>${monthName(YM)}</b><button data-m="1" title="Próximo mês">›</button></div>`;
const bindMonth = fn => $$('[data-m]').forEach(b => b.onclick = () => { YM = addMonths(YM, +b.dataset.m); fn(); });
const stBtn = l => { const [k, t] = statusOf(l); return `<button class="st ${k}" data-pay="${l.id}" title="${l.pago ? 'Clique para desfazer' : 'Clique para confirmar'}">${t}</button>`; };
const findL = id => id.startsWith('fat:') ? faturas(id.split(':')[2]).find(f => f.id === id) : S.lancamentos.find(l => l.id === id);
const bindPay = () => $$('[data-pay]').forEach(b => b.onclick = e => { e.stopPropagation(); pagar(findL(b.dataset.pay)); });

function chartSVG(months) {
  const data = months.map(m => ({ m, ...resumoMes(m), saldo: previsto(m) }));
  const W = 640, H = 230, P = { l: 56, r: 14, t: 14, b: 30 }; const max = Math.max(1, ...data.flatMap(d => [d.entradas, d.saidas])); const sMin = Math.min(0, ...data.map(d => d.saldo)), sMax = Math.max(1, ...data.map(d => d.saldo));
  const bw = (W - P.l - P.r) / data.length; const y = v => P.t + (H - P.t - P.b) * (1 - v / max); const ys = v => P.t + (H - P.t - P.b) * (1 - (v - sMin) / (sMax - sMin || 1));
  const cur = ymOf(today());
  let g = ''; for (let k = 0; k <= 4; k++) { const v = max * k / 4; g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#ece6da"/><text x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#9a917f">${v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)}</text>`; }
  const bars = data.map((d, i) => { const x = P.l + i * bw; const fut = d.m > cur; return `<g opacity="${fut ? .45 : 1}"><rect x="${x + bw * .16}" y="${y(d.entradas)}" width="${bw * .3}" height="${H - P.b - y(d.entradas)}" rx="3" fill="var(--ok)"><title>Entradas ${money(d.entradas)}</title></rect><rect x="${x + bw * .5}" y="${y(d.saidas)}" width="${bw * .3}" height="${H - P.b - y(d.saidas)}" rx="3" fill="var(--bad)"><title>Saídas ${money(d.saidas)}</title></rect></g><text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="${d.m === cur ? '#15110a' : '#9a917f'}" font-weight="${d.m === cur ? 700 : 400}">${monthName(d.m, true)}</text>`; }).join('');
  const pts = data.map((d, i) => `${P.l + i * bw + bw / 2},${ys(d.saldo)}`).join(' ');
  const dots = data.map((d, i) => `<circle cx="${P.l + i * bw + bw / 2}" cy="${ys(d.saldo)}" r="3.5" fill="#fff" stroke="var(--gold2)" stroke-width="2"><title>Saldo ${money(d.saldo)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Entradas e saídas por mês">${g}${bars}<polyline points="${pts}" fill="none" stroke="var(--gold2)" stroke-width="2.5" stroke-dasharray="0"/>${dots}</svg><div class="lg"><span><i style="background:var(--ok)"></i>Entradas</span><span><i style="background:var(--bad)"></i>Saídas</span><span><i style="background:var(--gold2)"></i>Saldo no fim do mês</span><span>Meses futuros mais claros = previsão</span></div>`;
}
function Visao() {
  const r = resumoMes(YM); const cur = ymOf(today()); const saldo = saldoAte(today()); const prev = previsto(YM);
  const pend = r.ls.filter(l => !l.pago).sort((a, b) => a.venc.localeCompare(b.venc));
  const pagar_ = pend.filter(l => l.tipo === 'saida'), receber = pend.filter(l => l.tipo === 'entrada');
  const gastos = {}; r.ls.filter(l => l.tipo === 'saida' && !l.fatura).forEach(l => gastos[l.categoria] = (gastos[l.categoria] || 0) + valorReal(l));
  S.lancamentos.filter(l => l.cartao && faturaYm(cartao(l.cartao), l.venc) === YM).forEach(l => gastos[l.categoria] = (gastos[l.categoria] || 0) + l.valor);
  const lims = S.categorias.filter(c => c.limite).map(c => ({ c, v: gastos[c.id] || 0 })).sort((a, b) => b.v / b.c.limite - a.v / a.c.limite);
  const months = Array.from({ length: 6 }, (_, i) => addMonths(cur, i - 5)).concat([addMonths(cur, 1), addMonths(cur, 2)]);
  const item = l => { const d = l.venc.split('-'); return `<div class="it"><div class="dd"><b>${d[2]}</b><small>${monthName(ymOf(l.venc), true)}</small></div><div><b>${esc(l.desc)}</b><div class="mut sm">${l.fatura ? `${l.itens.length} compras no cartão` : esc(cat(l.categoria).nome)}${contato(l.contato) ? ' · ' + esc(contato(l.contato).nome) : ''}</div></div><div style="text-align:right"><div class="amt ${l.tipo === 'entrada' ? 'pos' : ''}">${money(l.valor)}</div>${stBtn(l)}</div></div>`; };
  view().innerHTML = `
  <div class="head"><div><div class="eyebrow">${empresa() ? 'Fluxo de caixa' : 'Finanças pessoais'} · ${esc(S.nome)}</div><h1>${empresa() ? 'Visão geral da empresa' : 'Visão geral'}</h1><p class="mut" style="margin:6px 0 0">O que entra, o que sai e o que sobra, hoje e nos próximos meses.</p></div>${monthNav()}</div>
  <div class="kpis fin">
    <div class="card kpi"><small>Saldo hoje</small><b class="${saldo < 0 ? 'neg' : ''}">${money(saldo)}</b><div class="sub">tudo o que já foi pago e recebido</div></div>
    <div class="card kpi ok"><small>Entradas do mês</small><b>${money(r.entradas)}</b><div class="sub">${money(r.entPagas)} já recebido</div></div>
    <div class="card kpi warn"><small>Saídas do mês</small><b style="color:var(--bad)">${money(r.saidas)}</b><div class="sub">${money(r.saiPagas)} já pago</div></div>
    <div class="card kpi info"><small>Previsto no fim do mês</small><b class="${prev < 0 ? 'neg' : ''}">${money(prev)}</b><div class="sub">se tudo for pago e recebido</div></div>
  </div>
  <div class="g2">
    <div class="card pad chart"><div class="row between"><h2>Entradas x saídas</h2><span class="mut sm">últimos 6 meses + previsão</span></div>${chartSVG(months)}
      <div class="proj">${[1, 2, 3].map(n => { const m = addMonths(cur, n); const v = previsto(m); return `<div><small>Fim de ${monthName(m).toLowerCase()}</small><b class="${v < 0 ? 'neg' : ''}">${money(v)}</b></div>`; }).join('')}</div></div>
    <div class="card pad"><div class="row between"><h2>A pagar</h2><span class="mut sm">${money(pagar_.reduce((a, l) => a + l.valor, 0))}</span></div>
      <div class="due">${pagar_.slice(0, 5).map(item).join('') || '<p class="mut sm">Nada pendente neste mês.</p>'}</div>${pagar_.length > 5 ? `<a href="#/lancamentos" class="sm"><b>Ver todas (${pagar_.length}) →</b></a>` : ''}</div>
  </div>
  <div class="g3">
    <div class="card pad"><div class="row between"><h2>A receber</h2><span class="mut sm">${money(receber.reduce((a, l) => a + l.valor, 0))}</span></div><div class="due">${receber.slice(0, 4).map(item).join('') || '<p class="mut sm">Nada a receber pendente.</p>'}</div></div>
    <div class="card pad"><div class="row between"><h2>Limites do mês</h2><a class="sm" href="#/ajustes">Ajustar</a></div><div style="margin-top:10px">${lims.map(({ c, v }) => { const p = v / c.limite; return `<div class="lim"><div class="row"><span><b>${esc(c.nome)}</b>${p >= 1 ? ' <span class="badge b-bad">passou</span>' : p >= .8 ? ' <span class="badge b-warn">80%</span>' : ''}</span><span class="mut">${money(v)} de ${money(c.limite)}</span></div><div class="bar ${p >= 1 ? 'over' : p >= .8 ? 'warn' : 'ok'}"><i style="width:${Math.min(100, p * 100)}%"></i></div></div>`; }).join('') || '<p class="mut sm">Defina limites por categoria em Ajustes.</p>'}</div></div>
    <div class="card pad"><div class="row between"><h2>Metas</h2><a class="sm" href="#/metas">Ver</a></div><div style="margin-top:10px">${S.metas.map(m => { const p = m.atual / m.alvo; return `<div class="lim"><div class="row"><b>${esc(m.nome)}</b><span class="mut">${Math.round(p * 100)}%</span></div><div class="bar ok"><i style="width:${Math.min(100, p * 100)}%"></i></div><div class="mut sm" style="margin-top:4px">${money(m.atual)} de ${money(m.alvo)}</div></div>`; }).join('') || '<p class="mut sm">Crie sua primeira meta.</p>'}</div></div>
  </div>`;
  bindMonth(Visao); bindPay();
}
let LF = { q: '', tipo: 'all', st: 'all', cat: 'all', ct: 'all' };
function Lancamentos() {
  const r = resumoMes(YM); const cardIt = S.lancamentos.filter(l => l.cartao && faturaYm(cartao(l.cartao), l.venc) === YM);
  let rows = [...r.ls.filter(l => !l.fatura), ...cardIt].sort((a, b) => a.venc.localeCompare(b.venc));
  const q = norm(LF.q); rows = rows.filter(l => (LF.tipo === 'all' || l.tipo === LF.tipo) && (LF.st === 'all' || statusOf(l)[0] === LF.st) && (LF.cat === 'all' || l.categoria === LF.cat) && (LF.ct === 'all' || l.contato === LF.ct) && (!q || norm([l.desc, cat(l.categoria).nome, contato(l.contato)?.nome, l.obs].join(' ')).includes(q)));
  view().innerHTML = `
  <div class="head"><div><div class="eyebrow">Lançamentos</div><h1>Lançamentos</h1></div><div class="row">${monthNav()}<button class="btn" id="csv">↓ Excel (CSV)</button><button class="btn primary" id="nl">+ Lançamento</button></div></div>
  <div class="row filters">
    <input class="search" id="q" placeholder="Buscar descrição, categoria${empresa() ? ', cliente ou fornecedor' : ''}" value="${esc(LF.q)}">
    <select class="sel" id="fT"><option value="all">Entradas e saídas</option><option value="entrada" ${LF.tipo === 'entrada' ? 'selected' : ''}>Só entradas</option><option value="saida" ${LF.tipo === 'saida' ? 'selected' : ''}>Só saídas</option></select>
    <select class="sel" id="fS"><option value="all">Qualquer situação</option>${[['avencer', 'A vencer'], ['hoje', 'Vence hoje'], ['atrasado', 'Atrasado'], ['pago', 'Pago']].map(([k, t]) => `<option value="${k}" ${LF.st === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <select class="sel" id="fC"><option value="all">Todas as categorias</option>${S.categorias.map(c => `<option value="${c.id}" ${LF.cat === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>
    ${empresa() ? `<select class="sel" id="fK"><option value="all">Clientes e fornecedores</option>${S.contatos.map(c => `<option value="${c.id}" ${LF.ct === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>` : ''}
  </div>
  <div class="card" style="overflow:hidden">${rows.length ? `<table class="list"><thead><tr><th>Descrição</th><th class="hide-m">Vencimento</th><th style="text-align:right">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
  ${rows.map(l => `<tr data-e="${l.id}"><td><div class="lrow"><span class="ic ${l.tipo === 'entrada' ? 'in' : 'out'}">${l.tipo === 'entrada' ? ic('down') : ic('up')}</span><div><b>${esc(l.desc)}</b>${l.parcela ? ` <span class="chip">${l.parcela.n}/${l.parcela.total}</span>` : ''}<div class="chips" style="margin-top:3px"><span class="mut sm">${esc(cat(l.categoria).nome)}</span>${contato(l.contato) ? `<span class="mut sm">· ${esc(contato(l.contato).nome)}</span>` : ''}${centro(l.centro) ? `<span class="mut sm">· ${esc(centro(l.centro).nome)}</span>` : ''}${l.recId ? '<span class="mut sm">· fixa</span>' : ''}${l.cartao ? `<span class="mut sm">· ${ic('card', 14)} ${esc(cartao(l.cartao)?.nome)}</span>` : ''}</div></div></div></td>
    <td class="hide-m mut sm">${fmtD(l.venc)}${l.pago ? `<div>pago ${fmtD(l.pago.data)}${l.pago.por ? ' · ' + esc(l.pago.por) : ''}</div>` : ''}</td>
    <td style="text-align:right" class="amt ${l.tipo === 'entrada' ? 'pos' : ''}">${l.tipo === 'entrada' ? '+' : '−'} ${money(valorReal(l))}${l.pago && l.pago.valor !== l.valor ? `<div class="mut sm" style="font-weight:500">previsto ${money(l.valor)}</div>` : ''}</td>
    <td>${l.cartao ? '<span class="chip">na fatura</span>' : stBtn(l)}</td>
    <td style="text-align:right;white-space:nowrap">${l.anexo ? `<button class="iconbtn" data-ax="${l.id}" title="Ver comprovante">${ic('paperclip')}</button>` : ''}<button class="iconbtn" title="Editar">${ic('pencil')}</button></td></tr>`).join('')}
  </tbody></table>` : '<div class="empty">Nenhum lançamento com esses filtros.</div>'}</div>`;
  bindMonth(Lancamentos); bindPay();
  const qq = $('#q'); qq.oninput = () => { LF.q = qq.value; clearTimeout(qq._t); qq._t = setTimeout(() => { Lancamentos(); const n = $('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 220); };
  $('#fT').onchange = e => { LF.tipo = e.target.value; Lancamentos(); }; $('#fS').onchange = e => { LF.st = e.target.value; Lancamentos(); }; $('#fC').onchange = e => { LF.cat = e.target.value; Lancamentos(); }; const k = $('#fK'); if (k) k.onchange = e => { LF.ct = e.target.value; Lancamentos(); };
  $('#nl').onclick = () => editLanc();
  $$('tr[data-e]').forEach(tr => tr.onclick = e => { if (e.target.closest('[data-ax]')) return verAnexo(S.lancamentos.find(l => l.id === tr.dataset.e).anexo); editLanc(S.lancamentos.find(l => l.id === tr.dataset.e)); });
  $('#csv').onclick = () => exportCSV(rows, `lancamentos-${YM}.csv`);
}
function exportCSV(rows, name) {
  const h = ['Descrição', 'Tipo', 'Categoria', ...(empresa() ? ['Cliente/Fornecedor', 'Centro de custo'] : []), 'Vencimento', 'Valor previsto', 'Situação', 'Data pagamento', 'Valor pago', 'Parcela', 'Observação'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`; const n = v => (v ?? '') === '' ? '' : String(v.toFixed(2)).replace('.', ',');
  const lines = rows.map(l => [l.desc, l.tipo === 'entrada' ? 'Entrada' : 'Saída', cat(l.categoria).nome, ...(empresa() ? [contato(l.contato)?.nome || '', centro(l.centro)?.nome || ''] : []), fmtD(l.venc), n(l.valor), statusOf(l)[1], l.pago ? fmtD(l.pago.data) : '', l.pago ? n(l.pago.valor) : '', l.parcela ? `${l.parcela.n}/${l.parcela.total}` : '', l.obs || ''].map(q).join(';'));
  download('﻿' + [h.map(q).join(';'), ...lines].join('\r\n'), name, 'text/csv;charset=utf-8'); toast('Planilha baixada: abre direto no Excel');
}
function Fixas() {
  view().innerHTML = `<div class="head"><div><div class="eyebrow">Contas fixas</div><h1>Contas fixas</h1><p class="mut" style="margin:6px 0 0">Elas entram sozinhas em cada mês. Mudar o valor vale para os próximos meses; os meses que já passaram ficam como estão.</p></div><button class="btn primary" id="nf">+ Conta fixa</button></div>
  <div class="g3">${S.recorrentes.map(r => `<div class="card pad"><div class="row between"><span class="ic ${r.tipo === 'entrada' ? 'in' : 'out'}">${r.tipo === 'entrada' ? ic('down') : ic('repeat')}</span><span class="mut sm">todo dia ${r.dia}</span></div><h3 style="margin-top:12px">${esc(r.desc)}</h3><div class="amt" style="font-size:22px;margin:4px 0">${r.percent ? `${r.percent.p}% de ${esc(S.recorrentes.find(x => x.id === r.percent.de)?.desc || '')}` : money(r.valor)}</div><div class="mut sm">${esc(cat(r.categoria).nome)}${contato(r.contato) ? ' · ' + esc(contato(r.contato).nome) : ''}${r.fim ? ' · até ' + monthName(r.fim) : ''}</div><div class="row" style="margin-top:12px"><button class="btn sm" data-ed="${r.id}">Editar</button><button class="btn sm" data-end="${r.id}">Encerrar</button></div></div>`).join('')}</div>`;
  $('#nf').onclick = () => { editLanc(null, {}); setTimeout(() => { const f = $('#fL'); f.forma.value = 'fixa'; f.forma.onchange(); }, 40); };
  $$('[data-ed]').forEach(b => b.onclick = () => {
    const r = S.recorrentes.find(x => x.id === b.dataset.ed);
    const md = modal(`<h2 style="margin-bottom:12px">${esc(r.desc)}</h2><form id="fR" class="formgrid"><label class="f full">Descrição<input name="desc" value="${esc(r.desc)}"></label>${r.percent ? `<label class="f">Porcentagem (%)<input name="p" value="${r.percent.p}"></label>` : `<label class="f">Valor (R$)<input name="valor" value="${String(r.valor).replace('.', ',')}"></label>`}<label class="f">Dia do vencimento<input name="dia" type="number" min="1" max="31" value="${r.dia}"></label><label class="f">Categoria<select name="cat">${catOpts(r.tipo, r.categoria)}</select></label><div class="row full" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Salvar</button></div></form>`, 520);
    $('[data-x]', md).onclick = closeModal;
    $('#fR').onsubmit = e => { e.preventDefault(); const f = e.target; r.desc = f.desc.value; if (r.percent) r.percent.p = parseMoney(f.p.value); else r.valor = parseMoney(f.valor.value); r.dia = +f.dia.value; r.categoria = f.cat.value;
      const cur = ymOf(today()); S.lancamentos.filter(l => l.recId === r.id && ymOf(l.venc) >= cur && !l.pago).forEach(l => { l.desc = r.desc; l.categoria = r.categoria; l.venc = dayIn(ymOf(l.venc), r.dia); if (!r.percent) l.valor = r.valor; });
      save(); closeModal(); Fixas(); toast('Conta fixa atualizada a partir deste mês'); };
  });
  $$('[data-end]').forEach(b => b.onclick = async () => { const r = S.recorrentes.find(x => x.id === b.dataset.end); if (!(await confirmBox('Encerrar conta fixa?', 'Ela para de aparecer a partir do próximo mês. O histórico continua.', 'Encerrar'))) return; r.fim = ymOf(today()); S.lancamentos = S.lancamentos.filter(l => !(l.recId === r.id && ymOf(l.venc) > r.fim && !l.pago)); save(); Fixas(); });
}
function Cartoes() {
  const cur = YM;
  view().innerHTML = `<div class="head"><div><div class="eyebrow">Cartões de crédito</div><h1>Cartões</h1><p class="mut" style="margin:6px 0 0">Compras depois do fechamento vão para a fatura seguinte. Parcelas aparecem em cada mês.</p></div><div class="row">${monthNav()}<button class="btn primary" id="nc">+ Cartão</button></div></div>
  <div class="g3">${S.cartoes.map(c => { const f = faturas(cur).find(x => x.cartaoId === c.id); const usado = S.lancamentos.filter(l => l.cartao === c.id && !(S.faturasPagas || {})[c.id + ':' + faturaYm(c, l.venc)]).reduce((a, l) => a + l.valor, 0);
    return `<div><div class="ccard"><div class="row between"><b style="font-size:18px">${esc(c.nome)}</b><span>${ic('card')}</span></div><div><small>Fatura de ${monthName(cur)}</small><div style="font-size:28px;font-weight:800">${money(f?.valor || 0)}</div><small>fecha dia ${c.fechamento} · vence dia ${c.vencimento}</small></div></div>
      <div class="card pad" style="margin-top:10px"><div class="row between sm"><span>Limite usado</span><b>${money(usado)} de ${money(c.limite)}</b></div><div class="bar ${usado / c.limite > .8 ? 'warn' : ''}"><i style="width:${Math.min(100, usado / c.limite * 100)}%"></i></div>
      <div class="due" style="margin-top:10px">${(f?.itens || []).map(l => `<div class="it" style="grid-template-columns:1fr auto"><div><b class="sm">${esc(l.desc)}</b>${l.parcela ? ` <span class="chip">${l.parcela.n}/${l.parcela.total}</span>` : ''}<div class="mut sm">${fmtD(l.venc)} · ${esc(cat(l.categoria).nome)}</div></div><div class="amt sm">${money(l.valor)}</div></div>`).join('') || '<p class="mut sm">Sem compras nesta fatura.</p>'}</div>
      ${f ? `<div class="row between" style="margin-top:10px">${stBtn(f)}<button class="btn sm" data-buy="${c.id}">+ Compra</button></div>` : `<button class="btn sm" data-buy="${c.id}" style="margin-top:10px">+ Compra</button>`}</div></div>`; }).join('') || '<div class="card pad">Nenhum cartão cadastrado.</div>'}</div>`;
  bindMonth(Cartoes); bindPay();
  $$('[data-buy]').forEach(b => b.onclick = () => { editLanc(null, {}); setTimeout(() => { const f = $('#fL'); f.forma.value = 'c:' + b.dataset.buy; f.forma.onchange(); f.parcelas.value = 1; }, 50); });
  $('#nc').onclick = () => { const md = modal(`<h2 style="margin-bottom:12px">Novo cartão</h2><form id="fC2" class="formgrid"><label class="f full">Nome<input name="nome" required placeholder="Ex.: Cartão Empresa"></label><label class="f">Dia do fechamento<input name="fe" type="number" min="1" max="31" value="25"></label><label class="f">Dia do vencimento<input name="ve" type="number" min="1" max="31" value="5"></label><label class="f full">Limite (R$)<input name="li" value="5.000,00"></label><div class="row full" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Salvar</button></div></form>`, 480); $('[data-x]', md).onclick = closeModal; $('#fC2').onsubmit = e => { e.preventDefault(); const f = e.target; S.cartoes.push({ id: uid(), nome: f.nome.value, fechamento: +f.fe.value, vencimento: +f.ve.value, limite: parseMoney(f.li.value) }); save(); closeModal(); Cartoes(); }; };
}
function Metas() {
  view().innerHTML = `<div class="head"><div><div class="eyebrow">Metas e reservas</div><h1>Metas</h1><p class="mut" style="margin:6px 0 0">Guarde dinheiro para um objetivo e acompanhe quanto falta.</p></div><button class="btn primary" id="nm">+ Meta</button></div>
  <div class="g3">${S.metas.map(m => { const p = m.atual / m.alvo; const falta = Math.max(0, m.alvo - m.atual); const meses = m.prazo ? Math.max(1, (new Date(m.prazo + '-15') - new Date()) / (30.4 * 864e5)) : 0;
    return `<div class="card pad meta-c"><div class="row between"><h3>${esc(m.nome)}</h3><span class="badge ${p >= 1 ? 'b-ok' : 'b-info'}">${Math.round(p * 100)}%</span></div><div class="big">${money(m.atual)}</div><div class="mut sm">de ${money(m.alvo)}${m.prazo ? ` · até ${monthName(m.prazo)}` : ''}</div><div class="bar ok"><i style="width:${Math.min(100, p * 100)}%"></i></div>
      <div class="sm">${p >= 1 ? 'Meta alcançada' : `Faltam <b>${money(falta)}</b>${meses ? ` · guarde cerca de <b>${money(falta / Math.ceil(meses))}</b> por mês` : ''}`}</div><div class="row"><button class="btn sm primary" data-ap="${m.id}">+ Guardar</button><button class="btn sm" data-rt="${m.id}">Retirar</button><button class="link sm mut" data-dm="${m.id}">Excluir</button></div></div>`; }).join('')}</div>`;
  const mv = (id, sgn) => { const m = S.metas.find(x => x.id === id); const md = modal(`<h2 style="margin-bottom:12px">${sgn > 0 ? 'Guardar em' : 'Retirar de'} ${esc(m.nome)}</h2><form id="fA" class="grid"><label class="f">Valor (R$)<input name="v" required inputmode="decimal" placeholder="0,00"></label><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Confirmar</button></div></form>`, 420); $('[data-x]', md).onclick = closeModal; $('#fA').onsubmit = e => { e.preventDefault(); const v = parseMoney(e.target.v.value); m.atual = Math.max(0, m.atual + sgn * v); (m.mov ||= []).push({ data: today(), v: sgn * v, por: who() }); save(); closeModal(); Metas(); }; setTimeout(() => $('#fA').v.focus(), 30); };
  $$('[data-ap]').forEach(b => b.onclick = () => mv(b.dataset.ap, 1)); $$('[data-rt]').forEach(b => b.onclick = () => mv(b.dataset.rt, -1));
  $$('[data-dm]').forEach(b => b.onclick = async () => { if (await confirmBox('Excluir meta?', 'O histórico dela será apagado.', 'Excluir')) { S.metas = S.metas.filter(m => m.id !== b.dataset.dm); save(); Metas(); } });
  $('#nm').onclick = () => { const md = modal(`<h2 style="margin-bottom:12px">Nova meta</h2><form id="fM" class="formgrid"><label class="f full">Nome<input name="n" required placeholder="Ex.: Reserva de emergência"></label><label class="f">Quanto quer juntar (R$)<input name="a" required placeholder="10.000,00"></label><label class="f">Até quando (opcional)<input name="p" type="month"></label><label class="f full">Já tem guardado (R$)<input name="j" value="0"></label><div class="row full" style="justify-content:flex-end"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Criar meta</button></div></form>`, 520); $('[data-x]', md).onclick = closeModal; $('#fM').onsubmit = e => { e.preventDefault(); const f = e.target; S.metas.push({ id: uid(), nome: f.n.value, alvo: parseMoney(f.a.value), atual: parseMoney(f.j.value), prazo: f.p.value || '' }); save(); closeModal(); Metas(); }; };
}
function agrupa(ls, keyFn) { const m = {}; ls.forEach(l => { const k = keyFn(l) || '—'; m[k] = (m[k] || 0) + valorReal(l); }); return Object.entries(m).sort((a, b) => b[1] - a[1]); }
function dadosRelatorio(ym) {
  const r = resumoMes(ym); const cardIt = S.lancamentos.filter(l => l.cartao && faturaYm(cartao(l.cartao), l.venc) === ym);
  const comp = [...r.ls.filter(l => !l.fatura), ...cardIt]; const ent = comp.filter(l => l.tipo === 'entrada'), sai = comp.filter(l => l.tipo === 'saida');
  return { r, comp, ent, sai, catE: agrupa(ent, l => cat(l.categoria).nome), catS: agrupa(sai, l => cat(l.categoria).nome), cen: agrupa(sai, l => centro(l.centro)?.nome), cli: agrupa(ent, l => contato(l.contato)?.nome), forn: agrupa(sai, l => contato(l.contato)?.nome), tE: ent.reduce((a, l) => a + valorReal(l), 0), tS: sai.reduce((a, l) => a + valorReal(l), 0) };
}
function Relatorios() {
  const d = dadosRelatorio(YM); const res = d.tE - d.tS;
  const tab = (t, arr, tot) => `<div class="card pad"><h3 style="margin-bottom:10px">${t}</h3>${arr.length ? arr.map(([k, v]) => `<div class="lim"><div class="row"><span>${esc(k)}</span><span class="amt">${money(v)}</span></div><div class="bar"><i style="width:${tot ? v / tot * 100 : 0}%"></i></div></div>`).join('') : '<p class="mut sm">Sem dados.</p>'}</div>`;
  view().innerHTML = `<div class="head"><div><div class="eyebrow">Relatórios</div><h1>Relatórios</h1><p class="mut" style="margin:6px 0 0">Valores pela competência: conta a data de vencimento ou da compra.</p></div><div class="row">${monthNav()}<button class="btn" id="rx">Excel (CSV)</button><button class="btn" id="rp">Baixar PDF</button><button class="btn primary" id="rs">${ic('upload')} Enviar relatório</button></div></div>
  <div class="g2"><div class="card pad"><h2 style="margin-bottom:10px">${empresa() ? 'Resultado do mês (DRE simplificado)' : 'Resumo do mês'}</h2><table class="dre" style="width:100%;border-collapse:collapse">
    <tr><td><b>${empresa() ? 'Receitas' : 'Entradas'}</b></td><td class="pos amt">${money(d.tE)}</td></tr>${d.catE.map(([k, v]) => `<tr><td class="mut" style="padding-left:24px">${esc(k)}</td><td>${money(v)}</td></tr>`).join('')}
    <tr><td><b>${empresa() ? 'Despesas' : 'Saídas'}</b></td><td class="neg amt">− ${money(d.tS)}</td></tr>${d.catS.map(([k, v]) => `<tr><td class="mut" style="padding-left:24px">${esc(k)}</td><td>${money(v)}</td></tr>`).join('')}
    <tr class="tot"><td>${empresa() ? 'Resultado' : 'Sobrou'}</td><td class="${res < 0 ? 'neg' : 'pos'}">${money(res)}</td></tr>${d.tE ? `<tr><td class="mut">Margem</td><td class="mut">${(res / d.tE * 100).toFixed(1).replace('.', ',')}%</td></tr>` : ''}</table></div>
    ${tab('Para onde foi o dinheiro', d.catS, d.tS)}</div>
  ${empresa() ? `<div class="g3">${tab('Por centro de custo', d.cen, d.tS)}${tab('Receita por cliente', d.cli, d.tE)}${tab('Gasto por fornecedor', d.forn, d.tS)}</div>` : ''}`;
  bindMonth(Relatorios);
  $('#rs').onclick = async () => { const b = $('#rs'); b.disabled = true; try { const r = await enviarRelatorio(YM); if (r) toast(r === 'enviado' ? 'Relatório enviado' : 'Relatório em PDF baixado'); } finally { b.disabled = false; } };
  $('#rx').onclick = () => exportCSV(d.comp, `relatorio-${YM}.csv`);
  $('#rp').onclick = async () => { const b = $('#rp'); b.disabled = true; try { download(await relatorioPDF(YM), `relatorio-${YM}.pdf`, 'application/pdf'); toast('Relatório em PDF baixado'); } finally { b.disabled = false; } };
}
async function relatorioPDF(ym) {
  const d = dadosRelatorio(ym); const pdf = await PDFDocument.create(); const F = await pdf.embedFont(StandardFonts.Helvetica), B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, L = 48, R = W - 48; const ink = rgb(.08, .07, .04), mut = rgb(.42, .4, .36), gold = rgb(.886, .706, .329), green = rgb(.12, .54, .36), red = rgb(.76, .25, .18), line = rgb(.88, .86, .8);
  const T = s => winSafe(s); const m = v => winSafe(money(v)).replace(/ /g, ' ');
  let p, y; const newPage = () => { p = pdf.addPage([W, H]); p.drawRectangle({ x: 0, y: H - 74, width: W, height: 74, color: ink }); p.drawRectangle({ x: 0, y: H - 78, width: W, height: 4, color: gold }); p.drawText('ECD Finanças', { x: L, y: H - 38, size: 16, font: B, color: rgb(1, 1, 1) }); p.drawText(T(`${S.nome} · Relatório de ${monthName(ym)}`), { x: L, y: H - 56, size: 9.5, font: F, color: rgb(.85, .8, .7) }); p.drawText(T(`Gerado em ${new Date().toLocaleString('pt-BR')} por ${me()?.nome || ''}`), { x: L, y: 26, size: 7.5, font: F, color: mut }); y = H - 110; };
  const right = (t, x, yy, sz, f, c) => p.drawText(t, { x: x - f.widthOfTextAtSize(t, sz), y: yy, size: sz, font: f, color: c });
  const h2 = t => { if (y < 120) newPage(); p.drawText(T(t), { x: L, y, size: 12, font: B, color: ink }); y -= 6; p.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: .8, color: gold }); y -= 18; };
  const rowL = (k, v, opt = {}) => { if (y < 60) newPage(); p.drawText(T(k), { x: L + (opt.ind ? 14 : 0), y, size: opt.sz || 9.5, font: opt.b ? B : F, color: opt.c || ink }); right(v, R, y, opt.sz || 9.5, opt.b ? B : F, opt.c || ink); y -= (opt.sz || 9.5) * 1.6; };
  newPage();
  const kp = [['Entradas', d.tE, green], ['Saídas', d.tS, red], [empresa() ? 'Resultado' : 'Sobrou', d.tE - d.tS, d.tE - d.tS < 0 ? red : ink], ['Saldo no fim do mês', previsto(ym), ink]];
  kp.forEach(([k, v, c], i) => { const x = L + i * ((R - L) / 4); p.drawRectangle({ x, y: y - 34, width: (R - L) / 4 - 8, height: 48, borderColor: line, borderWidth: .8 }); p.drawText(T(k.toUpperCase()), { x: x + 8, y: y, size: 7, font: B, color: mut }); p.drawText(m(v), { x: x + 8, y: y - 22, size: 12, font: B, color: c }); }); y -= 70;
  h2(empresa() ? 'Resultado do mês (DRE simplificado)' : 'Resumo do mês');
  rowL(empresa() ? 'Receitas' : 'Entradas', m(d.tE), { b: true, c: green }); d.catE.forEach(([k, v]) => rowL(k, m(v), { ind: true, c: mut }));
  rowL(empresa() ? 'Despesas' : 'Saídas', '- ' + m(d.tS), { b: true, c: red }); d.catS.forEach(([k, v]) => rowL(k, m(v), { ind: true, c: mut }));
  p.drawLine({ start: { x: L, y: y + 8 }, end: { x: R, y: y + 8 }, thickness: 1, color: ink }); rowL(empresa() ? 'Resultado' : 'Sobrou', m(d.tE - d.tS), { b: true, sz: 11 }); y -= 10;
  if (empresa()) { h2('Receita por cliente'); d.cli.forEach(([k, v]) => rowL(k, m(v))); y -= 6; h2('Gasto por centro de custo'); d.cen.forEach(([k, v]) => rowL(k, m(v))); y -= 6; }
  h2('Lançamentos do mês');
  d.comp.sort((a, b) => a.venc.localeCompare(b.venc)).forEach(l => { if (y < 60) newPage(); p.drawText(T(fmtD(l.venc)), { x: L, y, size: 8.5, font: F, color: mut }); let t = T(l.desc + (l.parcela ? ` (${l.parcela.n}/${l.parcela.total})` : '')); while (F.widthOfTextAtSize(t, 8.5) > 250) t = t.slice(0, -2); p.drawText(t, { x: L + 62, y, size: 8.5, font: F, color: ink }); p.drawText(T(cat(l.categoria).nome), { x: L + 320, y, size: 8, font: F, color: mut }); p.drawText(T(statusOf(l)[1]), { x: L + 410, y, size: 8, font: F, color: mut }); right((l.tipo === 'entrada' ? '+ ' : '- ') + m(valorReal(l)), R, y, 8.5, B, l.tipo === 'entrada' ? green : ink); y -= 13; });
  return pdf.save();
}
/* ---------------- importar extrato ---------------- */
function parseOFX(txt) {
  return [...txt.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>)/gi)].map(m => { const b = m[1]; const g = t => (b.match(new RegExp('<' + t + '>([^<\\r\\n]*)', 'i')) || [, ''])[1].trim(); const amt = parseFloat(g('TRNAMT').replace(',', '.')); const dt = g('DTPOSTED'); return { data: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`, desc: g('MEMO') || g('NAME'), valor: Math.abs(amt), tipo: amt >= 0 ? 'entrada' : 'saida' }; }).filter(x => x.valor && /^\d{4}-\d{2}-\d{2}$/.test(x.data));
}
function parseCSV(txt) {
  const lines = txt.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim()); if (!lines.length) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(s => s.trim()); };
  const head = split(lines[0]).map(norm); const hasHead = head.some(h => /data|descr|hist|valor|lanc/.test(h));
  const iD = hasHead ? head.findIndex(h => /data/.test(h)) : 0, iT = hasHead ? head.findIndex(h => /descr|hist|lanc|memo/.test(h)) : 1, iV = hasHead ? head.findIndex(h => /valor|quantia|montante/.test(h)) : 2;
  return lines.slice(hasHead ? 1 : 0).map(l => { const c = split(l); const ds = c[iD] || ''; const m = ds.match(/(\d{2})\/(\d{2})\/(\d{4})/) || ds.match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return null; const data = m[0].includes('/') ? `${m[3]}-${m[2]}-${m[1]}` : m[0]; const v = parseMoney(c[iV]); return { data, desc: c[iT] || 'Sem descrição', valor: Math.abs(v), tipo: v >= 0 ? 'entrada' : 'saida' }; }).filter(x => x && x.valor);
}
let IMP = null;
function Importar() {
  view().innerHTML = `<div class="head"><div><div class="eyebrow">Importar extrato</div><h1>Importar extrato</h1><p class="mut" style="margin:6px 0 0">Envie o extrato em <b>OFX</b> ou <b>CSV</b>, que todo banco permite baixar. As categorias são escolhidas pelas suas regras e você confere antes de importar.</p></div></div>
  <div class="card pad"><label class="drop" style="display:block"><b>Escolher arquivo do extrato</b><br><span class="mut sm">.ofx ou .csv</span><input type="file" id="fx" accept=".ofx,.csv,.txt" hidden></label>
  <div class="row" style="margin-top:12px"><button class="btn sm" id="ex">Usar um extrato de exemplo</button><a class="sm" href="#/ajustes">Ver regras de categoria →</a></div></div><div id="impArea" style="margin-top:16px"></div>`;
  const show = (items, nome) => {
    const dup = it => S.lancamentos.some(l => l.valor === it.valor && (l.pago?.data === it.data || l.venc === it.data) && l.tipo === it.tipo);
    IMP = items.map(it => ({ ...it, categoria: autoCategoria(it.desc, it.tipo), skip: dup(it), dup: dup(it) }));
    const draw = () => { $('#impArea').innerHTML = `<div class="card" style="overflow:auto"><div class="pad row between"><div><h2>${esc(nome)}</h2><p class="mut sm" style="margin:2px 0 0">${IMP.length} movimentos · ${IMP.filter(i => i.dup).length} parecem já lançados (desmarcados)</p></div><button class="btn primary" id="doImp">Importar ${IMP.filter(i => !i.skip).length} movimentos</button></div>
      <table class="imp-t" style="width:100%;border-collapse:collapse"><tr class="mut sm"><td></td><td>Data</td><td>Descrição</td><td>Categoria</td><td style="text-align:right">Valor</td></tr>${IMP.map((it, k) => `<tr style="${it.skip ? 'opacity:.45' : ''}"><td><input type="checkbox" data-k="${k}" ${it.skip ? '' : 'checked'}></td><td>${fmtD(it.data)}</td><td>${esc(it.desc)}${it.dup ? ' <span class="chip">já existe?</span>' : ''}</td><td><select data-c="${k}">${catOpts(it.tipo, it.categoria)}</select></td><td style="text-align:right" class="amt ${it.tipo === 'entrada' ? 'pos' : ''}">${it.tipo === 'entrada' ? '+' : '−'} ${money(it.valor)}</td></tr>`).join('')}</table></div>`;
      $$('[data-k]').forEach(c => c.onchange = () => { IMP[+c.dataset.k].skip = !c.checked; draw(); }); $$('[data-c]').forEach(s => s.onchange = () => IMP[+s.dataset.c].categoria = s.value);
      $('#doImp').onclick = () => { const ok = IMP.filter(i => !i.skip); ok.forEach(it => S.lancamentos.push({ id: uid(), desc: it.desc, tipo: it.tipo, valor: it.valor, venc: it.data, categoria: it.categoria, contato: '', centro: '', pago: { data: it.data, valor: it.valor, por: 'Extrato' }, por: who(), obs: 'Importado do extrato' })); save(); toast(`${ok.length} movimentos importados como pagos`); YM = ymOf(ok[0]?.data || today()); location.hash = '#/lancamentos'; };
    }; draw();
  };
  $('#fx').onchange = async e => { const f = e.target.files[0]; if (!f) return; const txt = await f.text(); const items = /<OFX>|<STMTTRN>/i.test(txt) ? parseOFX(txt) : parseCSV(txt); if (!items.length) return toast('Não encontrei movimentos nesse arquivo'); show(items, f.name); };
  $('#ex').onclick = () => { const ym = ymOf(today()); const t = (d, desc, v) => `${dayIn(ym, d).split('-').reverse().join('/')};${desc};${String(v.toFixed(2)).replace('.', ',')}`; show(parseCSV(['Data;Descrição;Valor', t(2, 'PIX RECEBIDO CLIENTE NOVA ERA', 1850), t(3, 'POSTO SHELL AV CENTRAL', -230.5), t(4, 'UBER *TRIP', -38.9), t(6, 'GOOGLE WORKSPACE', -59), t(8, 'MERCADO ATACADO BOM', -412.3), t(9, 'TARIFA PACOTE SERVICOS', -49.9)].join('\n')), 'extrato-exemplo.csv'); };
}
/* ---------------- ajustes ---------------- */
function Ajustes() {
  const tagList = (arr, key, extra = () => '') => `<div class="row" style="gap:8px">${arr.map(x => `<span class="tagx">${esc(x.nome)}${extra(x)}<button data-rm="${key}:${x.id}">✕</button></span>`).join('')}</div>`;
  view().innerHTML = `<div class="head"><div><div class="eyebrow">Ajustes</div><h1>Ajustes</h1></div>${me()?.role === 'admin' ? '<a class="btn" href="#/config">Usuários, cadastro e convites →</a>' : ''}</div>
  <div class="g2"><div class="grid">
    <div class="card pad grid"><h2>Geral</h2><div class="formgrid"><label class="f">Nome<input id="aN" value="${esc(S.nome)}"></label><label class="f">Modo<select id="aM"><option value="empresa" ${empresa() ? 'selected' : ''}>Empresa (clientes, fornecedores e centro de custo)</option><option value="pessoal" ${!empresa() ? 'selected' : ''}>Pessoal / família</option></select></label>
      <label class="f">Saldo inicial (R$)<input id="aS" value="${String(S.saldoInicial.valor.toFixed(2)).replace('.', ',')}"></label><label class="f">A partir de<input id="aD" type="date" value="${S.saldoInicial.data}"></label></div><p class="hint" style="margin:0">Todas as pessoas com acesso veem e lançam no mesmo caixa. Cada lançamento mostra quem fez.</p></div>
    <div class="card pad grid"><h2>Categorias e limites</h2><p class="hint" style="margin:-6px 0 0">Coloque um limite mensal nas despesas para receber o aviso de 80%.</p>
      <table class="items"><thead><tr><th>Categoria</th><th>Tipo</th><th>Limite por mês</th><th></th></tr></thead><tbody>${S.categorias.map(c => `<tr><td><input data-cn="${c.id}" value="${esc(c.nome)}"></td><td class="sm">${c.tipo === 'entrada' ? 'Entrada' : 'Saída'}</td><td>${c.tipo === 'saida' ? `<input data-cl="${c.id}" value="${c.limite ? String(c.limite).replace('.', ',') : ''}" placeholder="sem limite">` : ''}</td><td><button class="link" data-rm="categorias:${c.id}">✕</button></td></tr>`).join('')}</tbody></table>
      <form id="fCat" class="row"><input class="search" name="n" placeholder="Nova categoria" required><select class="sel" name="t"><option value="saida">Saída</option><option value="entrada">Entrada</option></select><button class="btn sm">+ Adicionar</button></form></div>
  </div><div class="grid">
    <div class="card pad grid"><h2>Relatório do fim do mês</h2><p class="hint" style="margin:-6px 0 0">No último dia do mês, e na primeira vez que você abrir o sistema no mês seguinte, o relatório do mês aparece pronto para enviar por WhatsApp, e-mail ou baixar em PDF.</p><label style="display:flex;gap:10px;align-items:center;font-weight:600"><input type="checkbox" id="aFech" ${fech().auto !== false ? 'checked' : ''}> Preparar o relatório todo fim de mês</label>${Object.keys(fech().enviados).length ? `<div class="due">${Object.entries(fech().enviados).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6).map(([ym, dt]) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><span><b>${monthName(ym)}</b><br><small class="mut">enviado em ${fmtD(dt)}</small></span><button class="btn sm" data-fm="${ym}">Enviar de novo</button></div>`).join('')}</div>` : ''}</div>
    <div class="card pad grid"><h2>${S.real ? 'Recomeçar' : 'Usar com o meu dinheiro'}</h2><p class="hint" style="margin:-6px 0 0">${S.real ? 'Apaga todos os lançamentos, cartões e metas deste aparelho e começa de novo.' : 'Apaga os dados de exemplo e começa do zero com categorias pessoais.'}</p><button class="btn ${S.real ? '' : 'primary'}" id="aZero" style="justify-self:start">${S.real ? 'Apagar tudo e recomeçar' : 'Começar do zero'}</button></div>
    <div class="card pad grid"><h2>Regras de categoria</h2><p class="hint" style="margin:-6px 0 0">Quando a descrição tiver o texto, a categoria é escolhida sozinha (no lançamento e na importação do extrato).</p>
      ${S.regras.map((r, k) => `<div class="row between sm"><span>Contém <b>“${esc(r.contem)}”</b> → ${esc(cat(r.categoria).nome)}</span><button class="link" data-rr="${k}">✕</button></div>`).join('')}
      <form id="fRg" class="row"><input class="search" name="c" placeholder="Texto (ex.: uber)" required style="min-width:120px"><select class="sel" name="k">${S.categorias.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')}</select><button class="btn sm">+ Regra</button></form></div>
    ${empresa() ? `<div class="card pad grid"><h2>Clientes e fornecedores</h2>${tagList(S.contatos, 'contatos', x => ` <span class="mut sm">${x.tipo}</span>`)}<form id="fK" class="row"><input class="search" name="n" placeholder="Nome" required><select class="sel" name="t"><option value="cliente">cliente</option><option value="fornecedor">fornecedor</option></select><button class="btn sm">+</button></form></div>
    <div class="card pad grid"><h2>Centros de custo</h2>${tagList(S.centros, 'centros')}<form id="fCc" class="row"><input class="search" name="n" placeholder="Ex.: Obra Centro, Administrativo" required><button class="btn sm">+</button></form></div>` : ''}
  </div></div>`;
  $('#aFech').onchange = e => { fech().auto = e.target.checked; save(); toast(e.target.checked ? 'Relatório do fim do mês ligado' : 'Relatório do fim do mês desligado'); };
  $$('[data-fm]').forEach(b => b.onclick = async () => { const r = await enviarRelatorio(b.dataset.fm); if (r) toast(r === 'enviado' ? 'Relatório enviado' : 'Relatório em PDF baixado'); });
  $('#aZero').onclick = async () => { if (!(await confirmBox(S.real ? 'Apagar tudo?' : 'Começar do zero?', S.real ? 'Todos os seus lançamentos, cartões e metas deste aparelho serão apagados. Não dá para desfazer.' : 'Os dados de exemplo serão apagados e você começa com categorias pessoais.', S.real ? 'Apagar tudo' : 'Começar do zero'))) return; await startBlank(); toast('Tudo pronto para começar'); };
  $('#aN').onchange = e => { S.nome = e.target.value; save(); }; $('#aM').onchange = e => { S.modo = e.target.value; save(); Ajustes(); toast(empresa() ? 'Modo empresa' : 'Modo pessoal'); };
  $('#aS').onchange = e => { S.saldoInicial.valor = parseMoney(e.target.value); save(); }; $('#aD').onchange = e => { S.saldoInicial.data = e.target.value; save(); };
  $$('[data-cn]').forEach(i => i.onchange = () => { S.categorias.find(c => c.id === i.dataset.cn).nome = i.value; save(); });
  $$('[data-cl]').forEach(i => i.onchange = () => { S.categorias.find(c => c.id === i.dataset.cl).limite = parseMoney(i.value) || 0; save(); toast('Limite salvo'); });
  $$('[data-rm]').forEach(b => b.onclick = () => { const [k, id] = b.dataset.rm.split(':'); S[k] = S[k].filter(x => x.id !== id); save(); Ajustes(); });
  $$('[data-rr]').forEach(b => b.onclick = () => { S.regras.splice(+b.dataset.rr, 1); save(); Ajustes(); });
  $('#fCat').onsubmit = e => { e.preventDefault(); S.categorias.push({ id: uid(), nome: e.target.n.value, tipo: e.target.t.value }); save(); Ajustes(); };
  $('#fRg').onsubmit = e => { e.preventDefault(); S.regras.push({ contem: e.target.c.value.trim(), categoria: e.target.k.value }); save(); Ajustes(); };
  const fk = $('#fK'); if (fk) fk.onsubmit = e => { e.preventDefault(); S.contatos.push({ id: uid(), nome: e.target.n.value, tipo: e.target.t.value }); save(); Ajustes(); };
  const fc = $('#fCc'); if (fc) fc.onsubmit = e => { e.preventDefault(); S.centros.push({ id: uid(), nome: e.target.n.value }); save(); Ajustes(); };
}

/* ---------------- exemplos fictícios ---------------- */
function seedState() {
  const C = (nome, tipo, limite = 0) => ({ id: uid(), nome, tipo, limite });
  const cats = { serv: C('Serviços prestados', 'entrada'), venda: C('Venda de produtos', 'entrada'), outrE: C('Outras entradas', 'entrada'), alug: C('Aluguel', 'saida'), folha: C('Folha de pagamento', 'saida'), forn: C('Fornecedores e materiais', 'saida', 6000), imp: C('Impostos', 'saida'), ener: C('Energia e água', 'saida', 900), net: C('Internet e sistemas', 'saida', 400), comb: C('Combustível e transporte', 'saida', 1200), mkt: C('Marketing', 'saida', 800), manut: C('Manutenção', 'saida', 700), tarifa: C('Tarifas bancárias', 'saida'), outrS: C('Outras saídas', 'saida') };
  const K = (nome, tipo) => ({ id: uid(), nome, tipo });
  const ct = { a: K('Condomínio Nova Era', 'cliente'), b: K('Mercado Bom Preço', 'cliente'), c: K('Clínica Vida Plena', 'cliente'), d: K('Distribuidora Alfa', 'fornecedor'), e: K('Imobiliária Centro', 'fornecedor'), f: K('Auto Posto Avenida', 'fornecedor') };
  const cc = { adm: { id: uid(), nome: 'Administrativo' }, obra: { id: uid(), nome: 'Obras e campo' }, com: { id: uid(), nome: 'Comercial' } };
  const card = { id: uid(), nome: 'Cartão Empresa', fechamento: 25, vencimento: 5, limite: 8000 };
  const R = (desc, tipo, valor, dia, categoria, extra = {}) => ({ id: uid(), desc, tipo, valor, dia, categoria, inicio: '', ...extra });
  const pro = R('Pró-labore / salários', 'saida', 7200, 5, cats.folha.id, { centro: cc.adm.id });
  const recs = [R('Contrato de manutenção', 'entrada', 4800, 10, cats.serv.id, { contato: ct.a.id, centro: cc.obra.id }), R('Contrato mensal', 'entrada', 3200, 15, cats.serv.id, { contato: ct.b.id, centro: cc.obra.id }), R('Aluguel do galpão', 'saida', 2600, 10, cats.alug.id, { contato: ct.e.id, centro: cc.adm.id }), pro, R('Simples Nacional', 'saida', 1180, 20, cats.imp.id, { centro: cc.adm.id }), R('Internet e sistemas', 'saida', 289, 12, cats.net.id, { centro: cc.adm.id }), R('Energia e água', 'saida', 640, 18, cats.ener.id, { centro: cc.adm.id })];
  const st = { v: 3, modo: 'empresa', nome: 'Construtora Exemplo Ltda', saldoInicial: { valor: 18500, data: '' }, categorias: Object.values(cats), contatos: Object.values(ct), centros: Object.values(cc), cartoes: [card], recorrentes: recs, gerados: [], lancamentos: [], metas: [], regras: [{ contem: 'posto', categoria: cats.comb.id }, { contem: 'uber', categoria: cats.comb.id }, { contem: 'google', categoria: cats.net.id }, { contem: 'tarifa', categoria: cats.tarifa.id }, { contem: 'mercado', categoria: cats.forn.id }, { contem: 'pix recebido', categoria: cats.outrE.id }], faturasPagas: {} };
  const cur = ymOf(today()); const t = today(); let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  st.saldoInicial.data = dayIn(addMonths(cur, -6), 1); recs.forEach(r => r.inicio = addMonths(cur, -6));
  S = st;
  for (let i = -6; i <= 2; i++) ensureMonth(addMonths(cur, i));
  const L = (desc, tipo, valor, venc, categoria, x = {}) => S.lancamentos.push({ id: uid(), desc, tipo, valor: Math.round(valor * 100) / 100, venc, categoria, contato: '', centro: '', pago: null, por: 'Eduardo', ...x });
  for (let i = -6; i <= 0; i++) {
    const ym = addMonths(cur, i);
    L('Obra de reforma · etapa', 'entrada', 7800 + rnd() * 4200, dayIn(ym, 22), cats.serv.id, { contato: ct.c.id, centro: cc.obra.id });
    L('Venda de materiais', 'entrada', 1600 + rnd() * 1500, dayIn(ym, 26), cats.venda.id, { centro: cc.com.id });
    L('Materiais de obra', 'saida', 3200 + rnd() * 2600, dayIn(ym, 8), cats.forn.id, { contato: ct.d.id, centro: cc.obra.id });
    L('Combustível da equipe', 'saida', 650 + rnd() * 420, dayIn(ym, 14), cats.comb.id, { contato: ct.f.id, centro: cc.obra.id });
    L('Anúncios online', 'saida', 300 + rnd() * 350, dayIn(ym, 3), cats.mkt.id, { centro: cc.com.id, cartao: card.id });
    L('Ferramentas e EPIs', 'saida', 180 + rnd() * 260, dayIn(ym, 19), cats.manut.id, { centro: cc.obra.id, cartao: card.id });
  }
  L('Notebook para o escritório', 'saida', 450, dayIn(addMonths(cur, -2), 12), cats.outrS.id, { centro: cc.adm.id, cartao: card.id, parcela: { n: 1, total: 10, grupo: 'nb' } });
  for (let n = 2; n <= 10; n++) L('Notebook para o escritório', 'saida', 450, dayIn(addMonths(cur, n - 3), 12), cats.outrS.id, { centro: cc.adm.id, cartao: card.id, parcela: { n, total: 10, grupo: 'nb' } });
  L('Serviço extra · pintura', 'entrada', 2400, dayIn(addMonths(cur, 1), 8), cats.serv.id, { contato: ct.a.id, centro: cc.obra.id });
  // pagos até ontem; alguns do mês atual ficam pendentes/atrasados
  const ontem = iso(new Date(Date.now() - 864e5));
  S.lancamentos.forEach(l => { if (l.cartao) return; if (l.venc < t && !(ymOf(l.venc) === cur && /Simples|Combustível/.test(l.desc))) l.pago = { data: l.venc, valor: l.desc.includes('Energia') ? Math.round(l.valor * (0.9 + rnd() * .25)) : l.valor, por: 'Eduardo' }; });
  S.cartoes.forEach(c => { for (let i = -6; i <= 0; i++) { const ym = addMonths(cur, i); const venc = dayIn(ym, c.vencimento); if (venc < t) { const f = faturas(ym).find(x => x.cartaoId === c.id); if (f) S.faturasPagas[c.id + ':' + ym] = { data: venc, valor: f.valor, por: 'Eduardo' }; } } });
  S.metas = [{ id: uid(), nome: 'Reserva de 3 meses de custos', alvo: 45000, atual: 21800, prazo: addMonths(cur, 10) }, { id: uid(), nome: 'Nova betoneira', alvo: 6500, atual: 4100, prazo: addMonths(cur, 3) }];
  void ontem;
}

/* ---------------- começar do zero (dados reais) ---------------- */
function blankState() {
  const C = (nome, tipo) => ({ id: uid(), nome, tipo, limite: 0 });
  const cats = [C('Salário', 'entrada'), C('Freelas e extras', 'entrada'), C('Outras entradas', 'entrada'), C('Moradia', 'saida'), C('Mercado e alimentação', 'saida'), C('Transporte', 'saida'), C('Contas da casa (luz, água, internet)', 'saida'), C('Celular e assinaturas', 'saida'), C('Saúde', 'saida'), C('Educação', 'saida'), C('Lazer', 'saida'), C('Compras', 'saida'), C('Outras saídas', 'saida')];
  const g = n => cats.find(c => c.nome.startsWith(n)).id;
  S = { v: 3, real: true, modo: 'pessoal', nome: me()?.nome || 'Minhas finanças', saldoInicial: { valor: 0, data: dayIn(ymOf(today()), 1) }, categorias: cats, contatos: [], centros: [], cartoes: [], recorrentes: [], gerados: [], lancamentos: [], metas: [], regras: [{ contem: 'uber', categoria: g('Transporte') }, { contem: 'ifood', categoria: g('Mercado') }, { contem: 'netflix', categoria: g('Celular') }, { contem: 'spotify', categoria: g('Celular') }], faturasPagas: {} };
}
async function startBlank() { blankState(); await idb('kv', 'readwrite', s => s.put(S, 'state')); YM = ymOf(today()); demoBar(); location.hash = '#/'; route(); }
window.__ecdHasRealData = () => !!S?.real;
const demoBar = () => { const b = $('.demo-bar'); const r = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0]; if (b) b.hidden = !!S?.real || (me() && !me().demo) || AUTH_ROUTES.includes(r) || r === 'comecar'; };
function welcomeModal() {
  const md = modal(`<div class="eyebrow">Acesso liberado</div><h2 style="margin:4px 0 8px">Bem-vindo ao ECD Finanças, ${esc(me().nome.split(' ')[0])}!</h2><p class="mut" style="margin:0 0 18px">Como você quer começar?</p>
    <div class="grid"><button class="btn primary" id="wZero" style="justify-content:flex-start;text-align:left;padding:14px 16px"><span><b>Começar do zero com o meu dinheiro</b><br><small style="opacity:.8">Apaga os exemplos e cria categorias pessoais prontas</small></span></button>
    <button class="btn" id="wDemo" style="justify-content:flex-start;text-align:left;padding:14px 16px"><span><b>Explorar os exemplos primeiro</b><br><small class="mut">Você pode zerar depois em Ajustes</small></span></button></div><p style="margin:16px 0 0"><a href="#/comecar" style="color:var(--ink2);font-weight:600">Ver o passo a passo do primeiro acesso</a></p>`, 520);
  $('#wZero', md).onclick = async () => { closeModal(); await startBlank(); toast('Pronto! Comece lançando seu saldo em Ajustes ou o primeiro gasto em + Lançamento'); };
  $('#wDemo', md).onclick = closeModal;
}

/* ---------------- primeiro acesso: passo a passo ---------------- */
const GUIA = [
  ['Entrar no sistema', [
    ['Instale o app no celular', 'Assim o ECD Finanças fica na tela inicial, como um aplicativo. No Android (Chrome): menu ⋮ e "Instalar app". No iPhone (Safari): botão Compartilhar e "Adicionar à Tela de Início".', 'instalar'],
    ['Crie sua conta', 'Na tela de entrada, toque em "Criar conta" e informe nome, e-mail e uma senha.'],
    ['Complete o cadastro', 'Preencha setor e WhatsApp (e as perguntas extras, se houver) e toque em "Enviar para aprovação".'],
    ['Aguarde a liberação', 'O administrador recebe o pedido e libera o acesso. Enquanto isso, a tela mostra que o cadastro está em análise. Depois de liberado, entre de novo com e-mail e senha.'],
  ]],
  ['Preparar o sistema', [
    ['Escolha como começar', '"Começar do zero com o meu dinheiro" apaga os exemplos e cria categorias prontas. "Explorar os exemplos primeiro" mostra dados fictícios, que podem ser apagados depois em Ajustes.'],
    ['Informe o saldo inicial', 'Em Ajustes, coloque quanto você tem hoje nas contas. Essa é a base do fluxo de caixa.'],
    ['Revise as categorias', 'Em Ajustes, renomeie as categorias e defina um limite mensal naquelas que quiser acompanhar.'],
  ]],
  ['Uso do dia a dia', [
    ['Lance entradas e saídas', 'Toque em "+ Lançamento", escolha entrada ou saída, valor, data e categoria. Se o dinheiro já entrou ou saiu, marque a opção de já pago ou recebido.'],
    ['Anexe o comprovante', 'No topo do lançamento, envie o PDF ou a foto do Pix, da transferência ou do boleto. O sistema preenche tipo, valor, data, contraparte e categoria. Confira e salve.'],
    ['Crie itens na hora', 'Em qualquer lista (categoria, cliente, fornecedor, centro de custo), escolha "+ Nova…", digite o nome e toque em Adicionar.'],
    ['Cadastre o que se repete', 'Em Contas fixas, coloque aluguel, internet, salário e outras contas que se repetem todo mês. Elas aparecem sozinhas nos meses seguintes.'],
    ['Acompanhe cartões e metas', 'Cartões mostra a fatura de cada mês. Metas separa dinheiro para um objetivo, com valor e prazo.'],
    ['Importe o extrato e gere relatórios', 'Em Importar extrato, envie o arquivo do banco para lançar várias movimentações de uma vez. Em Relatórios, baixe o resumo do mês em PDF ou em Excel.'],
  ]],
];
function Comecar() {
  const P = GUIA.flatMap(([bloco, passos]) => passos.map(([t, d, acao]) => ({ bloco, t, d, acao })));
  let i = Math.min(Math.max(+(location.hash.split('?p=')[1] || 1) - 1, 0), P.length - 1);
  const draw = () => {
    const p = P[i], fim = i === P.length - 1;
    view().innerHTML = `
      <div class="wiz card">
        <div class="wiz-top"><span class="eyebrow" style="margin:0">Primeiro acesso · ${esc(p.bloco)}</span><span class="mut sm">Passo ${i + 1} de ${P.length}</span></div>
        <div class="bar"><i style="width:${((i + 1) / P.length) * 100}%;background:var(--gold);display:block;height:100%"></i></div>
        <div class="wiz-body">
          <span class="wiz-n">${i + 1}</span>
          <h1>${esc(p.t)}</h1>
          <p>${esc(p.d)}</p>
          ${p.acao === 'instalar' && !isStandalone() ? `<button class="btn" id="wzInst" style="align-self:flex-start">${ic('upload')} Instalar agora</button>` : p.acao === 'instalar' ? '<p class="pos" style="font-weight:700">O app já está instalado neste aparelho.</p>' : ''}
        </div>
        <div class="wiz-dots">${P.map((_, k) => `<button data-k="${k}" class="${k === i ? 'on' : k < i ? 'ok' : ''}" aria-label="Ir para o passo ${k + 1}"></button>`).join('')}</div>
        <div class="wiz-nav">
          <button class="btn" id="wzBack" ${i === 0 ? 'disabled' : ''}>Voltar</button>
          ${fim ? `<a class="btn primary" href="${me() ? '#/' : '#/entrar'}">${me() ? 'Começar a usar' : 'Ir para a entrada'}</a>` : `<button class="btn primary" id="wzNext">Próximo</button>`}
        </div>
      </div>
      <p class="mut sm" style="text-align:center;margin-top:14px">Dúvidas sobre o acesso? Fale com o administrador do sistema.</p>`;
    const go = k => { i = Math.min(Math.max(k, 0), P.length - 1); draw(); };
    $('#wzBack').onclick = () => go(i - 1);
    if ($('#wzNext')) $('#wzNext').onclick = () => go(i + 1);
    if ($('#wzInst')) $('#wzInst').onclick = instalar;
    $$('.wiz-dots button').forEach(b => b.onclick = () => go(+b.dataset.k));
    document.onkeydown = e => { if (!$('.wiz')) { document.onkeydown = null; return; } if (e.key === 'ArrowRight') go(i + 1); if (e.key === 'ArrowLeft') go(i - 1); };
  };
  draw();
}

/* ---------------- fechamento do mês: relatório pronto para enviar ---------------- */
const fech = () => (S.fechamento ||= { auto: true, enviados: {} });
function mesParaFechar() {
  if (!me() || !S || fech().auto === false) return null;
  const cur = ymOf(today());
  const cands = new Date().getDate() === lastDay(cur) ? [cur, addMonths(cur, -1)] : [addMonths(cur, -1)];
  return cands.find(ym => !fech().enviados[ym] && S.lancamentos.some(l => ymOf(l.venc || '') === ym)) || null;
}
// compartilha o PDF (no celular abre WhatsApp, e-mail etc.); sem suporte, baixa o arquivo
async function enviarRelatorio(ym) {
  const nome = `relatorio-financeiro-${ym}.pdf`;
  const bytes = await relatorioPDF(ym);
  const file = new File([bytes], nome, { type: 'application/pdf' });
  const d = dadosRelatorio(ym);
  const texto = `Relatório financeiro de ${monthName(ym)}\nEntradas: ${money(d.tE)}\nSaídas: ${money(d.tS)}\n${empresa() ? 'Resultado' : 'Sobrou'}: ${money(d.tE - d.tS)}`;
  let modo = 'baixado';
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Relatório de ${monthName(ym)}`, text: texto }); modo = 'enviado'; }
    catch (e) { if (e.name === 'AbortError') return null; download(bytes, nome, 'application/pdf'); }
  } else download(bytes, nome, 'application/pdf');
  fech().enviados[ym] = today(); save();
  return modo;
}
function fechamentoModal(ym) {
  const d = dadosRelatorio(ym), res = d.tE - d.tS, hoje = ym === ymOf(today());
  const md = modal(`<div class="eyebrow">Fechamento do mês</div><h2 style="margin:4px 0 6px">Relatório de ${monthName(ym)}</h2>
    <p class="mut" style="margin:0 0 16px">${hoje ? 'O mês termina hoje.' : 'O mês terminou.'} O relatório em PDF está pronto para enviar.</p>
    <div class="proj" style="margin:0 0 18px"><div><small>Entradas</small><b class="pos">${money(d.tE)}</b></div><div><small>Saídas</small><b class="neg">${money(d.tS)}</b></div><div><small>${empresa() ? 'Resultado' : 'Sobrou'}</small><b class="${res < 0 ? 'neg' : 'pos'}">${money(res)}</b></div></div>
    <div class="grid" style="gap:8px"><button class="btn primary" id="fcShare">${ic('upload')} Enviar relatório</button>
    <div class="row" style="gap:8px"><button class="btn" id="fcPdf" style="flex:1">Baixar PDF</button><button class="btn" id="fcXls" style="flex:1">Baixar Excel</button></div></div>
    <div class="row between" style="margin-top:16px"><button class="link" id="fcDepois">Lembrar depois</button><a href="#/ajustes" class="mut sm">Desligar este aviso</a></div>`, 520);
  const marca = () => { fech().enviados[ym] = today(); save(); };
  $('#fcShare', md).onclick = async e => { const b = e.currentTarget; b.disabled = true; try { const r = await enviarRelatorio(ym); if (r) { closeModal(); toast(r === 'enviado' ? 'Relatório enviado' : 'Relatório em PDF baixado'); } } catch { toast('Não foi possível gerar o relatório'); } finally { b.disabled = false; } };
  $('#fcPdf', md).onclick = async () => { download(await relatorioPDF(ym), `relatorio-financeiro-${ym}.pdf`, 'application/pdf'); marca(); closeModal(); toast('Relatório em PDF baixado'); };
  $('#fcXls', md).onclick = () => { exportCSV(dadosRelatorio(ym).comp, `relatorio-financeiro-${ym}.csv`); marca(); closeModal(); };
  $('#fcDepois', md).onclick = closeModal;
}
function checkFechamento() {
  const ym = mesParaFechar(); if (!ym) return;
  let visto = ''; try { visto = sessionStorage.getItem('ecd-fech') || ''; } catch {}
  if (visto === ym) return;
  try { sessionStorage.setItem('ecd-fech', ym); } catch {}
  fechamentoModal(ym);
}

/* ---------------- instalar como aplicativo ---------------- */
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; toast('App instalado na tela inicial'); });
async function instalar() {
  if (isStandalone()) return toast('O app já está instalado neste aparelho');
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome !== 'accepted') toast('Instalação cancelada'); return; }
  const ios = isIOS();
  const passos = ios
    ? ['Abra este site no <b>Safari</b>.', 'Toque no botão <b>Compartilhar</b> (o quadrado com a seta para cima).', 'Role e toque em <b>Adicionar à Tela de Início</b>.', 'Toque em <b>Adicionar</b>. O ícone da ECD aparece na tela inicial.']
    : ['Abra este site no <b>Chrome</b>.', 'Toque no menu <b>⋮</b> (três pontinhos, no canto de cima).', 'Toque em <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.', 'Confirme. O ícone da ECD aparece na tela inicial.'];
  modal(`<div class="eyebrow">Instalar no celular</div><h2 style="margin:4px 0 14px">${ios ? 'No iPhone' : 'No Android'}</h2>
    <div class="steps">${passos.map((t, k) => `<div class="step"><span class="n">${k + 1}</span><div style="padding-top:6px">${t}</div></div>`).join('')}</div>
    <p class="mut sm" style="margin:12px 0 0">${ios ? 'No Android: Chrome, menu ⋮ e "Instalar app".' : 'No iPhone: Safari, botão Compartilhar e "Adicionar à Tela de Início".'} No computador, use o ícone de instalar na barra de endereço do Chrome ou do Edge.</p>
    <div style="margin-top:18px;text-align:right"><button class="btn primary" id="instOk">Entendi</button></div>`, 480);
  $('#instOk').onclick = closeModal;
}
$('#instFoot').onclick = e => { e.preventDefault(); instalar(); };

/* ---------------- roteador ---------------- */
const ROUTES = { '': Visao, lancamentos: Lancamentos, fixas: Fixas, cartoes: Cartoes, metas: Metas, relatorios: Relatorios, importar: Importar, ajustes: Ajustes, comecar: Comecar };
async function route() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  if (!guard(h[0], ['comecar'])) return;
  const logged = !!me(); document.body.classList.toggle('noside', !logged || AUTH_ROUTES.includes(h[0])); demoBar();
  $$('#sideNav a').forEach(a => a.classList.toggle('on', a.dataset.r === h[0])); $('#modal').hidden = true; window.scrollTo(0, 0);
  try { if (authRoute(h[0])) return; (ROUTES[h[0]] || Visao)(); if (takeWelcome() && !S.real) welcomeModal(); else if (h[0] !== 'comecar') checkFechamento(); } catch (e) { console.error(e); view().innerHTML = `<div class="card pad"><h2>Algo deu errado</h2><p class="mut">${esc(e.message || e)}</p></div>`; }
}
const NAV = [['', 'Visão geral', 'home'], ['lancamentos', 'Lançamentos', 'arrows'], ['fixas', 'Contas fixas', 'repeat'], ['cartoes', 'Cartões', 'card'], ['metas', 'Metas', 'target'], ['relatorios', 'Relatórios', 'file'], ['importar', 'Importar extrato', 'upload'], ['ajustes', 'Ajustes', 'sliders'], ['comecar', 'Como usar', 'book']];
$('#sideNav').innerHTML = NAV.map(([r, l, i]) => `<a href="#/${r}" data-r="${r}">${ic(i)}<span>${l}</span></a>`).join('');
$('#newTop').onclick = () => me() && editLanc();
$('#resetDemo').onclick = async () => { if (!(await confirmBox('Restaurar exemplos?', 'Apaga os lançamentos deste navegador e recoloca os dados fictícios de exemplo.', 'Restaurar'))) return; seedState(); await idb('kv', 'readwrite', s => s.put(S, 'state')); YM = ymOf(today()); location.hash = '#/'; route(); };
window.addEventListener('hashchange', route);
document.addEventListener('ecd-theme', () => { if (S && me()) route(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => { S = await load(); if (!S || S.v !== 3) { seedState(); await idb('kv', 'readwrite', s => s.put(S, 'state')); } route(); })();
