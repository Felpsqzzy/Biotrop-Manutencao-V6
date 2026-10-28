'use strict';
// Operações administrativas de chaves e de migração de dados cifrados. Rodam com a conexão do DONO do
// schema (DATABASE_ADMIN_URL), fora do app web, por quem administra o banco — separado de quem administra a
// KEK no Key Vault (Crypto Officer) e de quem só usa dados (o app, com wrap/unwrap).
//
//   status        lista DEKs por finalidade (sem material de chave)
//   migrar        cifra dados legados em claro (registros, telefone/foto) e converte segredos 2FA do formato v1
//   rotacionar    aposenta as DEKs ativas de uma finalidade (a próxima cifragem cria uma nova)
//   reembrulhar   após girar a KEK no Key Vault: desembrulha cada DEK e embrulha de novo com a versão atual
//   recifrar      recifra os dados que ainda usam DEKs não ativas (troca de DEK de verdade)
//   referencias   conta quantos dados ainda usam uma DEK
//   revogar       marca uma DEK como revogada (só sem referências, salvo --forcar após incidente)
//   destruir      apaga o material embrulhado de uma DEK revogada e sem referências
const { desempacotar, ehCifrado } = require('./formato');
const { CAMPOS_SENSIVEIS, protegerPayload } = require('./registros');

function dekDe(t) { try { return ehCifrado(t) ? desempacotar(t).dekId : null; } catch { return null; } }

