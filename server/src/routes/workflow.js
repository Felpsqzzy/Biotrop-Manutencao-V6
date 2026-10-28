// Fluxo de aprovação da SCI e da SCM, conferido pelo SERVIDOR a cada gravação.
// Módulo puro: recebe o registro antes/depois e quem está agindo; devolve null
// (permitido) ou a mensagem de recusa. A tela usa as mesmas regras só para decidir
// quais botões mostrar (web/src/almox/requests.js).
//
// Papéis:
//   solicitante — quem abriu (solicitanteId)
//   aprovador   — responsável do grupo do solicitante (ou exceção cadastrada) e,
//                 acima dele, gestor/admin. Ninguém aprova o próprio pedido.
//   compras     — almoxarifado da SCM: admin, gestor, almoxarife; e o PCM, só nas SCMs de
//                 "Contratação de Serviço (PCM)" (o PCM abre a RC dos serviços)
//   cadastro    — quem trata a SCI: admin, gestor, almoxarife (o PCM não trata SCI)

const COMPRAS = new Set(['admin', 'gestor', 'almoxarife']);
const CADASTRO = new Set(['admin', 'gestor', 'almoxarife']);
// As listas da SCM são editáveis (cadastros): o valor gravado pode ser o código (contratacao_servico_pcm) ou o nome
// ("Contratação de Serviço (PCM)"). As regras aceitam os dois.
const ehServicoPcm = v => v === 'contratacao_servico_pcm' || /servi[cç]o.*pcm/i.test(String(v || ''));
const ehCapex = v => /capex/i.test(String(v || ''));
const fornecedorNomeado = v => /^(escolhido|exclusivo)$/i.test(String(v || '').trim());
const OM = /^OM\d{8}$/;
const ACIMA_DO_LIDER = new Set(['admin', 'gestor']);
const NOTAS = new Set(['observacaoLider', 'observacaoAlmoxarife']);

// Nomes antigos que a tela converte ao salvar: não contam como mudança de status.
const SCI_LEGADO = { pendente: 'aberto', aprovado: 'em_compra', solicitado_cadastro: 'aguardando_cadastro', recusado: 'rejeitada', reprovada: 'rejeitada' };

const FLOW = {
  scm: {
    inicial: ['pendente_aprovacao_lider'],
    // O solicitante só edita quando pedem revisão (o gestor antes de aprovar, ou o almoxarifado depois).
    // Aprovada, a SCM não muda mais pelas mãos do solicitante.
    editavelPeloSolicitante: ['revisao_solicitada', 'revisao_almoxarifado'],
    passos: {
      pendente_aprovacao_lider: { aprovada: 'aprovador', reprovada: 'aprovador', revisao_solicitada: 'aprovador' },
      revisao_solicitada: { pendente_aprovacao_lider: 'solicitante' },
      // em_tratativa = "RC aberta" (todos os itens na RC); parcial = "RC aberta parcial" (itens ainda sem código
      // cadastrado ficam de fora e entram depois). O almoxarifado pode devolver ao solicitante se faltar informação.
      aprovada: { em_tratativa: 'compras', parcial: 'compras', revisao_almoxarifado: 'compras' },
      revisao_almoxarifado: { aprovada: 'solicitante' },
      parcial: { em_tratativa: 'compras', concluida: 'compras', revisao_almoxarifado: 'compras' },
      em_tratativa: { concluida: 'compras' }
    },
    exige: {
      reprovada: ['observacaoLider', 'Explique o motivo da reprovação.'],
      revisao_solicitada: ['observacaoLider', 'Diga o que precisa ser revisado.'],
      revisao_almoxarifado: ['observacaoAlmoxarife', 'Diga ao solicitante o que falta ou está errado.'],
      em_tratativa: ['numeroProcessoME', 'Informe o nº do processo no ME para abrir a RC.'],
      parcial: ['numeroProcessoME', 'Informe o nº do processo no ME para abrir a RC.'],
      concluida: ['numeroProcessoME', 'Informe o número do processo no ME para concluir.']
    },
    // Campos que só quem cuida da compra altera (o solicitante corrige o pedido, não o atendimento).
    soCompras: ['numeroProcessoME', 'observacaoAlmoxarife', 'responsavelCompra']
  },
  sci: {
    inicial: ['aberto'],
    editavelPeloSolicitante: ['aberto', 'revisao_solicitante'],
    passos: {
      // "Enviar para compra" saiu da SCI (gerava confusão com a SCM); em_compra fica só para pedidos antigos.
      aberto: { aguardando_cadastro: 'cadastro', revisao_solicitante: 'cadastro', rejeitada: 'cadastro' },
      pendente_aprovacao: { aguardando_cadastro: 'cadastro', revisao_solicitante: 'cadastro', rejeitada: 'cadastro' },
      revisao_solicitante: { pendente_aprovacao: 'solicitante' },
      aguardando_cadastro: { cadastrado: 'cadastro', rejeitada: 'cadastro' },
      em_compra: { cadastrado: 'cadastro', aguardando_cadastro: 'cadastro' }
    },
    exige: {
      aguardando_cadastro: ['numeroSolicitacaoCadastro', 'Informe o nº da solicitação de cadastro.'],
      revisao_solicitante: ['observacaoAlmoxarife', 'Diga ao solicitante o que corrigir.'],
      rejeitada: ['observacaoAlmoxarife', 'Explique o motivo da rejeição.'],
      cadastrado: ['codigoItem', 'Informe o código do item cadastrado.']
    }
  }
};

