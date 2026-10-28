'use strict';
/*
 * MODO DE TESTE — vários usuários usando o sistema ao mesmo tempo (só o admin liga).
 *
 * Cada usuário virtual é uma pessoa de verdade para o servidor: linha em core.usuario (e-mail do domínio de teste,
 * perfil, grupo), sessão própria e "computador" próprio (IP). Ele usa o sistema pela API HTTP real — passa por
 * limite de requisições, sessão, RLS, fluxo de aprovação e criptografia, exatamente como um navegador — e repete,
 * com pausas de "pensar", as tarefas do seu perfil:
 *   técnico    abre SCI e SCM, corrige SCM devolvida, lança leitura de utilidade, faz treinamento
 *   líder      aprova / devolve as SCM do grupo, acompanha preventivas
 *   almoxarife trata a fila da SCI (cadastro) e da SCM (compra até concluir)
 *   PCM        trata SCI, consulta cadastros e preventivas
 *   gestor     painéis, aprovações acima do líder
 *   visualizador consultas
 * e faz "tentativas indevidas" (aprovar o próprio pedido, editar cadastro sem perfil…) que TÊM de ser recusadas.
 *
 * Isolamento: tudo o que eles gravam leva _simulacao=true e id "SIM-…"; só o admin vê (read-scope.js).
 * Não gravam em preventivas nem cadastros (os dados reais da fábrica): nesses módulos só consultam.
 * "Limpar" apaga os registros de teste e desativa os usuários virtuais.
 */
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { transaction, pool } = require('../db/pool');
const { createSession, COOKIE } = require('../auth/session');
const config = require('../config');
const { DOMINIO, PREFIXO } = require('./identidade');

const PERFIS = ['tecnico', 'lider', 'almoxarife', 'pcm', 'gestor', 'viewer'];
const ROTULO = { tecnico: 'Técnico', lider: 'Líder', almoxarife: 'Almoxarife', pcm: 'PCM', gestor: 'Gestor', viewer: 'Visualizador' };
const RITMO = { calmo: [6000, 14000], normal: [2000, 6000], pico: [400, 1800] };
const LIMITES = { usuarios: 80, minutos: 30 };
const pad = n => String(n).padStart(2, '0');
const sorteio = arr => arr[Math.floor(Math.random() * arr.length)];
const dormir = ms => new Promise(r => setTimeout(r, ms));
function percentil(v, p) { if (!v.length) return 0; const s = v.slice().sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]); }

/* ------------------------------------------------------------------ usuários virtuais (banco) */
async function prepararUsuarios(admin, quantidades) {
  return transaction(admin, async db => {
    let g = (await db.query(`SELECT id FROM core.grupo WHERE codigo='SIMULACAO'`)).rows[0];
    if (!g) g = (await db.query(`INSERT INTO core.grupo(codigo, nome, area, ativo) VALUES('SIMULACAO', '[TESTE] Grupo do modo de teste', 'Teste', true) RETURNING id`)).rows[0];
    else await db.query('UPDATE core.grupo SET ativo=true WHERE id=$1', [g.id]);
    const lista = [];
    for (const perfil of PERFIS) {
      for (let i = 1; i <= (quantidades[perfil] || 0); i++) {
        const email = `sim-${perfil}-${pad(i)}@${DOMINIO}`, nome = `[TESTE] ${ROTULO[perfil]} ${pad(i)}`;
        const grupo = ['tecnico', 'lider'].includes(perfil) ? g.id : null;
        await db.query(`INSERT INTO core.email_autorizado(email, ativo, perfil_padrao, grupo_padrao, motivo, liberado_por)
          VALUES($1, true, $2, $3, 'Modo de teste: usuário virtual (não entra pela Microsoft)', $4)
          ON CONFLICT (email) DO UPDATE SET ativo=true, revogado_em=NULL, perfil_padrao=excluded.perfil_padrao`, [email, perfil, g.id, admin.id]);
        const u = (await db.query(`INSERT INTO core.usuario(nome, email, perfil_id, grupo_id, time, ativo, bloqueado)
          VALUES($1, $2, $3, $4, 'Teste', true, false)
          ON CONFLICT (email) DO UPDATE SET nome=excluded.nome, perfil_id=excluded.perfil_id, grupo_id=excluded.grupo_id,
            ativo=true, bloqueado=false, motivo_bloqueio=NULL
          RETURNING id, sessao_versao`, [nome, email, perfil, grupo])).rows[0];
        lista.push({ id: u.id, email, nome, perfil, grupoId: grupo });
      }
    }
    const lider = lista.find(u => u.perfil === 'lider');
    await db.query('UPDATE core.grupo SET responsavel_id=$2 WHERE id=$1', [g.id, lider?.id || null]);
    // a versão da sessão pode mudar com a troca de perfil/grupo: lê de novo no fim
    const sv = (await db.query(`SELECT id, sessao_versao FROM core.usuario WHERE email LIKE $1`, [`%@${DOMINIO}`])).rows;
    for (const u of lista) u.sv = Number(sv.find(x => x.id === u.id)?.sessao_versao ?? 0);
    return lista;
  });
}

