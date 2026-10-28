// Manutinho (front): página com abas, export CSV/impressão, cobrança, botão flutuante e gaveta. Transporte falso com
// pessoas e equipamentos FICTÍCIOS ([TESTE], domínio .invalid); nenhuma chamada de rede.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  itensPreventivas,
  montarRelatorioManutinho,
  type RespostaResumoManutinho,
  type TreinamentoVencidoManutinho,
} from '@biomanut/shared';
import { definirTransporte, type Pedido } from '../../lib/api/transport';
import { celulaCsv, csvPreventivas } from './exportar';
import { agruparPorPessoa } from './componentes/CobrancaTreinamentos';
import { TabelaPreventivas, LIMITE_SEM_VIRTUALIZAR } from './componentes/TabelaPreventivas';
import { ManutinhoLauncher } from './ManutinhoLauncher';
import { modulo } from './module';
import ManutinhoPage from './pages/ManutinhoPage';

const HOJE = '2026-10-28';
const REL = montarRelatorioManutinho(
  [
    {
      id: 'a',
      codigo: 'TST-01',
      nome: '[TESTE] A',
      camm: 'CAMM 1',
      local: '[TESTE] Setor',
      ultimaConcluida: '2026-09-01',
    },
    { id: 'b', codigo: 'TST-02', nome: '[TESTE] B', camm: '', local: '[TESTE] Setor', ultimaConcluida: null },
  ],
  [{ id: 'f', ativoId: 'a', numeroOm: '=OM;1', dataPrevista: '2026-10-20', status: 'aberta' }],
  HOJE,
);
const RESUMO: RespostaResumoManutinho = {
  ok: true,
  hoje: HOJE,
  fontes: ['preventivas', 'valvulas', 'bateladas', 'solicitacoes', 'aprovacoes', 'treinamentos'],
  itens: [
    ...itensPreventivas(REL),
    {
      nivel: 'atencao',
      modulo: 'solicitacoes',
      titulo: '1 SCM parada há mais de 3 dias',
      detalhe: 'TST-SCM-1',
      rota: '/almoxarifado/minhas',
    },
  ],
  contagem: { critico: 1, atencao: 2, info: 0 },
};
const VENCIDOS: TreinamentoVencidoManutinho[] = [
  {
    pessoaId: 'p-tec',
    pessoa: '[TESTE] Técnico',
    cursoId: 'c1',
    curso: '[TESTE] Curso 1',
    prazo: '2026-10-01T00:00:00.000Z',
    refazer: false,
  },
  {
    pessoaId: 'p-tec',
    pessoa: '[TESTE] Técnico',
    cursoId: 'c2',
    curso: '[TESTE] Curso 2',
    prazo: '2026-10-02T00:00:00.000Z',
    refazer: false,
  },
  {
    pessoaId: 'p-lider',
    pessoa: '[TESTE] Líder',
    cursoId: 'c1',
    curso: '[TESTE] Curso 1',
    prazo: '2026-10-01T00:00:00.000Z',
    refazer: false,
  },
];

let pedidos: Pedido[] = [];
function servidor(perfilId: string, extra: Partial<Record<string, { status: number; corpo: unknown }>> = {}) {
  pedidos = [];
  definirTransporte({
    async enviar(p) {
      pedidos.push(p);
      const chave = `${p.method} ${p.path}`;
      if (extra[chave]) return extra[chave];
      if (chave === 'GET /auth/me')
        return {
          status: 200,
          corpo: {
            ok: true,
            usuario: { id: 'p-lider', nome: '[TESTE] Líder', email: 'lider@teste.invalid', perfilId },
          },
        };
      if (chave === 'GET /api/manutinho/resumo') return { status: 200, corpo: RESUMO };
      if (chave === 'GET /api/manutinho/relatorio-preventivas') return { status: 200, corpo: { ok: true, ...REL } };
      if (chave === 'GET /api/manutinho/treinamentos-vencidos')
        return { status: 200, corpo: { ok: true, vencidos: VENCIDOS } };
      if (chave === 'POST /api/manutinho/cobrar')
        return {
          status: 200,
          corpo: { ok: true, enviados: 1, resultado: [{ pessoaId: 'p-tec', resultado: 'ok' }], avisos: [] },
        };
      return { status: 404, corpo: { ok: false, erro: 'sem rota' } };
    },
  });
}