/** Situação de cada item da SCM: pendente (padrão), atendido ou cancelado. */
const SITUACOES = new Set(['pendente', 'atendido', 'cancelado']);
function situacao(it) { const s = String((it && it.situacao) || 'pendente'); return SITUACOES.has(s) ? s : null; }
function itensSituacao(rec) { return (Array.isArray(rec && rec.itens) ? rec.itens : []).map(situacao); }
/** Regras do atendimento por item: null = ok; string = motivo da recusa. */
function checkItens(before, next, to, roles) {
  if (next.itens != null && !Array.isArray(next.itens)) return 'Lista de itens inválida.';
  const sit = itensSituacao(next);
  if (sit.some(s => s === null)) return 'Situação de item inválida (use pendente, atendido ou cancelado).';
  // O solicitante corrige descrição/quantidade, mas não marca item como atendido nem cancela atendimento.
  if (!roles.compras) {
    const antes = new Map((Array.isArray(before && before.itens) ? before.itens : []).map(it => [String(it && it.id), it]));
    const mexeu = (next.itens || []).some(it => {
      const a = antes.get(String(it && it.id));
      return situacao(it) !== situacao(a) || ['atendidoEm', 'atendidoPor'].some(k => String(it?.[k] || '') !== String(a?.[k] || ''));
    });
    if (mexeu) return 'Só o almoxarifado marca a situação dos itens.';
  }
  if (to === 'parcial') {
    if (!sit.includes('atendido')) return 'Para a RC aberta parcial, marque ao menos um item incluído na RC.';
    if (!sit.includes('pendente')) return 'Todos os itens estão na RC: use "RC aberta".';
  }
  if ((to === 'concluida' || to === 'em_tratativa') && sit.includes('pendente') && sit.some(s => s !== 'pendente')) {
    return to === 'em_tratativa' ? 'Ainda há itens fora da RC: inclua todos ou use "RC aberta parcial".'
      : 'Ainda há itens sem RC: inclua na RC ou cancele antes de concluir.';
  }
  return null;
}

/** Campos do formulário da SCM conferidos no servidor (na abertura e quando mudam): formato da OM, nº do projeto
 *  no CAPEX e nome do fornecedor quando ele é escolhido ou exclusivo. */
function checkCamposScm(before, next) {
  const mudou = k => !before || String(next[k] ?? '') !== String(before[k] ?? '');
  if (mudou('numeroOM') && next.numeroOM && !OM.test(String(next.numeroOM))) return 'Nº OM no formato OM00000000 (ex.: OM00048601).';
  if ((mudou('tipoSolicitacao') || mudou('capexProjeto')) && ehCapex(next.tipoSolicitacao) && !String(next.capexProjeto || '').trim()) return 'Informe o número do projeto (CAPEX).';
  if ((mudou('tipoFornecedor') || mudou('nomeFornecedor')) && fornecedorNomeado(next.tipoFornecedor) && !String(next.nomeFornecedor || '').trim()) return 'Informe o nome do fornecedor escolhido/exclusivo.';
  return null;
}

