'use strict';
// Dados pessoais e segredos guardados em core.usuario, cifrados pela aplicação (envelope + AAD):
//   • telefone e foto do perfil   → finalidade "dados-pessoais"
//   • segredo do autenticador 2FA → finalidade "segredo-2fa" (antes: AES-GCM com chave derivada de TWOFA_KEY,
//                                   formato "v1.", sem vínculo com o usuário — ainda aberto para migração)
// O registro do AAD é o id do usuário: um valor copiado para a linha de outra pessoa não abre.
const config = require('../config');
const { obterServico } = require('./index');
const { ehCifrado } = require('./formato');
const totpLegado = require('../auth/totp');

const RECURSO = 'core.usuario';

function ctx(usuarioId, campo, finalidade) { return { recurso: RECURSO, registro: String(usuarioId), campo, finalidade }; }
const falhaDeKms = e => e && (e.codigo === 'KMS_INDISPONIVEL' || e.codigo === 'KMS_CONFIG');

async function cifrarPessoal(usuarioId, campo, valor) {
  if (valor == null || valor === '' || ehCifrado(valor)) return valor;
  return obterServico().cifrarTexto(ctx(usuarioId, campo, 'dados-pessoais'), valor);
}

/** Valor legado em claro é devolvido como está (a rotina de migração cifra depois); adulterado → vazio. */
async function abrirPessoal(usuarioId, campo, valor) {
  if (valor == null || valor === '') return '';
  if (!ehCifrado(valor)) return String(valor);
  try { return await obterServico().decifrarTexto(ctx(usuarioId, campo, 'dados-pessoais'), valor); }
  catch (e) { if (falhaDeKms(e)) throw e; return ''; }
}

const abrirTelefone = (id, v) => abrirPessoal(id, 'telefone', v);

async function cifrarSegredo2fa(usuarioId, segredo) {
  return obterServico().cifrarTexto(ctx(usuarioId, 'totp', 'segredo-2fa'), segredo);
}

/** Devolve { segredo, legado } — legado=true quando veio no formato antigo e deve ser regravado. */
async function abrirSegredo2fa(usuarioId, guardado) {
  if (!guardado) return { segredo: null, legado: false };
  if (ehCifrado(guardado)) {
    try { return { segredo: await obterServico().decifrarTexto(ctx(usuarioId, 'totp', 'segredo-2fa'), guardado), legado: false }; }
    catch (e) { if (falhaDeKms(e)) throw e; return { segredo: null, legado: false }; }
  }
  const s = totpLegado.decrypt(guardado, config.twofaKey);
  return { segredo: s, legado: !!s };
}

module.exports = { cifrarPessoal, abrirPessoal, abrirTelefone, cifrarSegredo2fa, abrirSegredo2fa };
