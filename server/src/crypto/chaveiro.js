'use strict';
// Chaveiro: gerencia as DEKs (chaves de dados, AES-256) por finalidade.
//
// • Cada DEK nasce aleatória (CSPRNG, 256 bits), é embrulhada pela KEK do KMS e só a versão embrulhada vai
//   para o banco (seguranca.chave_dados). A DEK em claro existe apenas em memória, num cache curto.
// • Limite de uso por DEK: as cifragens são RESERVADAS no banco em blocos, com UPDATE atômico condicionado ao
//   limite. Assim, mesmo com várias instâncias, reinícios ou restauração de backup, o total de cifragens com a
//   mesma DEK nunca passa do limite (o contador só cresce; blocos não usados são descartados, nunca reaproveitados).
// • Rotação automática: ao atingir o limite de uso ou a validade (dias), cria-se uma nova DEK para a finalidade;
//   a antiga fica "aposentada" (só decifra). "revogada" não decifra nada (uso após comprometimento).
const crypto = require('node:crypto');
const { ErroCifra } = require('./formato');

const PADROES = Object.freeze({
  limiteUsos: 2 ** 30,        // cifragens por DEK (nonce aleatório de 96 bits → prob. de colisão ≤ ~2^-37)
  validadeDias: 90,
  tamanhoBloco: 512,          // cifragens reservadas por vez, por processo
  cacheTtlMs: 5 * 60_000,
  cacheMax: 64
});

function criarChaveiro({ armazem, kms, opcoes = {} }) {
  const o = { ...PADROES, ...opcoes };
  const cache = new Map();        // dekId -> { chave, finalidade, expira }
  const blocos = new Map();       // finalidade -> { dekId, restantes }
  const emAndamento = new Map();  // finalidade -> Promise (evita duas rotações simultâneas no mesmo processo)

  function guardar(id, chave, finalidade) {
    if (cache.size >= o.cacheMax) { const [k, v] = cache.entries().next().value; v.chave.fill(0); cache.delete(k); }
    cache.set(id, { chave, finalidade, expira: Date.now() + o.cacheTtlMs });
  }
  function limparExpiradas() {
    const agora = Date.now();
    for (const [k, v] of cache) if (v.expira <= agora) { v.chave.fill(0); cache.delete(k); }
  }

  async function abrir(linha) {
    if (!linha) throw new ErroCifra('DEK_INEXISTENTE', 'Chave de dados não encontrada.');
    if (linha.estado === 'revogada' || linha.estado === 'destruida' || !linha.dek_envelopada) {
      throw new ErroCifra('DEK_INDISPONIVEL', `Chave de dados ${linha.estado}.`);
    }
    const chave = await kms.desembrulhar(linha.dek_envelopada, { dekId: linha.id, finalidade: linha.finalidade, kekId: linha.kek_id });
    guardar(linha.id, chave, linha.finalidade);
    return chave;
  }

  async function novaDek(finalidade) {
    const id = crypto.randomUUID();
    const dek = crypto.randomBytes(32);
    const { kekId, envelopada } = await kms.embrulhar(dek, { dekId: id, finalidade });
    const expiraEm = new Date(Date.now() + o.validadeDias * 86_400_000);
    const criada = await armazem.criar({ id, finalidade, kekId, envelopada, limite: o.limiteUsos, expiraEm });
    if (criada.id === id) guardar(id, dek, finalidade); else dek.fill(0);   // outra instância criou antes: usa a dela
    return criada;
  }

  async function reservarBloco(finalidade) {
    let linha = await armazem.ativa(finalidade);
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      if (!linha) linha = await armazem.garantirAtiva(finalidade, () => novaDek(finalidade));
      if (await armazem.reservar(linha.id, o.tamanhoBloco)) return { dekId: linha.id, restantes: o.tamanhoBloco };
      await armazem.aposentar(linha.id);   // esgotada ou vencida
      linha = null;
    }
    throw new ErroCifra('DEK_ESGOTADA', 'Não foi possível reservar uso de chave de dados.');
  }

  /** Devolve { dekId, chave } para UMA cifragem (consome uma unidade do bloco reservado). */
  async function paraCifrar(finalidade) {
    limparExpiradas();
    for (;;) {
      const b = blocos.get(finalidade);
      // Checagem e consumo sem nenhum await no meio: chamadas concorrentes nunca gastam a mesma unidade.
      if (b && b.restantes > 0) {
        b.restantes--;
        const c = cache.get(b.dekId);
        const chave = c ? c.chave : await abrir(await armazem.carregar(b.dekId));
        return { dekId: b.dekId, chave };
      }
      if (!emAndamento.has(finalidade)) {
        emAndamento.set(finalidade, reservarBloco(finalidade)
          .then(novo => { blocos.set(finalidade, novo); })
          .finally(() => emAndamento.delete(finalidade)));
      }
      await emAndamento.get(finalidade);
    }
  }

  /** Chave para decifrar; confere que a DEK pertence à finalidade esperada. */
  async function paraDecifrar(dekId, finalidade) {
    limparExpiradas();
    const c = cache.get(dekId);
    if (c) {
      if (c.finalidade !== finalidade) throw new ErroCifra('FINALIDADE_DIVERGENTE', 'Chave de outra finalidade.');
      return c.chave;
    }
    const linha = await armazem.carregar(dekId);
    if (!linha) throw new ErroCifra('DEK_INEXISTENTE', 'Chave de dados não encontrada.');
    if (linha.finalidade !== finalidade) throw new ErroCifra('FINALIDADE_DIVERGENTE', 'Chave de outra finalidade.');
    return abrir(linha);
  }

  /** Invalida o cache (ex.: após revogar uma DEK ou trocar a KEK). */
  function esquecer() { for (const v of cache.values()) v.chave.fill(0); cache.clear(); blocos.clear(); }

  return { paraCifrar, paraDecifrar, esquecer, novaDek, _cache: cache };
}