async function limparBanco(admin) {
  return transaction(admin, async db => {
    const reg = (await db.query(`DELETE FROM app.sync_registro WHERE payload->>'_simulacao'='true' OR record_id LIKE $1`, [PREFIXO + '%'])).rowCount;
    const us = (await db.query(`UPDATE core.usuario SET ativo=false WHERE email LIKE $1 AND ativo`, [`%@${DOMINIO}`])).rowCount;
    await db.query(`UPDATE core.email_autorizado SET ativo=false, revogado_em=now() WHERE email LIKE $1 AND ativo`, [`%@${DOMINIO}`]);
    await db.query(`UPDATE core.grupo SET ativo=false, responsavel_id=NULL WHERE codigo='SIMULACAO'`);
    return { registros: reg, usuarios: us };
  });
}

async function equipeReal(admin) {
  return transaction(admin, async db => {
    const r = (await db.query(`SELECT perfil_id, count(*)::int n FROM core.usuario WHERE ativo AND NOT bloqueado AND email NOT LIKE $1 GROUP BY 1`, [`%@${DOMINIO}`])).rows;
    return Object.fromEntries(r.map(x => [x.perfil_id, x.n]));
  });
}

/* ------------------------------------------------------------------ a simulação */
class Simulacao {
  constructor() { this.zerar(); this.estado = 'parado'; }
  zerar() {
    this.cfg = null; this.inicio = 0; this.fimPrevisto = 0; this.fim = 0; this.erroFatal = '';
    this.usuarios = []; this.acoes = new Map(); this.linha = []; this.eventos = []; this.seg = new Map();
    this.criados = { sci: 0, scm: 0, leituras: 0, progresso: 0, aprovacoes: 0, tratativas: 0 };
    this.saude = { memMb: 0, loopMs: 0, pool: null }; this.picos = { loopMs: 0, memMb: 0, esperando: 0 };
    this.seq = 0; this.rodada = Date.now().toString(36).slice(-5).toUpperCase();
    this.cache = {};
  }
  ativa() { return ['preparando', 'rodando', 'parando'].includes(this.estado); }

  async iniciar(admin, base, opcoes) {
    if (this.ativa() || this.estado === 'limpando') throw Object.assign(new Error('Já existe uma simulação em andamento.'), { status: 409 });
    const q = {}; let total = 0;
    for (const p of PERFIS) { q[p] = Math.max(0, Math.min(40, Math.floor(Number(opcoes?.quantidades?.[p]) || 0))); total += q[p]; }
    if (!q.tecnico) throw Object.assign(new Error('Inclua ao menos um técnico (é quem abre as solicitações).'), { status: 400 });
    if (total > LIMITES.usuarios) throw Object.assign(new Error(`No máximo ${LIMITES.usuarios} usuários virtuais por vez.`), { status: 400 });
    const minutos = Math.max(0.2, Math.min(LIMITES.minutos, Number(opcoes?.minutos) || 3));
    const ritmo = RITMO[opcoes?.ritmo] ? opcoes.ritmo : 'normal';
    const rede = opcoes?.rede === 'nat' ? 'nat' : 'ips';
    this.zerar();
    this.cfg = { quantidades: q, total, minutos, ritmo, rede, admin: admin.nome || admin.email };
    this.estado = 'preparando'; this.base = base;
    this.evento('sistema', `Preparando ${total} usuários virtuais (${minutos} min, ritmo ${ritmo}, ${rede === 'nat' ? 'todos na mesma rede' : 'cada um no seu computador'}).`);
    try {
      const lista = await prepararUsuarios(admin, q);
      this.usuarios = lista.map((u, i) => ({
        ...u, ip: rede === 'nat' ? '10.99.255.1' : `10.99.${Math.floor(i / 250)}.${(i % 250) + 1}`,
        cookie: `${COOKIE}=${createSession({ id: u.id, sessaoVersao: u.sv }).valor}`,
        acao: 'entrando', n: 0, erros: 0, ultimoMs: 0
      }));
    } catch (e) {
      this.estado = 'parado'; this.erroFatal = `Não foi possível preparar os usuários virtuais: ${e.message}`;
      this.evento('erro', this.erroFatal); throw Object.assign(new Error(this.erroFatal), { status: 500 });
    }
    this.inicio = Date.now(); this.fimPrevisto = this.inicio + minutos * 60000; this.estado = 'rodando';
    this.evento('sistema', `Simulação começou com ${this.usuarios.length} usuários ao mesmo tempo.`);
    this.monitor();
    // cada usuário entra com um pequeno escalonamento (como num início de turno)
    this.trabalhos = this.usuarios.map((u, i) => dormir(Math.random() * 1500 + i * 60).then(() => this.vida(u)));
    Promise.allSettled(this.trabalhos).then(() => this.encerrar());
    return this.resumo();
  }

