'use strict';
/*
 * Telefone brasileiro num formato só: "+55 (41) 9 9999-9999" (celular) ou "+55 (41) 3333-4444" (fixo),
 * com ramal opcional: "+55 (41) 3333-4444 · ramal 1234" — ou só "Ramal 1234".
 * A pessoa digita só números; o site formata. O servidor normaliza de novo o que chega (não confia na
 * tela) e recusa DDD que não existe, celular sem o 9 e número com tamanho errado.
 * Mesma regra em web/src/core/telefone.js.
 */
const DDD = new Set(('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 ' +
  '61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99').split(' '));

function digitos(v) { return String(v == null ? '' : v).replace(/\D+/g, ''); }

/** Só o número (sem ramal): tira +55 / 0 de operadora do começo. */
function numero(v) {
  let d = digitos(v);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if ((d.length === 11 || d.length === 12) && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** { ok, valor, erro }: valor é o texto canônico ('' = sem telefone). */
function normalizar(texto, ramalSeparado) {
  const bruto = String(texto == null ? '' : texto).trim();
  const r = /\bramal\b\D*(\d{1,6})\s*$/i.exec(bruto);
  const ramal = digitos(ramalSeparado !== undefined ? ramalSeparado : r ? r[1] : '');
  const parte = r ? bruto.slice(0, r.index) : bruto;
  if (/[^0-9+()\-\s.·]/.test(parte.replace(/\bramal\b/ig, ''))) return { ok: false, erro: 'Telefone inválido: use só números.' };
  const d = numero(parte);
  if (ramal.length > 6) return { ok: false, erro: 'Ramal com no máximo 6 dígitos.' };
  if (!d && !ramal) return { ok: true, valor: '' };
  if (!d) return { ok: true, valor: `Ramal ${ramal}` };
  if (d.length < 10) return { ok: false, erro: 'Informe o DDD e o número (ex.: 41 99999-9999).' };
  const ddd = d.slice(0, 2), n = d.slice(2);
  if (!DDD.has(ddd)) return { ok: false, erro: `DDD ${ddd} não existe.` };
  let fmt;
  if (n.length === 9) {
    if (n[0] !== '9') return { ok: false, erro: 'Celular começa com 9.' };
    fmt = `+55 (${ddd}) ${n[0]} ${n.slice(1, 5)}-${n.slice(5)}`;
  } else if (n.length === 8) {
    if (!/^[2-5]/.test(n)) return { ok: false, erro: 'Telefone fixo começa com 2, 3, 4 ou 5 (celular tem 9 dígitos).' };
    fmt = `+55 (${ddd}) ${n.slice(0, 4)}-${n.slice(4)}`;
  } else return { ok: false, erro: 'Número com tamanho errado: celular tem 9 dígitos e fixo tem 8, além do DDD.' };
  return { ok: true, valor: ramal ? `${fmt} · ramal ${ramal}` : fmt };
}

module.exports = { normalizar, digitos, numero, DDD };