/* ---------------------------------------------------------------- armazéns */

/** Armazém PostgreSQL (tabela seguranca.chave_dados; ver migration 17). `consulta(sql, params)` usa o pool do app. */
function armazemPg(consulta, transacao) {
  const col = 'id::text AS id, finalidade, kek_id, dek_envelopada, estado, usos_reservados, limite_usos, expira_em';
  return {
    async ativa(finalidade) {
      return (await consulta(`SELECT ${col} FROM seguranca.chave_dados
        WHERE finalidade=$1 AND estado='ativa' AND expira_em > now() AND usos_reservados < limite_usos
        ORDER BY criada_em DESC LIMIT 1`, [finalidade])).rows[0] || null;
    },
    async garantirAtiva(finalidade, criar) {
      // Trava por finalidade: duas instâncias não criam DEKs em paralelo para a mesma finalidade.
      return transacao(async q => {
        await q('SELECT pg_advisory_xact_lock(hashtext($1))', ['biomanut-dek:' + finalidade]);
        const ja = (await q(`SELECT ${col} FROM seguranca.chave_dados WHERE finalidade=$1 AND estado='ativa'
          AND expira_em > now() AND usos_reservados < limite_usos ORDER BY criada_em DESC LIMIT 1`, [finalidade])).rows[0];
        if (ja) return ja;
        return criar();
      });
    },
    async criar({ id, finalidade, kekId, envelopada, limite, expiraEm }) {
      return (await consulta(`INSERT INTO seguranca.chave_dados(id, finalidade, kek_id, dek_envelopada, limite_usos, expira_em)
        VALUES($1::uuid,$2,$3,$4,$5,$6) RETURNING ${col}`, [id, finalidade, kekId, envelopada, limite, expiraEm])).rows[0];
    },
    async reservar(id, n) {
      return (await consulta(`UPDATE seguranca.chave_dados SET usos_reservados = usos_reservados + $2
        WHERE id=$1::uuid AND estado='ativa' AND expira_em > now() AND usos_reservados + $2 <= limite_usos RETURNING id`, [id, n])).rowCount === 1;
    },
    async aposentar(id) {
      await consulta(`UPDATE seguranca.chave_dados SET estado='aposentada', aposentada_em=now() WHERE id=$1::uuid AND estado='ativa'`, [id]);
    },
    async carregar(id) {
      return (await consulta(`SELECT ${col} FROM seguranca.chave_dados WHERE id=$1::uuid`, [id])).rows[0] || null;
    }
  };
}

/** Armazém em memória (testes). Simula as mesmas regras do SQL. */
function armazemMemoria() {
  const linhas = new Map();
  const ativaOk = l => l.estado === 'ativa' && l.expira_em > new Date() && l.usos_reservados < l.limite_usos;
  let fila = Promise.resolve();
  return {
    linhas,
    async ativa(f) { return [...linhas.values()].filter(l => l.finalidade === f && ativaOk(l)).pop() || null; },
    async garantirAtiva(f, criar) {
      const run = async () => { const ja = [...linhas.values()].filter(l => l.finalidade === f && ativaOk(l)).pop(); return ja || criar(); };
      const p = fila.then(run, run); fila = p.catch(() => {}); return p;
    },
    async criar({ id, finalidade, kekId, envelopada, limite, expiraEm }) {
      const l = { id, finalidade, kek_id: kekId, dek_envelopada: Buffer.from(envelopada), estado: 'ativa', usos_reservados: 0, limite_usos: limite, expira_em: expiraEm };
      linhas.set(id, l); return { ...l };
    },
    async reservar(id, n) { const l = linhas.get(id); if (!l || !ativaOk(l) || l.usos_reservados + n > l.limite_usos) return false; l.usos_reservados += n; return true; },
    async aposentar(id) { const l = linhas.get(id); if (l && l.estado === 'ativa') l.estado = 'aposentada'; },
    async carregar(id) { const l = linhas.get(id); return l ? { ...l } : null; }
  };
}

module.exports = { criarChaveiro, armazemPg, armazemMemoria, PADROES };
