// Leitura automática de comprovantes (Pix, transferência, boleto) — PDF pelo texto, foto por OCR.
// Devolve { tipo: 'entrada'|'saida'|'', valor, data (AAAA-MM-DD), contraparte, meio, desc, texto }.
let pdfjs = null;
async function loadPdf() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}
async function pdfText(file) {
  const lib = await loadPdf();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let out = '';
  for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    // agrupa por linha (y) para manter "rótulo: valor" juntos
    const rows = new Map();
    for (const it of tc.items) { if (!it.str?.trim()) continue; const y = Math.round(it.transform[5] / 3); const r = rows.get(y) || []; r.push(it); rows.set(y, r); }
    out += [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str.trim()).join(' ')).join('\n') + '\n';
  }
  return out;
}
let tess = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function imageText(file) {
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  tess ||= await window.Tesseract.createWorker('por');
  const { data } = await tess.recognize(file);
  return data.text || '';
}

const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const pad = n => String(n).padStart(2, '0');
const strip = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function findDate(t) {
  let m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  m = strip(t).match(/\b(\d{1,2})\s*(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?\s*(?:de\s+)?(\d{4})\b/);
  if (m) return `${m[3]}-${pad(MESES[m[2]])}-${pad(m[1])}`;
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return m[0];
  return '';
}
const money = s => parseFloat(s.replace(/\./g, '').replace(',', '.'));
function findValue(t) {
  const lines = t.split('\n');
  const AMT = /R\$\s*-?\s*([\d.]{1,12},\d{2})/;
  for (const kw of [/valor\s*(?:do\s*pix|pago|da\s*transfer[eê]ncia|total|transferido|recebido|do\s*pagamento)?/i]) {
    for (let i = 0; i < lines.length; i++) if (kw.test(lines[i])) { const m = (lines[i] + ' ' + (lines[i + 1] || '')).match(AMT) || (lines[i] + ' ' + (lines[i + 1] || '')).match(/\b([\d.]{1,12},\d{2})\b/); if (m) return money(m[1]); }
  }
  const all = [...t.matchAll(/R\$\s*-?\s*([\d.]{1,12},\d{2})/g)].map(m => money(m[1]));
  return all.length ? all[0] : 0;
}
// procura o nome que vem depois de um rótulo (na mesma linha ou na seguinte)
const LABEL_STOP = /\bcpf\b|\bcnpj\b|institui|banco|ag[eê]ncia|conta|chave|tipo|valor|data|hor[aá]rio|id\b|autentica|identificador|pix|r\$|\*\*\*|\d{3}\./i;
function nameAfter(t, labels) {
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const l = strip(lines[i]);
    for (const lb of labels) {
      const re = new RegExp(`^(?:${lb})\\b[:\\s]*(.*)$`);
      const m = l.match(re); if (!m) continue;
      const cands = [lines[i].slice(lines[i].length - m[1].length).trim(), ...lines.slice(i + 1, i + 4)];
      for (const c of cands) {
        const v = c.replace(/^nome[:\s]*/i, '').trim();
        if (v && /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.&\-\s]{2,60}$/.test(v) && v.split(/\s+/).length >= 2 && !LABEL_STOP.test(v)) return { nome: v, line: i };
      }
    }
  }
  return null;
}
const titleCase = s => s.toLowerCase().replace(/(^|\s)(\S)/g, (a, b, c) => b + c.toUpperCase()).replace(/\b(De|Da|Do|Dos|Das|E)\b/g, w => w.toLowerCase()).replace(/\b(Ltda|Me|Eireli|S\.?a\.?)\b/gi, w => w.toUpperCase());

export function parseComprovante(text, userName = '') {
  const t = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const s = strip(t);
  const meio = /\bpix\b/.test(s) ? 'Pix' : /boleto|codigo de barras/.test(s) ? 'Boleto' : /\bted\b|\bdoc\b|transferencia/.test(s) ? 'Transferência' : /cartao|credito|debito/.test(s) ? 'Cartão' : '';
  const dest = nameAfter(t, ['destino', 'para', 'quem recebeu', 'recebedor', 'dados do recebedor', 'favorecido', 'beneficiario', 'dados do favorecido', 'destinatario', 'pago a', 'enviado para']);
  const orig = nameAfter(t, ['origem', 'de', 'quem pagou', 'pagador', 'dados do pagador', 'remetente', 'enviado por', 'recebido de']);
  const me = strip(userName).split(/\s+/).filter(w => w.length > 2);
  const isMe = n => n && me.length && me.filter(w => strip(n).includes(w)).length >= Math.min(2, me.length);
  let tipo = '';
  if (/(pix|transferencia|ted|valor)\s+recebid|voce recebeu|recebimento de pix|credito em conta|entrada de pix/.test(s)) tipo = 'entrada';
  else if (/(pix|transferencia|ted)\s+(enviad|realizad|efetuad)|voce (enviou|pagou|transferiu)|comprovante de pagamento|pagamento (efetuado|realizado)|boleto pago|debito em conta|saida de pix/.test(s)) tipo = 'saida';
  if (isMe(dest?.nome) && !isMe(orig?.nome)) tipo = 'entrada';
  else if (isMe(orig?.nome) && !isMe(dest?.nome)) tipo = 'saida';
  if (!tipo && meio === 'Boleto') tipo = 'saida';
  const outra = tipo === 'entrada' ? (orig && !isMe(orig.nome) ? orig : null) : (dest && !isMe(dest.nome) ? dest : null);
  const contraparte = outra ? titleCase(outra.nome) : '';
  const valor = findValue(t);
  const data = findDate(t);
  const desc = meio === 'Boleto' ? `Boleto${contraparte ? ' · ' + contraparte : ''}`
    : `${meio || (tipo === 'entrada' ? 'Recebimento' : 'Pagamento')}${contraparte ? (tipo === 'entrada' ? ' de ' : ' para ') + contraparte : tipo === 'entrada' ? ' recebido' : tipo === 'saida' ? ' enviado' : ''}`;
  return { tipo, valor, data, contraparte, meio, desc, texto: t };
}

export async function readComprovante(file, userName) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImg = /^image\//.test(file.type);
  if (!isPdf && !isImg) return null;
  const text = isPdf ? await pdfText(file) : await Promise.race([imageText(file), new Promise((_, r) => setTimeout(() => r(new Error('tempo')), 45000))]);
  if (!text || text.trim().length < 15) return { vazio: true, isImg, isPdf };
  return { ...parseComprovante(text, userName), isImg, isPdf };
}