function criarAdmin({ q, servico, kms, log = console.log }) {
  const evento = (tipo, detalhe) => q('INSERT INTO seguranca.evento(tipo, detalhe) VALUES($1,$2::jsonb)', [tipo, JSON.stringify(detalhe)]).catch(() => {});

  async function status() {
    return (await q(`SELECT finalidade, estado, count(*)::int AS quantidade, sum(usos_reservados)::bigint AS usos, min(criada_em) AS primeira, max(expira_em) AS ultima_validade
      FROM seguranca.chave_dados GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  }

  /** Percorre app.sync_registro com o RLS forçado suspenso SÓ dentro da transação do lote (dono da tabela). */
  async function comRegistros(fn) {
    await q('BEGIN');
    try {
      await q('ALTER TABLE app.sync_registro NO FORCE ROW LEVEL SECURITY');
      const r = await fn();
      await q('ALTER TABLE app.sync_registro FORCE ROW LEVEL SECURITY');
      await q('COMMIT');
      return r;
    } catch (e) { await q('ROLLBACK').catch(() => {}); throw e; }
  }

  async function migrar({ simular = false } = {}) {
    const res = { registros: 0, telefones: 0, fotos: 0, segredos2fa: 0 };
    await comRegistros(async () => {
      for (const [ns, campos] of Object.entries(CAMPOS_SENSIVEIS)) {
        const rows = (await q(`SELECT id, namespace, record_id, version, payload FROM app.sync_registro
          WHERE namespace=$1 AND payload ?| $2::text[]`, [ns, campos])).rows;
        for (const r of rows) {
          res.registros++;
          if (simular) continue;
          // Se já havia um bloco cifrado, os campos em claro novos têm prioridade (mesclados ao que já estava cifrado).
          let atual = r.payload;
          if (typeof atual._cifrado === 'string') {
            const { abrirLinha } = require('./registros');
            atual = (await abrirLinha(r)).payload;
          }
          const novo = await protegerPayload(r.namespace, r.record_id, r.version, atual);
          await q('UPDATE app.sync_registro SET payload=$2::jsonb WHERE id=$1 AND version=$3', [r.id, JSON.stringify(novo), r.version]);
        }
      }
    });
    const { cifrarPessoal, cifrarSegredo2fa } = require('./pessoais');
    const totpLegado = require('../auth/totp');
    const config = require('../config');
    const us = (await q(`SELECT id, telefone, foto, totp_segredo, totp_pendente FROM core.usuario
      WHERE (telefone IS NOT NULL AND telefone !~ '^bm1\\.') OR (foto IS NOT NULL AND foto !~ '^bm1\\.')
         OR (totp_segredo LIKE 'v1.%') OR (totp_pendente LIKE 'v1.%')`)).rows;
    for (const u of us) {
      const set = {};
      if (u.telefone && !ehCifrado(u.telefone)) { res.telefones++; set.telefone = await cifrarPessoal(u.id, 'telefone', u.telefone); }
      if (u.foto && !ehCifrado(u.foto)) { res.fotos++; set.foto = await cifrarPessoal(u.id, 'foto', u.foto); }
      for (const col of ['totp_segredo', 'totp_pendente']) {
        if (String(u[col] || '').startsWith('v1.')) {
          const s = totpLegado.decrypt(u[col], config.twofaKey);
          if (s) { res.segredos2fa++; set[col] = await cifrarSegredo2fa(u.id, s); }
          else log(`  aviso: segredo 2FA de ${u.id} não abriu com TWOFA_KEY atual (mantido como está)`);
        }
      }
      if (simular || !Object.keys(set).length) continue;
      const cols = Object.keys(set);
      await q(`UPDATE core.usuario SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`, [u.id, ...cols.map(c => set[c])]);
    }
    if (!simular) await evento('chave.migrar_legado', res);
    return res;
  }

  async function rotacionar({ finalidade }) {
    const n = (await q(`UPDATE seguranca.chave_dados SET estado='aposentada', aposentada_em=now() WHERE finalidade=$1 AND estado='ativa'`, [finalidade])).rowCount;
    await evento('chave.rotacionar', { finalidade, aposentadas: n });
    servico.chaveiro?.esquecer?.();
    return { aposentadas: n };
  }

  async function reembrulhar() {
    const rows = (await q(`SELECT id::text AS id, finalidade, kek_id, dek_envelopada FROM seguranca.chave_dados WHERE estado IN ('ativa','aposentada')`)).rows;
    let n = 0;
    for (const r of rows) {
      const dek = await kms.desembrulhar(r.dek_envelopada, { dekId: r.id, finalidade: r.finalidade, kekId: r.kek_id });
      try {
        const { kekId, envelopada } = await kms.embrulhar(dek, { dekId: r.id, finalidade: r.finalidade });
        if (kekId === r.kek_id) continue;
        await q('UPDATE seguranca.chave_dados SET kek_id=$2, dek_envelopada=$3 WHERE id=$1::uuid', [r.id, kekId, envelopada]);
        n++;
      } finally { dek.fill(0); }
    }
    await evento('chave.reembrulhar', { reembrulhadas: n });
    return { reembrulhadas: n, total: rows.length };
  }

  /** Mapa dekId → quantidade de dados que a usam. */
  async function referencias() {
    const cont = new Map();
    const soma = id => { if (id) cont.set(id, (cont.get(id) || 0) + 1); };
    await comRegistros(async () => {
      for (const r of (await q(`SELECT payload->>'_cifrado' AS c FROM app.sync_registro WHERE payload ? '_cifrado'`)).rows) soma(dekDe(r.c));
    });
    for (const r of (await q(`SELECT telefone, foto, totp_segredo, totp_pendente FROM core.usuario`)).rows) {
      soma(dekDe(r.telefone)); soma(dekDe(r.foto)); soma(dekDe(r.totp_segredo)); soma(dekDe(r.totp_pendente));
    }
    return cont;
  }

  async function recifrar({ finalidade }) {
    const ativas = new Set((await q(`SELECT id::text id FROM seguranca.chave_dados WHERE finalidade=$1 AND estado='ativa'`, [finalidade])).rows.map(r => r.id));
    const velhas = id => id && !ativas.has(id);
    const res = { registros: 0, campos: 0 };
    if (finalidade === 'dados-operacionais') {
      const { abrirLinha } = require('./registros');
      await comRegistros(async () => {
        for (const r of (await q(`SELECT id, namespace, record_id, version, payload FROM app.sync_registro WHERE payload ? '_cifrado'`)).rows) {
          if (!velhas(dekDe(r.payload._cifrado))) continue;
          const aberta = await abrirLinha(r);
          if (aberta.payload._cifradoIlegivel) { log(`  aviso: registro ${r.namespace}/${r.record_id} ilegível, não recifrado`); continue; }
          const novo = await protegerPayload(r.namespace, r.record_id, r.version, aberta.payload);
          await q('UPDATE app.sync_registro SET payload=$2::jsonb WHERE id=$1 AND version=$3', [r.id, JSON.stringify(novo), r.version]);
          res.registros++;
        }
      });
    } else {
      const P = require('./pessoais');
      for (const u of (await q('SELECT id, telefone, foto, totp_segredo, totp_pendente FROM core.usuario')).rows) {
        const set = {};
        if (finalidade === 'dados-pessoais') {
          for (const c of ['telefone', 'foto']) if (velhas(dekDe(u[c]))) { set[c] = await P.cifrarPessoal(u.id, c, await P.abrirPessoal(u.id, c, u[c])); }
        } else if (finalidade === 'segredo-2fa') {
          for (const c of ['totp_segredo', 'totp_pendente']) if (velhas(dekDe(u[c]))) {
            const { segredo } = await P.abrirSegredo2fa(u.id, u[c]);
            if (segredo) set[c] = await P.cifrarSegredo2fa(u.id, segredo);
          }
        }
        const cols = Object.keys(set);
        if (!cols.length) continue;
        await q(`UPDATE core.usuario SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`, [u.id, ...cols.map(c => set[c])]);
        res.campos += cols.length;
      }
    }
    await evento('chave.recifrar', { finalidade, ...res });
    return res;
  }

  async function revogar({ dek, forcar = false }) {
    const refs = (await referencias()).get(dek) || 0;
    if (refs && !forcar) throw new Error(`A DEK ${dek} ainda protege ${refs} dado(s). Rode "recifrar" antes (ou --forcar após incidente, sabendo que esses dados ficarão ilegíveis).`);
    const n = (await q(`UPDATE seguranca.chave_dados SET estado='revogada', revogada_em=now() WHERE id=$1::uuid AND estado IN ('ativa','aposentada')`, [dek])).rowCount;
    await evento('chave.revogar', { dek, referencias: refs, forcado: !!forcar });
    servico.chaveiro?.esquecer?.();
    return { revogadas: n, referencias: refs };
  }

  async function destruir({ dek }) {
    const refs = (await referencias()).get(dek) || 0;
    if (refs) throw new Error(`A DEK ${dek} ainda protege ${refs} dado(s): não pode ser destruída.`);
    const n = (await q(`UPDATE seguranca.chave_dados SET dek_envelopada=NULL, estado='destruida', destruida_em=now() WHERE id=$1::uuid AND estado='revogada'`, [dek])).rowCount;
    if (!n) throw new Error('Só uma DEK revogada pode ser destruída.');
    await evento('chave.destruir', { dek });
    return { destruidas: n };
  }

  return { status, migrar, rotacionar, reembrulhar, referencias, recifrar, revogar, destruir };
}

module.exports = { criarAdmin, dekDe };
