'use strict';
// Formato versionado do dado cifrado (texto, cabe em coluna text/jsonb):
//
//   "bm1." + base64url( cabeçalho(19 bytes) || nonce(12) || ciphertext || tag(16) )
//
//   cabeçalho = versão(1) = 0x01 · algoritmo(1) = 0x01 (AES-256-GCM) · reservado(1) = 0x00 · id da DEK (16, UUID)
//
// O cabeçalho inteiro entra como dado autenticado (AAD) junto com o contexto do servidor
// (inquilino, recurso, registro, campo, finalidade, versão do registro). Qualquer byte alterado,
// truncado ou colado em outro registro/campo falha na verificação da tag antes de devolver texto.
const PREFIXO = 'bm1.';
const VERSAO = 0x01;
const ALG_AES_256_GCM = 0x01;
const TAM_CABECALHO = 19;
const TAM_NONCE = 12;   // 96 bits
const TAM_TAG = 16;     // 128 bits, sem truncamento
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ErroCifra extends Error {
  constructor(codigo, mensagem) { super(mensagem || codigo); this.name = 'ErroCifra'; this.codigo = codigo; }
}

function uuidParaBytes(id) {
  if (!UUID.test(String(id))) throw new ErroCifra('DEK_ID_INVALIDO', 'Identificador de chave inválido.');
  return Buffer.from(String(id).replace(/-/g, ''), 'hex');
}
function bytesParaUuid(b) {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function cabecalho(dekId) {
  return Buffer.concat([Buffer.from([VERSAO, ALG_AES_256_GCM, 0x00]), uuidParaBytes(dekId)]);
}

/** Monta o texto armazenado. */
function empacotar(cab, nonce, ciphertext, tag) {
  if (cab.length !== TAM_CABECALHO || nonce.length !== TAM_NONCE || tag.length !== TAM_TAG) throw new ErroCifra('FORMATO', 'Componentes com tamanho inválido.');
  return PREFIXO + Buffer.concat([cab, nonce, ciphertext, tag]).toString('base64url');
}

/** Lê e valida a estrutura. Não decifra nada: só recusa formatos desconhecidos ou truncados. */
function desempacotar(texto) {
  if (typeof texto !== 'string' || !texto.startsWith(PREFIXO)) throw new ErroCifra('FORMATO_DESCONHECIDO', 'Dado não está no formato cifrado esperado.');
  const corpo = texto.slice(PREFIXO.length);
  if (!/^[A-Za-z0-9_-]+$/.test(corpo)) throw new ErroCifra('FORMATO', 'Codificação inválida.');
  const b = Buffer.from(corpo, 'base64url');
  if (b.length < TAM_CABECALHO + TAM_NONCE + TAM_TAG) throw new ErroCifra('TRUNCADO', 'Dado cifrado truncado.');
  const cab = b.subarray(0, TAM_CABECALHO);
  if (cab[0] !== VERSAO) throw new ErroCifra('VERSAO_NAO_PERMITIDA', `Versão ${cab[0]} não permitida.`);
  if (cab[1] !== ALG_AES_256_GCM) throw new ErroCifra('ALGORITMO_NAO_PERMITIDO', `Algoritmo ${cab[1]} não permitido.`);
  if (cab[2] !== 0x00) throw new ErroCifra('FORMATO', 'Byte reservado diferente de zero.');
  return {
    cabecalho: Buffer.from(cab),
    dekId: bytesParaUuid(cab.subarray(3, 19)),
    nonce: Buffer.from(b.subarray(TAM_CABECALHO, TAM_CABECALHO + TAM_NONCE)),
    ciphertext: Buffer.from(b.subarray(TAM_CABECALHO + TAM_NONCE, b.length - TAM_TAG)),
    tag: Buffer.from(b.subarray(b.length - TAM_TAG))
  };
}

function ehCifrado(valor) { return typeof valor === 'string' && valor.startsWith(PREFIXO); }

/**
 * Contexto autenticado (AAD) em codificação sem ambiguidade: cada campo é "nome=<tamanho>:<valor>;".
 * Os valores vêm SEMPRE do servidor (namespace, id do registro, id do usuário), nunca do corpo da requisição.
 */
const CAMPOS_CONTEXTO = ['inquilino', 'recurso', 'registro', 'campo', 'finalidade', 'versao'];
function contextoAAD(ctx, cab) {
  const partes = ['biomanut-aad-v1;'];
  for (const k of CAMPOS_CONTEXTO) {
    const v = ctx[k] == null ? '' : String(ctx[k]);
    if (k !== 'versao' && !v) throw new ErroCifra('CONTEXTO_INCOMPLETO', `Contexto sem "${k}".`);
    partes.push(`${k}=${Buffer.byteLength(v)}:${v};`);
  }
  return Buffer.concat([Buffer.from(partes.join(''), 'utf8'), cab]);
}

module.exports = { PREFIXO, VERSAO, TAM_NONCE, TAM_TAG, ErroCifra, cabecalho, empacotar, desempacotar, ehCifrado, contextoAAD, CAMPOS_CONTEXTO };
