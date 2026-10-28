/**
 * Manutinho no modo demonstração: dados FICTÍCIOS ([DEMO], equipamentos inventados, nada da planta) passados pelas
 * mesmas regras do pacote compartilhado que o servidor usa. As datas andam com o dia de hoje.
 */
import {
  contarNiveisManutinho,
  itensAprovacoes,
  itensBateladas,
  itensMedidores,
  itensPreventivas,
  itensSolicitacoesParadas,
  itensTreinamentos,
  itensValvulas,
  medidoresSemLeitura,
  montarRelatorioManutinho,
  ordenarItensManutinho,
  utilManutinho,
  type EquipamentoManutinho,
  type FolhaManutinho,
  type ItemManutinho,
  type ModuloManutinho,
  type RespostaResumoManutinho,
  type TreinamentoVencidoManutinho,
} from '@biomanut/shared';
import type { RotaDemo } from '../../demo/tipos';

const BASE = '/api/manutinho';
const EQUIPE = new Set(['admin', 'gestor', 'pcm', 'lider', 'tecnico']);
const SOLICITANTES = new Set(['admin', 'gestor', 'pcm', 'almoxarife', 'lider', 'tecnico']);
const MEDIDORES = new Set(['admin', 'gestor', 'pcm']);

function perfilDemo(): string {
  return new URLSearchParams(globalThis.location?.search || '').get('perfil') || 'admin';
}
function hojeLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dia = (n: number) => utilManutinho.somaDias(hojeLocal(), n);
const ha = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();

const EQUIPAMENTOS: EquipamentoManutinho[] = [
  {
    id: 'd1',
    codigo: 'DEMO-FER-01',
    nome: '[DEMO] Fermentador 1',
    camm: 'CAMM 1',
    local: '[DEMO] Fermentação',
    ultimaConcluida: null,
  },
  {
    id: 'd2',
    codigo: 'DEMO-FER-02',
    nome: '[DEMO] Fermentador 2',
    camm: 'CAMM 1',
    local: '[DEMO] Fermentação',
    ultimaConcluida: null,
  },
  {
    id: 'd3',
    codigo: 'DEMO-FER-03',
    nome: '[DEMO] Fermentador 3',
    camm: 'CAMM 1',
    local: '[DEMO] Fermentação',
    ultimaConcluida: null,
  },
  {
    id: 'd4',
    codigo: 'DEMO-PRO-01',
    nome: '[DEMO] Propagador 1',
    camm: 'CAMM 2',
    local: '[DEMO] Propagação',
    ultimaConcluida: null,
  },
  {
    id: 'd5',
    codigo: 'DEMO-PRO-02',
    nome: '[DEMO] Propagador 2',
    camm: 'CAMM 2',
    local: '[DEMO] Propagação',
    ultimaConcluida: null,
  },
  {
    id: 'd6',
    codigo: 'DEMO-MIS-01',
    nome: '[DEMO] Misturador 1',
    camm: 'CAMM 3',
    local: '[DEMO] Mistura',
    ultimaConcluida: null,
  },
];

function relatorio() {
  const eqs = EQUIPAMENTOS.map((e, i) => ({ ...e, ultimaConcluida: dia(-30 - i * 7) }));
  const folhas: FolhaManutinho[] = [
    { id: 'f1', ativoId: 'd1', numeroOm: 'OM-DEMO-1', dataPrevista: dia(-6), status: 'aberta' },
    { id: 'f2', ativoId: 'd2', numeroOm: 'OM-DEMO-2', dataPrevista: dia(3), status: 'aberta' },
    { id: 'f3', ativoId: 'd4', numeroOm: 'OM-DEMO-3', dataPrevista: dia(-2), status: 'em_execucao' },
    { id: 'f4', ativoId: 'd5', numeroOm: 'OM-DEMO-4', dataPrevista: dia(10), status: 'aberta' },
  ];
  return montarRelatorioManutinho(eqs, folhas, hojeLocal());
}

function vencidos(perfil: string): TreinamentoVencidoManutinho[] {
  const todos: TreinamentoVencidoManutinho[] = [
    {
      pessoaId: 'demo-p1',
      pessoa: '[DEMO] Ana Exemplo',
      cursoId: 'c1',
      curso: '[DEMO] Segurança em máquinas',
      prazo: ha(12),
      refazer: false,
    },
    {
      pessoaId: 'demo-p2',
      pessoa: '[DEMO] Bruno Exemplo',
      cursoId: 'c1',
      curso: '[DEMO] Segurança em máquinas',
      prazo: ha(5),
      refazer: false,
    },
    {
      pessoaId: 'demo-p2',
      pessoa: '[DEMO] Bruno Exemplo',
      cursoId: 'c2',
      curso: '[DEMO] Bloqueio de energia',
      prazo: ha(2),
      refazer: true,
    },
  ];
  // perfis que só acompanham a si mesmos: na demo, a própria pessoa não tem curso vencido
  return ['admin', 'gestor', 'pcm', 'lider'].includes(perfil) ? todos : [];
}

