'use strict';
// Cifragem seletiva dos registros sincronizados (app.sync_registro.payload).
//
// Os campos sensíveis de cada módulo saem do JSON em claro e vão juntos, cifrados, no campo "_cifrado".
// Ficam em claro só os campos que o banco usa para autorizar e filtrar (ids, status, grupo, e-mails de
// escopo) — o RLS do PostgreSQL continua funcionando sem ver o conteúdo sensível.
// O AAD vincula o bloco ao módulo, ao id do registro e à VERSÃO da linha: um bloco copiado para outro
// registro, ou para outra versão, não abre.
const { obterServico } = require('./index');

const RECURSO = 'app.sync_registro';
const FINALIDADE = 'dados-operacionais';

/** Campos sensíveis por módulo (fotos, anexos, GPS, textos livres e trilhas com nomes/observações). */
const CAMPOS_SENSIVEIS = Object.freeze({
  sci: ['foto', 'anexos', 'observacoes', 'observacaoAlmoxarife', 'historico'],
  scm: ['anexos', 'descricaoUso', 'nomeFornecedor', 'observacaoLider', 'observacaoAlmoxarife', 'historico'],
  utility_readings: ['photoData', 'latitude', 'longitude', 'observation'],
  lms_progress: ['notes']
});

function contexto(namespace, recordId, versao) {
  return { recurso: RECURSO, registro: `${namespace}/${recordId}`, campo: 'payload._cifrado', finalidade: FINALIDADE, versao: String(versao) };
}

/** Separa e cifra os campos sensíveis. `versao` é a versão que a linha terá DEPOIS da gravação. */
async function protegerPayload(namespace, recordId, versao, payload) {
  const campos = CAMPOS_SENSIVEIS[namespace];
  const claro = { ...(payload || {}) };
  delete claro._cifrado; delete claro._cifradoIlegivel;
  if (!campos) return claro;
  const sensivel = {};
  for (const c of campos) if (claro[c] !== undefined) { sensivel[c] = claro[c]; delete claro[c]; }
  if (!Object.keys(sensivel).length) return claro;
  claro._cifrado = await obterServico().cifrarJSON(contexto(namespace, recordId, versao), sensivel);
  return claro;
}

/**
 * Decifra uma linha lida do banco (antes de validar fluxo ou de expor ao usuário).
 * Linha adulterada/fora de contexto: devolve o registro SEM os campos sensíveis e marcado como ilegível —
 * nunca devolve texto não autenticado.
 */
async function abrirLinha(row, registrarFalha) {
  if (!row || !row.payload || typeof row.payload._cifrado !== 'string') return row;
  const { _cifrado, ...claro } = row.payload;
  try {
    const sensivel = await obterServico().decifrarJSON(contexto(row.namespace, row.record_id, row.version), _cifrado);
    return { ...row, payload: { ...claro, ...sensivel } };
  } catch (e) {
    if (e && (e.codigo === 'KMS_INDISPONIVEL' || e.codigo === 'KMS_CONFIG')) throw e;   // falha fechada: sem KMS, sem dados
    // Registro assíncrono: o log nunca segura a requisição (nem a transação em que a linha foi lida).
    if (registrarFalha) Promise.resolve().then(() => registrarFalha(row, e)).catch(() => {});
    return { ...row, payload: { ...claro, _cifradoIlegivel: true } };
  }
}

async function abrirLinhas(rows, registrarFalha) {
  const out = [];
  for (const r of rows) out.push(await abrirLinha(r, registrarFalha));
  return out;
}

module.exports = { CAMPOS_SENSIVEIS, protegerPayload, abrirLinha, abrirLinhas, contexto, FINALIDADE };