function montar(no: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="always">
          <MemoryRouter>{no}</MemoryRouter>
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

beforeEach(() => servidor('lider'));
afterEach(() => {
  cleanup();
  definirTransporte(null);
  vi.restoreAllMocks();
});

describe('module.ts', () => {
  it('registra /manutinho com página sob demanda, visível a todo perfil com sessão (tela inicio)', () => {
    expect(modulo.id).toBe('manutinho');
    expect(modulo.rotas).toHaveLength(1);
    expect(modulo.rotas[0]?.path).toBe('/manutinho');
    expect(modulo.rotas[0]?.tela).toBe('inicio');
  });
});

describe('ManutinhoPage', () => {
  it('Alertas: avisos do servidor (crítico primeiro) e busca no guia sem servidor', async () => {
    montar(<ManutinhoPage />);
    const lista = await screen.findByRole('list', { name: 'Avisos do Manutinho' });
    const itens = within(lista).getAllByRole('listitem');
    expect(itens[0]?.textContent).toMatch(/Crítico.*\[TESTE\] Setor: 1 equipamento com preventiva atrasada/);
    expect(screen.getByRole('tab', { name: /Alertas/ }).getAttribute('aria-selected')).toBe('true');
    const antes = pedidos.length;
    fireEvent.change(screen.getByLabelText('Dúvida de uso do site'), { target: { value: 'como aponto bateladas' } });
    expect(screen.getByRole('list', { name: 'Respostas do guia' }).textContent).toContain('Apontar bateladas');
    expect(pedidos.length).toBe(antes);
  });

  it('Preventivas: relatório por setor e equipamento; CSV e impressão A4', async () => {
    const criar = vi.fn(() => 'blob:teste');
    Object.assign(URL, { createObjectURL: criar, revokeObjectURL: vi.fn() });
    const clique = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const imprimir = vi.spyOn(window, 'print').mockImplementation(() => {});
    montar(<ManutinhoPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Preventivas/ }));
    const tabela = await screen.findByRole('table', { name: 'Equipamentos e situação das preventivas' });
    expect(within(tabela).getAllByRole('row')).toHaveLength(3);
    expect(tabela.textContent).toContain('8 dias');
    fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(criar).toHaveBeenCalledTimes(1);
    expect(clique).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Imprimir / PDF' }));
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
    expect(document.documentElement.classList.contains('manu-imprimir')).toBe(false);
  });

  it('Pendências: líder marca quem cobrar (não a si), vê a prévia do modelo fixo e envia', async () => {
    montar(<ManutinhoPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Pendências/ }));
    const lista = await screen.findByRole('list', { name: 'Treinamentos vencidos' });
    expect(within(lista).getAllByRole('checkbox')).toHaveLength(1);
    expect(lista.textContent).toContain('[TESTE] Curso 1, [TESTE] Curso 2');
    fireEvent.click(within(lista).getByRole('checkbox'));
    expect(screen.getByLabelText('Prévia do e-mail').textContent).toContain(
      '[TESTE] Líder pediu que você conclua estes treinamentos',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enviar cobrança (1)' }));
    await screen.findByText('1 cobrança enviada.');
    const envio = pedidos.find((p) => p.method === 'POST');
    expect(envio?.body).toEqual({ itens: [{ pessoaId: 'p-tec', cursos: ['[TESTE] Curso 1', '[TESTE] Curso 2'] }] });
  });

  it('técnico: sem botão de cobrança; perfil sem preventivas não vê a aba', async () => {
    servidor('tecnico', {
      'GET /api/manutinho/resumo': { status: 200, corpo: { ...RESUMO, fontes: ['treinamentos'], itens: [] } },
    });
    montar(<ManutinhoPage />);
    await screen.findByText('Tudo em dia por aqui.');
    expect(screen.queryByRole('tab', { name: /Preventivas/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Pendências/ }));
    await screen.findByRole('list', { name: 'Treinamentos vencidos' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Enviar cobrança/ })).toBeNull();
  });

  it('erro do servidor vira mensagem, sem quebrar a tela', async () => {
    servidor('lider', { 'GET /api/manutinho/resumo': { status: 500, corpo: { ok: false, erro: 'falha' } } });
    montar(<ManutinhoPage />);
    expect(await screen.findAllByText('Não foi possível carregar agora. Tente de novo em instantes.')).not.toHaveLength(
      0,
    );
  });
});

describe('ManutinhoLauncher', () => {
  it('botão com o contador (crítico + atenção) abre a gaveta com vidro; Esc fecha e devolve o foco', async () => {
    montar(<ManutinhoLauncher />);
    const botao = await screen.findByRole('button', { name: 'Abrir o Manutinho: 3 avisos' });
    expect(botao.textContent).toContain('3');
    fireEvent.click(botao);
    const gaveta = await screen.findByRole('dialog', { name: 'Manutinho' });
    expect(gaveta.className).toContain('bm-vidro');
    expect(within(gaveta).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(within(gaveta).getByRole('link', { name: 'Abrir o Manutinho' }).getAttribute('href')).toBe('/manutinho');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Fechar o Manutinho');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(botao);
    expect(document.querySelectorAll('.bm-vidro')).toHaveLength(0);
  });
});

describe('export e agrupamento', () => {
  it('CSV: BOM, ponto e vírgula, aspas e fórmula neutralizada', () => {
    expect(celulaCsv('=SOMA(A1)')).toBe("'=SOMA(A1)");
    expect(celulaCsv('a;b')).toBe('"a;b"');
    expect(celulaCsv('diz "oi"')).toBe('"diz ""oi"""');
    const csv = csvPreventivas(REL);
    expect(csv.startsWith('﻿Equipamento;Nome;Setor')).toBe(true);
    expect(csv).toContain('TST-01;[TESTE] A;[TESTE] Setor;CAMM 1;Atrasada;8;1;20/10/2026;"\'=OM;1";01/09/2026');
    expect(csv.trim().split('\r\n')).toHaveLength(3);
  });

  it('cobrança: um item por pessoa com os cursos', () => {
    expect(agruparPorPessoa(VENCIDOS).map((p) => [p.id, p.cursos.length])).toEqual([
      ['p-lider', 1],
      ['p-tec', 2],
    ]);
  });

  it(`tabela: acima de ${LIMITE_SEM_VIRTUALIZAR} linhas virtualiza (não monta todas)`, () => {
    const muitos = Array.from({ length: 300 }, (_, i) => ({
      ...REL.equipamentos[0]!,
      id: `x${i}`,
      codigo: `TST-${i}`,
    }));
    render(<TabelaPreventivas equipamentos={muitos} />);
    expect(screen.getAllByRole('row').length).toBeLessThan(60);
  });
});