function norm(ns, status) {
  const s = String(status || '');
  return ns === 'sci' ? (SCI_LEGADO[s] || s) : s;
}
function same(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

/** Quais papéis a pessoa tem neste registro. `lideraSolicitante` vem do banco. */
function rolesOf(ns, record, actor) {
  const r = record || {};
  const requester = !!actor.id && String(r.solicitanteId || '') === String(actor.id);
  const namedApprover = (r.aprovadorId && String(r.aprovadorId) === String(actor.id)) || (r.solicitanteEmailLider && same(r.solicitanteEmailLider, actor.email));
  return {
    solicitante: requester,
    aprovador: !requester && (Boolean(namedApprover) || Boolean(actor.lideraSolicitante) || ACIMA_DO_LIDER.has(actor.perfilId)),
    compras: COMPRAS.has(actor.perfilId) || (actor.perfilId === 'pcm' && ehServicoPcm(r.tipoPedido)),
    cadastro: CADASTRO.has(actor.perfilId)
  };
}

/** null = permitido; string = motivo da recusa. */
function check(ns, before, after, actor) {
  const f = FLOW[ns];
  if (!f) return null;
  const next = after || {};
  if (!before) {
    // Criação: sempre em nome de quem está logado e no status inicial.
    if (String(next.solicitanteId || '') !== String(actor.id)) return 'A solicitação precisa ser aberta em seu próprio nome.';
    if (!f.inicial.includes(norm(ns, next.status))) return 'Uma solicitação nova começa sempre no primeiro passo do fluxo.';
    if (ns === 'scm') {
      const campo = checkCamposScm(null, next);
      if (campo) return campo;
      // Na abertura todos agem como solicitantes: atendimento começa depois da aprovação.
      if (f.soCompras.some(k => String(next[k] ?? '').trim()) || String(next.observacaoLider || '').trim()) {
        return 'Uma solicitação nova não pode trazer campos de aprovação ou atendimento.';
      }
      return checkItens(null, next, next.status, { compras: false });
    }
    return null;
  }
  if (String(next.solicitanteId || '') !== String(before.solicitanteId || '')) return 'O solicitante não pode ser trocado.';
  if (ns === 'scm') { const campo = checkCamposScm(before, next); if (campo) return campo; }
  const from = norm(ns, before.status), to = norm(ns, next.status);
  const roles = rolesOf(ns, before, actor);
  if (from === to) {
    // Sem mudança de status: edição só de quem cuida da etapa, ou do próprio solicitante enquanto pode corrigir.
    const gestao = ns === 'scm' ? roles.compras : roles.cadastro;
    if (gestao || ACIMA_DO_LIDER.has(actor.perfilId)) return ns === 'scm' ? checkItens(before, next, to, { ...roles, compras: roles.compras || ACIMA_DO_LIDER.has(actor.perfilId) }) : null;
    if (roles.solicitante && f.editavelPeloSolicitante.includes(from)) {
      if (ns === 'scm' && (next.aprovadorId !== before.aprovadorId || !same(next.solicitanteEmailLider, before.solicitanteEmailLider))) return 'O aprovador é definido pelo grupo, não pelo solicitante.';
      const proibido = (f.soCompras || []).find(k => String(next[k] ?? '') !== String(before[k] ?? ''));
      if (proibido) return 'Este campo é do almoxarifado: o solicitante não altera.';
      return ns === 'scm' ? checkItens(before, next, to, roles) : null;
    }
    return 'Nesta etapa você não pode alterar a solicitação.';
  }
  const need = (f.passos[from] || {})[to];
  if (!need) return `A solicitação não pode ir de "${from || 'sem status'}" para "${to}".`;
  if (!roles[need]) {
    if (need === 'aprovador' && roles.solicitante) return 'Você não pode aprovar a sua própria solicitação.';
    return {
      aprovador: 'Só o responsável do grupo do solicitante (ou a gestão) decide esta aprovação.',
      solicitante: 'Só quem abriu a solicitação pode reenviá-la.',
      compras: 'Só o almoxarifado (ou o PCM, nas SCMs de serviço) abre a RC desta SCM.',
      cadastro: 'Só o almoxarifado trata o cadastro do item.'
    }[need];
  }
  const req = f.exige[to];
  if (req && !String(next[req[0]] || '').trim()) return req[1];
  // Motivo/observação precisa ser escrito nesta decisão: o texto de uma etapa anterior não vale de novo.
  if (req && NOTAS.has(req[0]) && String(next[req[0]] || '').trim() === String(before[req[0]] || '').trim()) return req[1];
  if (ns === 'scm') {
    // reenviar após revisão: o solicitante pode ter corrigido o pedido, mas não o que é do almoxarifado
    if (need === 'solicitante') {
      const proibido = (f.soCompras || []).find(k => String(next[k] ?? '') !== String(before[k] ?? ''));
      if (proibido) return 'Este campo é do almoxarifado: o solicitante não altera.';
    }
    return checkItens(before, next, to, roles);
  }
  return null;
}

/** Exclusão: só a gestão da etapa (compras na SCM, cadastro na SCI) ou o solicitante enquanto pode corrigir. null = permitido. */
function checkExclusao(ns, before, actor) {
  const f = FLOW[ns];
  if (!f) return null;
  if (!before) return 'Solicitação inexistente ou já excluída.';
  const roles = rolesOf(ns, before, actor);
  const gestao = ns === 'scm' ? roles.compras : roles.cadastro;
  if (gestao || (roles.solicitante && f.editavelPeloSolicitante.includes(norm(ns, before.status)))) return null;
  return 'Só a gestão ou o solicitante (antes da aprovação) podem excluir.';
}

module.exports = { FLOW, rolesOf, check, checkExclusao, norm, situacao };