function resumo(): RespostaResumoManutinho {
  const perfil = perfilDemo(),
    hoje = hojeLocal(),
    agora = new Date().toISOString(),
    ontem = dia(-1);
  const fontes: ModuloManutinho[] = [];
  const itens: ItemManutinho[] = [];
  if (EQUIPE.has(perfil)) {
    itens.push(...itensPreventivas(relatorio()));
    itens.push(
      ...itensValvulas([
        { ativoCodigo: 'DEMO-FER-01', tag: 'DEMO-V-101', estado: 1 },
        { ativoCodigo: 'DEMO-PRO-02', tag: 'DEMO-V-205', estado: 2 },
      ]),
    );
    itens.push(
      ...itensBateladas([
        { codigo: 'DEMO-FER-02', faixa: 'vencido', desdePreventiva: 19, frequencia: 18 },
        { codigo: 'DEMO-PRO-01', faixa: 'alerta', desdePreventiva: 16, frequencia: 18 },
      ]),
    );
    fontes.push('preventivas', 'valvulas', 'bateladas');
  }
  if (SOLICITANTES.has(perfil)) {
    itens.push(
      ...itensSolicitacoesParadas(
        [
          { namespace: 'scm', recordId: 'SCM-DEMO-0007', status: 'aprovada', atualizadoEm: ha(6) },
          { namespace: 'sci', recordId: 'SCI-DEMO-0003', status: 'aguardando_cadastro', atualizadoEm: ha(5) },
        ],
        agora,
      ),
    );
    if (['admin', 'gestor', 'lider'].includes(perfil))
      itens.push(
        ...itensAprovacoes(
          [{ namespace: 'scm', recordId: 'SCM-DEMO-0011', status: 'pendente_aprovacao_lider', atualizadoEm: ha(1) }],
          agora,
        ),
      );
    fontes.push('solicitacoes', 'aprovacoes');
  }
  if (MEDIDORES.has(perfil)) {
    const sem = medidoresSemLeitura(
      [
        { id: 'm1', nome: '[DEMO] Medidor de água', ativo: true },
        { id: 'm2', nome: '[DEMO] Medidor de gás', ativo: true },
      ],
      [{ medidorId: 'm1', dia: ontem }],
      ontem,
    );
    itens.push(...itensMedidores(sem, ontem));
    fontes.push('medidores');
  }
  itens.push(...itensTreinamentos(vencidos(perfil)));
  fontes.push('treinamentos');
  const ordenados = ordenarItensManutinho(itens);
  return { ok: true, hoje, fontes, itens: ordenados, contagem: contarNiveisManutinho(ordenados) };
}

export const rotas: RotaDemo[] = [
  ({ method, path }) => (method === 'GET' && path === `${BASE}/resumo` ? { status: 200, corpo: resumo() } : undefined),
  ({ method, path }) => {
    if (method !== 'GET' || path !== `${BASE}/relatorio-preventivas`) return undefined;
    if (!EQUIPE.has(perfilDemo()))
      return { status: 403, corpo: { ok: false, erro: 'Seu perfil não acessa as preventivas.' } };
    return { status: 200, corpo: { ok: true, ...relatorio() } };
  },
  ({ method, path }) =>
    method === 'GET' && path === `${BASE}/treinamentos-vencidos`
      ? { status: 200, corpo: { ok: true, vencidos: vencidos(perfilDemo()) } }
      : undefined,
  ({ method, path, body }) => {
    if (method !== 'POST' || path !== `${BASE}/cobrar`) return undefined;
    if (!['admin', 'gestor', 'lider'].includes(perfilDemo()))
      return { status: 403, corpo: { ok: false, erro: 'Só administrador, gestor e líder de grupo enviam cobrança.' } };
    const itens = (body as { itens?: { pessoaId: string }[] } | undefined)?.itens ?? [];
    return {
      status: 200,
      corpo: {
        ok: true,
        enviados: itens.length,
        resultado: itens.map((i) => ({ pessoaId: i.pessoaId, resultado: 'ok' })),
        avisos: [],
      },
    };
  },
];
