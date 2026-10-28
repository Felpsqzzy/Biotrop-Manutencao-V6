// Regras do Manutinho com data fixa (28/10/2026). Equipamentos, pessoas e cursos fictícios ([TESTE]).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  buscarGuia,
  contarNiveisManutinho,
  cursoValePara,
  diasParado,
  GUIA_MANUTINHO,
  itensAprovacoes,
  itensBateladas,
  itensMedidores,
  itensPreventivas,
  itensSolicitacoesParadas,
  itensTreinamentos,
  itensValvulas,
  medidoresSemLeitura,
  modeloCobranca,
  montarRelatorioManutinho,
  nivelValvulaManutinho,
  ordenarItensManutinho,
  prazoTreinamento,
  setorManutinho,
  situacaoEquipamentoManutinho,
  treinamentosVencidos,
  utilManutinho,
  type CursoManutinho,
  type EquipamentoManutinho,
  type FolhaManutinho,
  type ItemManutinho,
} from '../src/index.js';

const HOJE = '2026-10-28';
const AGORA = '2026-10-28T12:00:00.000Z';

const eq = (id: string, codigo: string, local = '', camm = ''): EquipamentoManutinho => ({
  id,
  codigo,
  nome: `[TESTE] ${codigo}`,
  local,
  camm,
  ultimaConcluida: null,
});
const folha = (ativoId: string, dataPrevista: string, status: FolhaManutinho['status'] = 'aberta'): FolhaManutinho => ({
  id: `f-${ativoId}-${dataPrevista}`,
  ativoId,
  numeroOm: null,
  dataPrevista,
  status,
});

