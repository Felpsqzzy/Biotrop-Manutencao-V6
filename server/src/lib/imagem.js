'use strict';
// Foto que a tela manda (data:image/...;base64), no padrão das fotos do catálogo do almoxarifado (routes/almox-materiais.js):
//  • a tela já reduz a foto (até 1600 px, JPEG, sem GPS nem dados do aparelho) e manda também a miniatura das listas;
//  • o tipo é conferido pelos primeiros bytes do arquivo, não pelo rótulo que o navegador põe: SVG, HTML ou qualquer
//    outro arquivo chamado de JPEG é recusado;
//  • limites: foto até 1,2 MB e miniatura (só JPEG) até 80 KB — juntas, em base64, cabem no limite de 2 MB do corpo.
// O banco confere tudo de novo (emprestimo.imagem_valida, migration 43). Erros saem com status 400 e a mensagem para a pessoa.
const ASSINATURA = {
  'image/jpeg': b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
};
const LIMITE = { imagem: 1200000, miniatura: 80000 };
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function erro(msg) { return Object.assign(new Error(msg), { status: 400 }); }

/** data URL → { mime, b }. mimes: os tipos aceitos (a miniatura é sempre JPEG). */
function lerImagem(dataUrl, max, rotulo, mimes = Object.keys(ASSINATURA)) {
  const texto = typeof dataUrl === 'string' ? dataUrl : '';
  if (texto.length > Math.ceil(max / 3) * 4 + 40) throw erro(`${rotulo} grande demais.`);   // nem decodifica o que já passou do limite
  const m = DATA_URL.exec(texto);
  if (!m || !mimes.includes(m[1])) throw erro(`${rotulo} em formato inválido (use ${mimes.length === 1 ? 'JPG' : 'JPG, PNG ou WEBP'}).`);
  const b = Buffer.from(m[2], 'base64');
  if (b.length > max) throw erro(`${rotulo} grande demais.`);
  if (b.length < 100) throw erro(`${rotulo} vazia ou corrompida.`);
  if (!ASSINATURA[m[1]](b)) throw erro(`${rotulo}: o conteúdo não é a imagem que diz ser.`);
  return { mime: m[1], b };
}
function dimensao(v) { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n > 0 && n <= 10000 ? n : 0; }

/** Corpo do envio da foto → { mime, b (imagem), mini (miniatura JPEG), largura, altura }. */
function fotoDoCorpo(body) {
  const img = lerImagem(body?.imagem, LIMITE.imagem, 'Foto');
  const mini = lerImagem(body?.miniatura, LIMITE.miniatura, 'Miniatura', ['image/jpeg']);
  return { mime: img.mime, b: img.b, mini: mini.b, largura: dimensao(body?.largura), altura: dimensao(body?.altura) };
}

module.exports = { lerImagem, fotoDoCorpo, LIMITE, ASSINATURA };