  parar() { if (this.estado === 'rodando') { this.estado = 'parando'; this.evento('sistema', 'Parada pedida: os usuários terminam o que estão fazendo.'); } }
  encerrar() {
    clearInterval(this.timer); this.loop?.disable?.();
    this.fim = Date.now(); this.estado = 'parado';
    this.evento('sistema', `Simulação encerrada: ${this.totais().req} requisições em ${Math.round((this.fim - this.inicio) / 1000)} s.`);
  }
  async limpar(admin) {
    if (this.ativa()) throw Object.assign(new Error('Pare a simulação antes de limpar.'), { status: 409 });
    this.estado = 'limpando';
    try { const r = await limparBanco(admin); this.evento('sistema', `Limpeza: ${r.registros} registros de teste apagados, ${r.usuarios} usuários virtuais desativados.`); return r; }
    finally { this.estado = 'parado'; }
  }

  /* ---------- medição */
  monitor() {
    try { this.loop = monitorEventLoopDelay({ resolution: 20 }); this.loop.enable(); } catch { this.loop = null; }
    let ultimo = 0;
    this.timer = setInterval(() => {
      const mem = Math.round(process.memoryUsage().rss / 1048576);
      const loopMs = this.loop ? Math.round(this.loop.percentile(99) / 1e6) : 0;
      this.loop?.reset?.();
      const pl = pool && typeof pool.totalCount === 'number' ? { total: pool.totalCount, ocioso: pool.idleCount, esperando: pool.waitingCount } : null;
      this.saude = { memMb: mem, loopMs, pool: pl };
      this.picos.memMb = Math.max(this.picos.memMb, mem); this.picos.loopMs = Math.max(this.picos.loopMs, loopMs);
      if (pl) this.picos.esperando = Math.max(this.picos.esperando, pl.esperando);
      const seg = Math.floor((Date.now() - this.inicio) / 1000);
      if (seg !== ultimo) { ultimo = seg; }
      if (this.linha.length > 1800) this.linha.splice(0, this.linha.length - 1800);
    }, 1000);
    this.timer.unref?.();
  }
  balde() {
    const t = Math.floor((Date.now() - this.inicio) / 1000);
    let b = this.linha[this.linha.length - 1];
    if (!b || b.t !== t) { b = { t, req: 0, erros: 0, ms: [], usuarios: 0 }; this.linha.push(b); }
    return b;
  }
  medir(nome, ms, status) {
    let a = this.acoes.get(nome);
    if (!a) { a = { nome, n: 0, erros: 0, conflitos: 0, limite: 0, tempos: [], codigos: {} }; this.acoes.set(nome, a); }
    a.n++; a.codigos[status] = (a.codigos[status] || 0) + 1;
    if (status === 409) a.conflitos++;
    else if (status === 429) a.limite++;
    else if (status >= 500 || status === 0) a.erros++;
    a.tempos.push(ms); if (a.tempos.length > 3000) a.tempos.splice(0, a.tempos.length - 3000);
    const b = this.balde(); b.req++; b.ms.push(ms); if (status >= 500 || status === 0) b.erros++;
  }
  evento(tipo, texto, u) {
    this.eventos.push({ em: new Date().toISOString(), tipo, texto, quem: u ? u.nome : '', perfil: u ? u.perfil : '' });
    if (this.eventos.length > 300) this.eventos.splice(0, this.eventos.length - 300);
  }
  seguranca(nome, ok, detalhe) {
    let s = this.seg.get(nome); if (!s) { s = { nome, n: 0, falhas: 0, detalhe: '' }; this.seg.set(nome, s); }
    s.n++; if (!ok) { s.falhas++; s.detalhe = detalhe || ''; this.evento('erro', `FALHA DE SEGURANÇA: ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
  }

  /** Requisição HTTP de verdade, como o navegador da pessoa faria. */
  async http(u, nome, method, url, body) {
    const t0 = performance.now();
    let s = 0, j = null;
    try {
      const r = await fetch(this.base + url, {
        method,
        headers: { cookie: u.cookie, origin: new URL(config.appBaseUrl).origin, 'x-forwarded-for': u.ip, 'content-type': 'application/json', 'user-agent': 'BIOMANUT-modo-de-teste' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      s = r.status;
      const tipo = r.headers.get('content-type') || '';
      if (tipo.includes('json')) j = await r.json().catch(() => null); else await r.arrayBuffer();
    } catch (e) { s = 0; j = { erro: e.name === 'TimeoutError' ? 'tempo esgotado (30 s)' : e.message }; }
    const ms = Math.round(performance.now() - t0);
    u.n++; u.ultimoMs = ms;
    this.medir(nome, ms, s);
    if (s >= 500 || s === 0) { u.erros++; this.evento('erro', `${nome}: ${s ? 'HTTP ' + s : 'sem resposta'} ${j?.erro ? '— ' + String(j.erro).slice(0, 140) : ''}`, u); }
    else if (s === 429) { u.erros++; this.evento('limite', `${nome}: limite de requisições (429)`, u); }
    return { s, j, ms };
  }

  /* ---------- a vida de um usuário virtual */
  async vida(u) {
    const [min, max] = RITMO[this.cfg.ritmo];
    await this.tarefa(u, 'Abrir o sistema', () => this.abrir(u));
    while (this.estado === 'rodando' && Date.now() < this.fimPrevisto) {
      const t = this.escolher(u);
      await this.tarefa(u, t.nome, t.fn);
      u.acao = 'pensando…';
      await dormir(min + Math.random() * (max - min));
    }
    u.acao = 'saiu';
    if (this.estado === 'rodando' && Date.now() >= this.fimPrevisto) this.estado = 'parando';
  }
  async tarefa(u, nome, fn) {
    u.acao = nome;
    try { await fn(); } catch (e) { u.erros++; this.evento('erro', `${nome}: ${e.message}`, u); }
  }
  escolher(u) {
    const T = this.tarefasDe(u);
    const total = T.reduce((s, t) => s + t.peso, 0);
    let r = Math.random() * total;
    for (const t of T) { r -= t.peso; if (r <= 0) return t; }
    return T[0];
  }
  tarefasDe(u) {
    const comuns = [{ nome: 'Abrir o sistema', peso: 1, fn: () => this.abrir(u) }];
    const L = {
      tecnico: [
        { nome: 'Abrir SCI', peso: 4, fn: () => this.novaSci(u) },
        { nome: 'Abrir SCM', peso: 4, fn: () => this.novaScm(u) },
        { nome: 'Acompanhar minhas solicitações', peso: 4, fn: () => this.minhas(u) },
        { nome: 'Corrigir SCM devolvida', peso: 2, fn: () => this.corrigirScm(u) },
        { nome: 'Lançar leitura de utilidade', peso: 2, fn: () => this.leitura(u) },
        { nome: 'Fazer treinamento', peso: 2, fn: () => this.treinamento(u) },
        { nome: 'Tentativa indevida', peso: 1, fn: () => this.indevidaTecnico(u) }
      ],
      lider: [
        { nome: 'Aprovar SCM do grupo', peso: 6, fn: () => this.aprovar(u) },
        { nome: 'Acompanhar solicitações', peso: 3, fn: () => this.minhas(u) },
        { nome: 'Consultar preventivas', peso: 1, fn: () => this.preventivas(u) }
      ],
      almoxarife: [
        { nome: 'Tratar fila da SCI', peso: 5, fn: () => this.tratarSci(u) },
        { nome: 'Tratar fila da SCM', peso: 5, fn: () => this.tratarScm(u) },
        { nome: 'Consultar cadastros', peso: 1, fn: () => this.cadastros(u) }
      ],
      pcm: [
        { nome: 'Tratar fila da SCI', peso: 4, fn: () => this.tratarSci(u) },
        { nome: 'Consultar cadastros', peso: 2, fn: () => this.cadastros(u) },
        { nome: 'Consultar preventivas', peso: 2, fn: () => this.preventivas(u) }
      ],
      gestor: [
        { nome: 'Painéis da gestão', peso: 4, fn: () => this.paineis(u) },
        { nome: 'Aprovar SCM do grupo', peso: 2, fn: () => this.aprovar(u) },
        { nome: 'Consultar preventivas', peso: 1, fn: () => this.preventivas(u) }
      ],
      viewer: [
        { nome: 'Painéis da gestão', peso: 3, fn: () => this.paineis(u) },
        { nome: 'Tentativa indevida', peso: 1, fn: () => this.indevidaViewer(u) }
      ]
    };
    return comuns.concat(L[u.perfil] || []);
  }

  /* ---------- tarefas */
  async abrir(u) {
    if (Math.random() < 0.25) await this.http(u, 'Página inicial (HTML)', 'GET', '/');
    await this.http(u, 'Sessão (auth/me)', 'GET', '/auth/me');
    await this.http(u, 'Minha conta', 'GET', '/api/conta/perfil');
  }
  id(tipo) { this.seq++; return `${PREFIXO}${tipo}-${this.rodada}-${String(this.seq).padStart(5, '0')}`; }
  async familias(u) {
    if (!this.cache.familias) {
      const r = await this.http(u, 'Cadastros (famílias da SCI)', 'GET', '/api/master-data?resource=familias');
      this.cache.familias = (r.j?.rows || []).filter(f => f.ativo !== false);
    }
    return this.cache.familias;
  }
  async listas(u) {
    if (!this.cache.listas) {
      const nomes = ['scm_time', 'scm_tipo_solicitacao', 'scm_urgencia', 'scm_tipo_fornecedor', 'scm_tipo_pedido', 'scm_centro_custo'];
      const out = {};
      for (const n of nomes) { const r = await this.http(u, 'Cadastros (listas da SCM)', 'GET', `/api/master-data?resource=lista&list=${n}`); out[n] = (r.j?.rows || []).filter(x => x.ativo !== false); }
      this.cache.listas = out;
    }
    return this.cache.listas;
  }
  async novaSci(u) {
    const fams = await this.familias(u);
    const fam = sorteio(fams.length ? fams : [{ id: 'outros', nome: 'Outros', campos: [] }]);
    const campos = {}; for (const c of fam.campos || []) campos[c.id_campo || c.id] = `[TESTE] ${c.label || 'valor'}`;
    const id = this.id('SCI');
    const r = await this.http(u, 'Abrir SCI', 'PUT', `/api/data/sci/${id}`, { expectedVersion: 0, payload: {
      id, codigo: `TESTE-${id.slice(-5)}`, familiaId: fam.id, familiaNome: fam.nome, campos, camposDefs: fam.campos || [],
      observacoes: '[TESTE] Solicitação gerada pelo modo de teste', marcas: '', link: '',
      solicitanteId: u.id, solicitanteNome: u.nome, dataCriacao: new Date().toISOString(), status: 'pendente', observacaoAlmoxarife: '', numeroProcessoME: ''
    } });
    if (r.s === 200) { this.criados.sci++; this.evento('acao', `abriu a SCI ${id.slice(-5)} (${fam.nome})`, u); }
  }
  async novaScm(u) {
    const L = await this.listas(u);
    const v = (n, d) => (sorteio(L[n]?.length ? L[n] : [{ codigo: d, nome: d }]));
    const id = this.id('SCM');
    const r = await this.http(u, 'Abrir SCM', 'PUT', `/api/data/scm/${id}`, { expectedVersion: 0, payload: {
      id, codigo: `TESTE-${id.slice(-5)}`, timeSolicitante: v('scm_time', 'Teste').nome, tipoSolicitacao: v('scm_tipo_solicitacao', 'normal').codigo,
      urgencia: v('scm_urgencia', 'media').codigo, centroCusto: v('scm_centro_custo', 'Teste').nome, numeroOM: '',
      tipoFornecedor: 'normal', nomeFornecedor: '', tipoPedido: v('scm_tipo_pedido', 'compra_material').codigo,
      descricaoUso: '[TESTE] Compra simulada pelo modo de teste', anexos: [], links: [],
      itens: [{ id: 'item-0', codigoSistema: `TESTE-${Math.floor(Math.random() * 9000 + 1000)}`, descricaoItem: '[TESTE] Item simulado', quantidade: String(1 + Math.floor(Math.random() * 5)) }],
      solicitanteId: u.id, solicitanteNome: u.nome, solicitanteEmail: u.email, solicitanteTime: 'Teste',
      dataCriacao: new Date().toISOString(), status: 'pendente_aprovacao_lider', observacaoLider: '', observacaoAlmoxarife: '', numeroProcessoME: ''
    } });
    if (r.s === 200) { this.criados.scm++; this.evento('acao', `abriu a SCM ${id.slice(-5)}`, u); }
  }
  async minhas(u) {
    const a = await this.http(u, 'Listar SCI', 'GET', '/api/data/sci');
    const b = await this.http(u, 'Listar SCM', 'GET', '/api/data/scm');
    // isolamento: técnico só pode ver as próprias solicitações
    if (u.perfil === 'tecnico') {
      const alheias = [...(a.j?.rows || []), ...(b.j?.rows || [])].filter(x => x.payload?.solicitanteId && x.payload.solicitanteId !== u.id);
      this.seguranca('Técnico só enxerga as próprias SCI/SCM', alheias.length === 0, alheias.length ? `${alheias.length} registro(s) de outra pessoa visível(is)` : '');
    }
    return { sci: a.j?.rows || [], scm: b.j?.rows || [] };
  }
  async gravar(u, nome, ns, row, mudanca) {
    const payload = { ...row.payload, ...mudanca };
    const r = await this.http(u, nome, 'PUT', `/api/data/${ns}/${row.recordId}`, { expectedVersion: row.version, payload });
    if (r.s === 409) this.evento('conflito', `${nome}: outra pessoa alterou ${row.recordId.slice(-5)} antes — releu e seguiu (conflito tratado)`, u);
    return r;
  }
  doTeste = x => String(x.recordId || '').startsWith(PREFIXO) && x.payload?._simulacao === true;
  async corrigirScm(u) {
    const { scm } = await this.minhas(u);
    const alvo = scm.find(x => this.doTeste(x) && x.payload.status === 'revisao_solicitada' && x.payload.solicitanteId === u.id);
    if (!alvo) return;
    const r = await this.gravar(u, 'Corrigir SCM devolvida', 'scm', alvo, { status: 'pendente_aprovacao_lider', descricaoUso: '[TESTE] Corrigida após revisão' });
    if (r.s === 200) this.evento('acao', `corrigiu e reenviou a SCM ${alvo.recordId.slice(-5)}`, u);
  }
  async aprovar(u) {
    const r0 = await this.http(u, 'Listar SCM', 'GET', '/api/data/scm');
    const fila = (r0.j?.rows || []).filter(x => this.doTeste(x) && x.payload.status === 'pendente_aprovacao_lider' && x.payload.solicitanteId !== u.id);
    const alvo = sorteio(fila.length ? fila : [null]); if (!alvo) return;
    const devolver = Math.random() < 0.15;
    const r = await this.gravar(u, devolver ? 'Devolver SCM para revisão' : 'Aprovar SCM', 'scm', alvo,
      devolver ? { status: 'revisao_solicitada', observacaoLider: '[TESTE] Revise a quantidade' } : { status: 'aprovada' });
    if (r.s === 200) { this.criados.aprovacoes++; this.evento('acao', `${devolver ? 'devolveu' : 'aprovou'} a SCM ${alvo.recordId.slice(-5)}`, u); }
    else if (r.s === 403) this.evento('negado', `não pôde decidir a SCM ${alvo.recordId.slice(-5)} (${r.j?.erro || 'recusado'})`, u);
  }
  async tratarSci(u) {
    const r0 = await this.http(u, 'Listar SCI', 'GET', '/api/data/sci');
    const fila = (r0.j?.rows || []).filter(x => this.doTeste(x) && ['pendente', 'aberto', 'aguardando_cadastro', 'em_compra'].includes(x.payload.status));
    const alvo = sorteio(fila.length ? fila : [null]); if (!alvo) return;
    const st = alvo.payload.status;
    const mud = st === 'aguardando_cadastro' || st === 'em_compra'
      ? { status: 'cadastrado', codigoItem: `MAN-TESTE-${Math.floor(Math.random() * 90000 + 10000)}` }
      : Math.random() < 0.1 ? { status: 'revisao_solicitante', observacaoAlmoxarife: '[TESTE] Falta a medida' } : { status: 'aguardando_cadastro' };
    const r = await this.gravar(u, 'Tratar SCI', 'sci', alvo, mud);
    if (r.s === 200) { this.criados.tratativas++; this.evento('acao', `SCI ${alvo.recordId.slice(-5)}: ${mud.status.replace(/_/g, ' ')}`, u); }
  }
  async tratarScm(u) {
    const r0 = await this.http(u, 'Listar SCM', 'GET', '/api/data/scm');
    const fila = (r0.j?.rows || []).filter(x => this.doTeste(x) && ['aprovada', 'em_tratativa'].includes(x.payload.status));
    const alvo = sorteio(fila.length ? fila : [null]); if (!alvo) return;
    const mud = alvo.payload.status === 'aprovada' ? { status: 'em_tratativa' } : { status: 'concluida', numeroProcessoME: `ME-TESTE-${Math.floor(Math.random() * 90000 + 10000)}` };
    const r = await this.gravar(u, 'Tratar SCM', 'scm', alvo, mud);
    if (r.s === 200) { this.criados.tratativas++; this.evento('acao', `SCM ${alvo.recordId.slice(-5)}: ${mud.status.replace(/_/g, ' ')}`, u); }
  }
  async leitura(u) {
    const m = await this.http(u, 'Utilidades (medidores)', 'GET', '/api/data/utility_meters');
    const med = sorteio((m.j?.rows || []).filter(x => !x.deleted && x.payload) .concat([null]));
    await this.http(u, 'Utilidades (leituras)', 'GET', '/api/data/utility_readings');
    const id = this.id('UTL');
    const r = await this.http(u, 'Lançar leitura de utilidade', 'PUT', `/api/data/utility_readings/${id}`, { expectedVersion: 0, payload: {
      id, meterId: med?.payload?.id || 'teste', meterName: med?.payload?.name || '[TESTE] Medidor', reading: Math.round(Math.random() * 100000) / 10,
      consumption: null, photo: false, observation: '[TESTE] Leitura simulada', user: u.email, at: new Date().toISOString()
    } });
    if (r.s === 200) { this.criados.leituras++; this.evento('acao', `lançou leitura em ${med?.payload?.name || 'medidor de teste'}`, u); }
  }
  async treinamento(u) {
    const c = await this.http(u, 'Treinamentos (cursos)', 'GET', '/api/data/lms_courses');
    const curso = sorteio((c.j?.rows || []).filter(x => !x.deleted).concat([null]));
    if (!curso) return;
    const p = await this.http(u, 'Treinamentos (meu progresso)', 'GET', '/api/data/lms_progress');
    const cid = curso.payload?.id || curso.recordId, rid = `${u.id}__${cid}`;
    // regravar o progresso que já existe exige a versão lida (senão 428), como a tela faz; o novo vai com 0
    const atual = (p.j?.rows || []).find(x => x.recordId === rid);
    const r = await this.http(u, 'Fazer treinamento', 'PUT', `/api/data/lms_progress/${rid}`, { expectedVersion: atual ? Number(atual.version) : 0, payload: {
      id: rid, usuarioId: u.id, user_name: u.nome, course_id: cid, version: 1, enrolled_at: new Date().toISOString(), started_at: new Date().toISOString(),
      last_lesson_id: null, lessons: {}, attempts: [], completed_at: null, score: null, certificate_code: null, expires_at: null, extra_attempts: 0, notes: {}, history: []
    } });
    if (r.s === 200) this.criados.progresso++;
  }
  async preventivas(u) { await this.http(u, 'Preventivas (painel)', 'GET', '/api/pcm/preventivas/painel'); }
  async cadastros(u) {
    this.cache.listas = null; this.cache.familias = null;
    await this.listas(u); await this.familias(u);
    await this.http(u, 'Cadastros (CAMM)', 'GET', '/api/master-data?resource=camm');
  }
  async paineis(u) {
    for (const ns of ['sci', 'scm', 'utility_meters', 'utility_readings', 'lms_courses']) await this.http(u, `Painel: ${ns}`, 'GET', `/api/data/${ns}`);
    if (u.perfil !== 'viewer') await this.http(u, 'Preventivas (painel)', 'GET', '/api/pcm/preventivas/painel');
  }
  async indevidaTecnico(u) {
    const tipo = Math.floor(Math.random() * 3);
    if (tipo === 0) {
      const { scm } = await this.minhas(u);
      const minha = scm.find(x => this.doTeste(x) && x.payload.solicitanteId === u.id && x.payload.status === 'pendente_aprovacao_lider');
      if (!minha) return;
      const r = await this.http(u, 'Tentativa indevida: aprovar a própria SCM', 'PUT', `/api/data/scm/${minha.recordId}`, { expectedVersion: minha.version, payload: { ...minha.payload, status: 'aprovada' } });
      this.seguranca('Ninguém aprova a própria SCM', r.s === 403, `respondeu ${r.s}`);
    } else if (tipo === 1) {
      const r = await this.http(u, 'Tentativa indevida: editar cadastros', 'POST', '/api/master-data?resource=lista&list=scm_urgencia', { codigo: 'teste', nome: '[TESTE]' });
      this.seguranca('Técnico não edita os cadastros do PCM', r.s === 403, `respondeu ${r.s}`);
    } else {
      const r = await this.http(u, 'Tentativa indevida: abrir o modo de teste', 'GET', '/api/admin/simulacao/estado');
      this.seguranca('Só o admin acessa o modo de teste', r.s === 403, `respondeu ${r.s}`);
    }
  }
  async indevidaViewer(u) {
    const r = await this.http(u, 'Tentativa indevida: abrir SCI em nome de outro', 'PUT', `/api/data/sci/${this.id('SCI')}`, { expectedVersion: 0, payload: { solicitanteId: '00000000-0000-0000-0000-000000000000', status: 'pendente' } });
    this.seguranca('Visualizador não abre solicitação', r.s === 403, `respondeu ${r.s}`);
  }

  /* ---------- relatório */
  totais() {
    let req = 0, erros = 0, conflitos = 0, limite = 0; const tempos = [];
    for (const a of this.acoes.values()) { req += a.n; erros += a.erros; conflitos += a.conflitos; limite += a.limite; tempos.push(...a.tempos); }
    return { req, erros, conflitos, limite, p50: percentil(tempos, 50), p95: percentil(tempos, 95), max: tempos.length ? Math.max(...tempos) : 0 };
  }
  resultado(t) {
    const out = [], dur = Math.max(1, ((this.fim || Date.now()) - this.inicio) / 1000);
    if (!t.req) return out;
    out.push(t.erros ? { tom: 'ruim', texto: `${t.erros} erro(s) de servidor ou sem resposta em ${t.req} requisições — ver a lista de eventos.` }
      : { tom: 'bom', texto: `Nenhum erro de servidor em ${t.req} requisições (${(t.req / dur).toFixed(1)} por segundo).` });
    out.push(t.p95 <= 1500 ? { tom: 'bom', texto: `95% das respostas em até ${t.p95} ms (mediana ${t.p50} ms).` }
      : { tom: 'atencao', texto: `95% das respostas em até ${t.p95} ms — acima de 1,5 s, a pessoa sente a lentidão.` });
    if (t.limite) out.push({ tom: 'ruim', texto: this.cfg.rede === 'nat'
      ? `${t.limite} requisições recusadas pelo limite por IP (240/min). Se a fábrica inteira sai por um IP só, o limite é dividido entre todos — precisa ajustar antes de liberar para a equipe.`
      : `${t.limite} requisições recusadas pelo limite de requisições (429).` });
    else if (this.cfg.rede === 'nat') out.push({ tom: 'bom', texto: 'Todos na mesma rede: nenhuma requisição barrada pelo limite por IP.' });
    if (t.conflitos) out.push({ tom: 'bom', texto: `${t.conflitos} edição(ões) simultânea(s) no mesmo registro: o sistema recusou a segunda e ninguém perdeu dado (conflito tratado).` });
    const falhas = [...this.seg.values()].filter(s => s.falhas);
    const testes = [...this.seg.values()].reduce((s, x) => s + x.n, 0);
    if (testes) out.push(falhas.length ? { tom: 'ruim', texto: `Segurança: ${falhas.length} verificação(ões) falharam — ver o quadro de segurança.` }
      : { tom: 'bom', texto: `Segurança: ${testes} tentativas indevidas durante a carga, todas recusadas.` });
    if (this.picos.esperando) out.push({ tom: 'atencao', texto: `Banco: até ${this.picos.esperando} consulta(s) esperando conexão livre — considere aumentar o pool (DATABASE_POOL_MAX).` });
    if (this.picos.loopMs > 200) out.push({ tom: 'atencao', texto: `Servidor ocupado: atraso de até ${this.picos.loopMs} ms no processamento (event loop).` });
    return out;
  }
  resumo(detalhe = true) {
    const t = this.totais(), agora = Date.now();
    const decorrido = this.inicio ? Math.round(((this.fim || agora) - this.inicio) / 1000) : 0;
    const ultimos = this.linha.slice(-5), rps = ultimos.length ? ultimos.reduce((s, b) => s + b.req, 0) / ultimos.length : 0;
    const base = {
      estado: this.estado, config: this.cfg, inicio: this.inicio || null, fimPrevisto: this.fimPrevisto || null, decorrido, erroFatal: this.erroFatal,
      kpis: { usuarios: this.usuarios.filter(u => u.acao !== 'saiu').length, ...t, rps: Math.round(rps * 10) / 10,
        seguranca: [...this.seg.values()].reduce((s, x) => s + x.n, 0), segurancaFalhas: [...this.seg.values()].reduce((s, x) => s + x.falhas, 0) },
      criados: this.criados, saude: this.saude, picos: this.picos
    };
    if (!detalhe) return base;
    return { ...base,
      usuarios: this.usuarios.map(u => ({ nome: u.nome, perfil: u.perfil, acao: u.acao, n: u.n, erros: u.erros, ultimoMs: u.ultimoMs })),
      acoes: [...this.acoes.values()].map(a => ({ nome: a.nome, n: a.n, erros: a.erros, conflitos: a.conflitos, limite: a.limite, p50: percentil(a.tempos, 50), p95: percentil(a.tempos, 95), max: a.tempos.length ? Math.max(...a.tempos) : 0, codigos: a.codigos }))
        .sort((x, y) => y.n - x.n),
      linha: this.linha.slice(-180).map(b => ({ t: b.t, req: b.req, erros: b.erros, p95: percentil(b.ms, 95) })),
      eventos: this.eventos.slice(-80).reverse(),
      seguranca: [...this.seg.values()],
      resultado: this.estado === 'parado' && this.fim ? this.resultado(t) : []
    };
  }
}

const simulacao = new Simulacao();
module.exports = { simulacao, Simulacao, PERFIS, ROTULO, LIMITES, equipeReal, limparBanco };