describe('datas', () => {
  it('dias entre, soma e formato brasileiro', () => {
    expect(utilManutinho.diasEntre('2026-10-20', HOJE)).toBe(8);
    expect(utilManutinho.somaDias(HOJE, -1)).toBe('2026-10-27');
    expect(utilManutinho.somaDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(utilManutinho.dataBr(HOJE)).toBe('28/10/2026');
    expect(utilManutinho.ehDia('2026-02-30')).toBe(true); // formato; a rota valida o dia de verdade
    expect(utilManutinho.ehDia('28/10/2026')).toBe(false);
    expect(utilManutinho.listaCurta(['a', 'b', 'c'], 2)).toBe('a, b e mais 1');
  });
});

describe('preventivas', () => {
  it('setor: local, depois o tipo pelo código, depois a CAMM', () => {
    expect(setorManutinho({ codigo: 'X1', local: '[TESTE] Setor', camm: 'CAMM 1' })).toBe('[TESTE] Setor');
    expect(setorManutinho({ codigo: 'FTD90', local: '', camm: '' })).toBe('Fermentadores');
    expect(setorManutinho({ codigo: 'PGD90', local: '', camm: '' })).toBe('Propagadores');
    expect(setorManutinho({ codigo: 'BLD90', local: '', camm: '' })).toBe('Blenders');
    expect(setorManutinho({ codigo: 'TST-1', local: '', camm: 'CAMM 2' })).toBe('CAMM 2');
    expect(setorManutinho({ codigo: 'TST-1', local: '', camm: '' })).toBe('Outros');
  });

  it('situação: atrasada antes de hoje; hoje conta como em dia; sem folha = sem programação', () => {
    expect(situacaoEquipamentoManutinho([], HOJE)).toBe('sem_programacao');
    expect(situacaoEquipamentoManutinho([{ dataPrevista: HOJE }], HOJE)).toBe('em_dia');
    expect(situacaoEquipamentoManutinho([{ dataPrevista: '2026-10-27' }], HOJE)).toBe('atrasada');
    expect(situacaoEquipamentoManutinho([{ dataPrevista: '2026-11-30' }, { dataPrevista: '2026-10-01' }], HOJE)).toBe(
      'atrasada',
    );
  });

  const equipamentos = [
    eq('a', 'TST-03', '[TESTE] Setor A', 'CAMM 1'),
    eq('b', 'TST-01', '[TESTE] Setor A', 'CAMM 1'),
    eq('c', 'TST-02', '[TESTE] Setor B'),
    eq('d', 'TST-10', '[TESTE] Setor B'),
  ];
  const folhas = [
    folha('a', '2026-10-25'),
    folha('a', '2026-11-10'),
    folha('b', '2026-10-01', 'em_execucao'),
    folha('d', '2026-11-01'),
  ];
  const rel = montarRelatorioManutinho(equipamentos, folhas, HOJE);

  it('relatório: ordem (mais atraso primeiro), contagens por setor e CAMM, folhas ordenadas', () => {
    expect(rel.equipamentos.map((e) => [e.codigo, e.situacao, e.atrasoDias])).toEqual([
      ['TST-01', 'atrasada', 27],
      ['TST-03', 'atrasada', 3],
      ['TST-02', 'sem_programacao', 0],
      ['TST-10', 'em_dia', 0],
    ]);
    expect(rel.equipamentos[1]?.folhas.map((f) => f.dataPrevista)).toEqual(['2026-10-25', '2026-11-10']);
    expect(rel.equipamentos[1]?.proxima).toBe('2026-10-25');
    expect(rel.totais).toEqual({ atrasadas: 2, emDia: 1, semProgramacao: 1, total: 4, folhasAtrasadas: 2, folhasEmDia: 2 });
    expect(rel.porSetor).toEqual([
      { setor: '[TESTE] Setor A', atrasadas: 2, emDia: 0, semProgramacao: 0, total: 2 },
      { setor: '[TESTE] Setor B', atrasadas: 0, emDia: 1, semProgramacao: 1, total: 2 },
    ]);
    expect(rel.porCamm.map((c) => c.camm)).toEqual(['CAMM 1', 'Sem CAMM']);
  });

  it('avisos: atrasadas por setor (crítico), sem programação (atenção) e um resumo das em dia (info)', () => {
    const itens = itensPreventivas(rel);
    expect(itens.map((i) => [i.nivel, i.titulo, i.detalhe])).toEqual([
      ['critico', '[TESTE] Setor A: 2 equipamentos com preventiva atrasada', 'TST-01 (27 dias), TST-03 (3 dias)'],
      ['atencao', '[TESTE] Setor B: 1 equipamento sem preventiva programada', 'TST-02'],
      ['info', '1 equipamento com preventiva em dia', '2 folhas abertas a partir de hoje.'],
    ]);
    expect(itens.every((i) => i.rota === '/pcm/preventivas')).toBe(true);
  });
});

describe('válvulas e bateladas', () => {
  it('vida 1 = crítico, vida 2 = atenção, 3 e 4 não são aviso', () => {
    expect([1, 2, 3, 4].map(nivelValvulaManutinho)).toEqual(['critico', 'atencao', null, null]);
  });

  it('um aviso por equipamento com a pior vida', () => {
    const itens = itensValvulas([
      { ativoCodigo: 'TST-1', tag: 'V1', estado: 2 },
      { ativoCodigo: 'TST-1', tag: 'V2', estado: 1 },
      { ativoCodigo: 'TST-2', tag: 'V3', estado: 2 },
      { ativoCodigo: 'TST-3', tag: 'V4', estado: 3 },
    ]);
    expect(itens.map((i) => [i.nivel, i.titulo, i.detalhe])).toEqual([
      ['critico', 'TST-1: 2 válvulas críticas (1 em vida 1, 1 em vida 2)', 'V1, V2'],
      ['atencao', 'TST-2: 1 válvula crítica (1 em vida 2)', 'V3'],
    ]);
  });

  it('bateladas: vencidos (crítico) e em alerta (atenção); atenção e ok não viram aviso', () => {
    const itens = itensBateladas([
      { codigo: 'FTD91', faixa: 'vencido', desdePreventiva: 19, frequencia: 18 },
      { codigo: 'FTD92', faixa: 'vencido', desdePreventiva: 25, frequencia: 18 },
      { codigo: 'BLD91', faixa: 'alerta', desdePreventiva: 27, frequencia: 30 },
      { codigo: 'PGD91', faixa: 'atencao', desdePreventiva: 11, frequencia: 18 },
      { codigo: 'PGD92', faixa: 'ok', desdePreventiva: 1, frequencia: 18 },
    ]);
    expect(itens.map((i) => [i.nivel, i.titulo, i.detalhe])).toEqual([
      ['critico', '2 tanques passaram do limite de bateladas', 'FTD92 (25/18), FTD91 (19/18)'],
      ['atencao', '1 tanque em alerta de bateladas', 'BLD91 (27/30)'],
    ]);
  });
});

describe('SCI, SCM e aprovações', () => {
  const ha = (dias: number) => new Date(Date.parse(AGORA) - dias * 86_400_000).toISOString();

  it('parada = mais de 3 dias sem mudança e status não final', () => {
    expect(diasParado(ha(3), AGORA)).toBe(3);
    const itens = itensSolicitacoesParadas(
      [
        { namespace: 'scm', recordId: 'TST-SCM-1', status: 'aprovada', atualizadoEm: ha(3) },
        { namespace: 'scm', recordId: 'TST-SCM-2', status: 'em_tratativa', atualizadoEm: ha(4) },
        { namespace: 'scm', recordId: 'TST-SCM-3', status: 'concluida', atualizadoEm: ha(30) },
        { namespace: 'sci', recordId: 'TST-SCI-1', status: 'aguardando_cadastro', atualizadoEm: ha(9) },
        { namespace: 'sci', recordId: 'TST-SCI-2', status: 'cadastrado', atualizadoEm: ha(9) },
      ],
      AGORA,
    );
    expect(itens.map((i) => [i.titulo, i.detalhe])).toEqual([
      ['1 SCM parada há mais de 3 dias', 'TST-SCM-2 (RC aberta, 4 dias)'],
      ['1 SCI parada há mais de 3 dias', 'TST-SCI-1 (aguardando cadastro, 9 dias)'],
    ]);
  });

  it('aprovação: atenção; vira crítico se alguma espera há mais de 3 dias', () => {
    const scm = (id: string, dias: number) => ({
      namespace: 'scm' as const,
      recordId: id,
      status: 'pendente_aprovacao_lider',
      atualizadoEm: ha(dias),
    });
    expect(itensAprovacoes([scm('A', 1)], AGORA)[0]?.nivel).toBe('atencao');
    const dois = itensAprovacoes([scm('A', 1), scm('B', 5)], AGORA)[0];
    expect([dois?.nivel, dois?.titulo, dois?.detalhe]).toEqual([
      'critico',
      '2 SCMs aguardam a sua aprovação',
      'B (5 dias), A (1 dia)',
    ]);
    expect(itensAprovacoes([{ ...scm('C', 9), status: 'aprovada' }], AGORA)).toEqual([]);
  });
});

describe('medidores', () => {
  it('ativos sem leitura no dia de ontem', () => {
    const sem = medidoresSemLeitura(
      [
        { id: 'm1', nome: '[TESTE] Medidor 2', ativo: true },
        { id: 'm2', nome: '[TESTE] Medidor 10', ativo: true },
        { id: 'm3', nome: '[TESTE] Medidor 1', ativo: false },
        { id: 'm4', nome: '[TESTE] Medidor 3', ativo: true },
      ],
      [
        { medidorId: 'm4', dia: '2026-10-27' },
        { medidorId: 'm1', dia: '2026-10-26' },
      ],
      '2026-10-27',
    );
    expect(sem.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(itensMedidores(sem, '2026-10-27')[0]?.titulo).toBe('2 medidores ficaram sem leitura ontem (27/10/2026)');
    expect(itensMedidores([], '2026-10-27')).toEqual([]);
  });
});

describe('treinamentos', () => {
  const curso = (extra: Partial<CursoManutinho> = {}): CursoManutinho => ({
    id: 'C1',
    titulo: '[TESTE] Curso',
    obrigatorio: true,
    publicado: true,
    publicadoEm: '2026-10-01T00:00:00.000Z',
    prazoDias: 10,
    revisaoVersao: null,
    revisaoEm: null,
    publicoGrupos: [],
    publicoPessoas: [],
    ...extra,
  });
  const pessoa = (id: string, grupoId: string | null = null) => ({ id, nome: `[TESTE] ${id}`, grupoId });

  it('prazo (mesma regra da migration 29)', () => {
    expect(prazoTreinamento(curso(), undefined)?.prazo).toBe('2026-10-11T00:00:00.000Z');
    expect(prazoTreinamento(curso({ prazoDias: null }), undefined)?.prazo).toBe('2026-10-31T00:00:00.000Z');
    const inscrito = {
      usuarioId: 'p',
      cursoId: 'C1',
      concluidoEm: null,
      inscritoEm: '2026-10-20T00:00:00.000Z',
      versao: null,
      expiraEm: null,
    };
    expect(prazoTreinamento(curso(), inscrito)?.prazo).toBe('2026-10-30T00:00:00.000Z');
    const concluido = { ...inscrito, concluidoEm: '2026-10-05T00:00:00.000Z', versao: 1 };
    expect(prazoTreinamento(curso(), concluido)).toBeNull();
    expect(prazoTreinamento(curso(), { ...concluido, expiraEm: '2026-10-15T00:00:00.000Z' })).toEqual({
      prazo: '2026-10-15T00:00:00.000Z',
      refazer: true,
    });
    expect(
      prazoTreinamento(curso({ revisaoVersao: 2, revisaoEm: '2026-10-10T00:00:00.000Z' }), concluido)?.prazo,
    ).toBe('2026-10-20T00:00:00.000Z');
  });

  it('público: sem lista vale para todos; com lista, grupo ou pessoa', () => {
    expect(cursoValePara(curso(), pessoa('p'))).toBe(true);
    expect(cursoValePara(curso({ publicoGrupos: ['g1'] }), pessoa('p', 'g1'))).toBe(true);
    expect(cursoValePara(curso({ publicoGrupos: ['g1'] }), pessoa('p', 'g2'))).toBe(false);
    expect(cursoValePara(curso({ publicoPessoas: ['p'] }), pessoa('p', 'g2'))).toBe(true);
  });

  it('vencidos: só obrigatório publicado, prazo antes de agora, quem concluiu fica de fora', () => {
    const v = treinamentosVencidos(
      [curso(), curso({ id: 'C2', obrigatorio: false }), curso({ id: 'C3', publicadoEm: '2026-10-25T00:00:00.000Z' })],
      [pessoa('ana'), pessoa('bia')],
      [
        {
          usuarioId: 'bia',
          cursoId: 'C1',
          concluidoEm: '2026-10-02T00:00:00.000Z',
          inscritoEm: null,
          versao: 1,
          expiraEm: null,
        },
      ],
      AGORA,
    );
    expect(v.map((x) => [x.pessoaId, x.cursoId, x.refazer])).toEqual([['ana', 'C1', false]]);
    expect(itensTreinamentos(v)[0]?.detalhe).toBe('[TESTE] ana (1)');
    expect(itensTreinamentos([])).toEqual([]);
  });
});

describe('ordem, contagem, guia e cobrança', () => {
  const item = (nivel: ItemManutinho['nivel'], modulo: ItemManutinho['modulo'], titulo: string): ItemManutinho => ({
    nivel,
    modulo,
    titulo,
    detalhe: '',
    rota: '/',
  });

  it('crítico → atenção → info; dentro do nível, pela ordem das fontes e pelo título', () => {
    const itens = ordenarItensManutinho([
      item('info', 'preventivas', 'z'),
      item('atencao', 'treinamentos', 'a'),
      item('critico', 'bateladas', 'b'),
      item('atencao', 'preventivas', 'b'),
      item('critico', 'preventivas', 'Setor 10'),
      item('critico', 'preventivas', 'Setor 9'),
    ]);
    expect(itens.map((i) => `${i.nivel}:${i.modulo}:${i.titulo}`)).toEqual([
      'critico:preventivas:Setor 9',
      'critico:preventivas:Setor 10',
      'critico:bateladas:b',
      'atencao:preventivas:b',
      'atencao:treinamentos:a',
      'info:preventivas:z',
    ]);
    expect(contarNiveisManutinho(itens)).toEqual({ critico: 3, atencao: 2, info: 1 });
  });

  it('guia: busca sem acento e por palavra-chave; vazio quando nada combina', () => {
    expect(GUIA_MANUTINHO.length).toBe(15);
    expect(buscarGuia('como faço uma solicitacao de compra?')[0]?.t).toBe('SCM · solicitação de compra');
    expect(buscarGuia('APONTAR BATELADAS')[0]?.t).toBe('Apontar bateladas');
    expect(buscarGuia('cobrar a equipe')[0]?.txt).toMatch(/Manutinho/);
    expect(buscarGuia('xyzw')).toEqual([]);
    expect(buscarGuia('   ')).toEqual([]);
    expect(GUIA_MANUTINHO.some((g) => /copiloto|inteligência artificial/i.test(g.txt))).toBe(false);
  });

  it('cobrança: modelo fixo', () => {
    expect(modeloCobranca('[TESTE] Líder', ['a'])).toEqual({
      assunto: '[Lembrete] Treinamento pendente',
      paragrafos: [
        '[TESTE] Líder pediu que você conclua este treinamento na Plataforma de Manutenção:',
        'Acesse a plataforma, em Treinamentos › Meus cursos.',
      ],
    });
    expect(modeloCobranca('X', ['a', 'b']).paragrafos[0]).toMatch(/estes treinamentos/);
  });

  it('dist CommonJS: o servidor carrega as regras do Manutinho com require', () => {
    const require = createRequire(import.meta.url);
    const cjs = require('../dist/cjs/manutinho/index.js') as typeof import('../src/manutinho/index.js');
    expect(typeof cjs.montarRelatorioManutinho).toBe('function');
    expect(cjs.ROTAS_MANUTINHO.bateladas).toBe('/pcm/bateladas');
  });
});
