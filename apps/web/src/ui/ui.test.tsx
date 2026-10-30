// Componentes de src/ui: indicador (zero vira texto), abas pelo teclado, diálogo (Esc, foco), tabelas, gráficos e avisos.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AreaChart,
  BarChart,
  Botao,
  Dialog,
  DonutChart,
  EmptyState,
  Kpi,
  Table,
  Tabs,
  ToastProvider,
  topoRedondo,
  useToast,
  VirtualTable,
} from './index';
import { esquecerContagens } from './useContagem';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  esquecerContagens();
  vi.useRealTimers();
});

describe('Kpi', () => {
  it('valor 0 nunca fica solto: mostra o texto do vazio, sem variação', () => {
    render(
      <Kpi
        id="t0"
        rotulo="Compras (SCM)"
        valor={0}
        legenda="abertas nos últimos 30 dias"
        vazio="Nenhuma SCM aberta neste período"
        variacao={{ relativa: -1, texto: '-100% vs. mês anterior', boa: null }}
        icone="compra"
      />,
    );
    expect(screen.getByText('Nenhuma SCM aberta neste período')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText(/vs\. mês anterior/)).toBeNull();
  });

  it('valor com variação e link (o número final fica para leitor de tela já na primeira pintura)', () => {
    render(
      <MemoryRouter>
        <Kpi
          id="t1"
          rotulo="SCM aprovadas"
          valor={1234}
          legenda="no período"
          vazio="-"
          variacao={{ relativa: 0.2, texto: '+20% vs. mês anterior', boa: true }}
          icone="aprovar"
          para="/almoxarifado/scm"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('1.234')).toBeTruthy();
    expect(screen.getByText('+20% vs. mês anterior').className).toContain('boa');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/almoxarifado/scm');
  });
});

describe('Tabs', () => {
  function Abas() {
    const [a, setA] = useState('7');
    return (
      <Tabs
        rotulo="Período"
        abas={[
          { id: '7', rotulo: '7 dias' },
          { id: '30', rotulo: '30 dias' },
          { id: '90', rotulo: '90 dias' },
        ]}
        ativa={a}
        aoTrocar={setA}
      >
        <p>painel {a}</p>
      </Tabs>
    );
  }
  it('setas, Home e End trocam a aba e o foco; só a ativa entra no Tab', () => {
    render(<Abas />);
    const [a7, , a90] = screen.getAllByRole('tab');
    expect(a7?.getAttribute('tabindex')).toBe('0');
    expect(a90?.getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(a7!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('90 dias');
    expect(document.activeElement?.textContent).toBe('90 dias');
    fireEvent.keyDown(a90!, { key: 'Home' });
    expect(screen.getByRole('tabpanel').textContent).toBe('painel 7');
  });
});

describe('Dialog', () => {
  it('abre com foco dentro, Esc fecha e o foco volta para quem abriu', () => {
    function Teste() {
      const [aberto, setAberto] = useState(false);
      return (
        <>
          <Botao onClick={() => setAberto(true)}>abrir</Botao>
          <Dialog aberto={aberto} aoFechar={() => setAberto(false)} titulo="Confirme">
            <input aria-label="campo" data-autofocus="" />
          </Dialog>
        </>
      );
    }
    render(<Teste />);
    const abrir = screen.getByText('abrir');
    abrir.focus();
    fireEvent.click(abrir);
    const dialogo = screen.getByRole('dialog', { name: 'Confirme' });
    expect(dialogo.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('campo'));
    expect(document.documentElement.style.overflow).toBe('hidden');
    fireEvent.keyDown(dialogo, { key: 'Escape' });
    expect(document.activeElement).toBe(abrir);
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('não fechável: Esc não fecha e não há botão fechar', () => {
    const fechar = vi.fn();
    render(
      <Dialog aberto aoFechar={fechar} titulo="Guarde os códigos" fechavel={false}>
        <p>x</p>
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(fechar).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Fechar')).toBeNull();
  });
});

describe('tabelas', () => {
  const colunas = [
    { chave: 'nome', titulo: 'Nome' },
    { chave: 'n', titulo: 'Qtd', alinhar: 'direita' as const },
  ];
  it('Table: semântica e vazio claro', () => {
    const { rerender } = render(
      <Table rotulo="Itens" colunas={colunas} linhas={[{ nome: '[TESTE] Item', n: 3 }]} chaveLinha={(l) => l.nome} />,
    );
    expect(screen.getByRole('table', { name: 'Itens' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '3' }).className).toBe('bm-tabela__dir');
    rerender(
      <Table
        rotulo="Itens"
        colunas={colunas}
        linhas={[]}
        chaveLinha={(l: { nome: string }) => l.nome}
        vazio={<EmptyState titulo="Nenhum item" />}
      />,
    );
    expect(screen.getByText('Nenhum item')).toBeTruthy();
  });

  it('VirtualTable: 5.000 linhas, só desenha as visíveis', () => {
    // jsdom não mede: a área rolável "tem" 480 px de altura (o virtualizador lê clientHeight)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const linhas = Array.from({ length: 5000 }, (_, k) => ({ nome: `[TESTE] ${k}`, n: k }));
    render(<VirtualTable rotulo="Muitos" colunas={colunas} linhas={linhas} chaveLinha={(l) => l.nome} />);
    const tabela = screen.getByRole('table', { name: 'Muitos' });
    expect(tabela.getAttribute('aria-rowcount')).toBe('5001');
    const desenhadas = screen.getAllByRole('row').length;
    expect(desenhadas).toBeGreaterThan(1);
    expect(desenhadas).toBeLessThan(60);
  });
});

describe('gráficos', () => {
  it('topo redondo do eixo', () => {
    expect(topoRedondo(0)).toBe(1);
    expect(topoRedondo(7)).toBe(10);
    expect(topoRedondo(13)).toBe(20);
    expect(topoRedondo(240)).toBe(250);
  });

  it('área: resumo acessível, legenda, dica pelo teclado (setas) sem ler layout', () => {
    render(
      <AreaChart
        resumo="Evolução"
        rotulos={['01/10', '02/10', '03/10']}
        series={[
          { nome: 'SCI', cor: 'red', valores: [1, 4, 2] },
          { nome: 'SCM', cor: 'blue', valores: [0, 2, 5] },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Evolução' })).toBeTruthy();
    const grafico = screen.getByLabelText(/Use as setas/);
    fireEvent.keyDown(grafico, { key: 'ArrowRight' });
    fireEvent.keyDown(grafico, { key: 'ArrowRight' });
    expect(screen.getByText('02/10', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('SCM: 2')).toBeTruthy();
  });

  it('barras e rosca desenham uma forma por dado', () => {
    const { container } = render(
      <>
        <BarChart
          resumo="b"
          dados={[
            { rotulo: 'jan', valor: 2 },
            { rotulo: 'fev', valor: 5 },
          ]}
        />
        <DonutChart
          resumo="d"
          centro="7"
          partes={[
            { rotulo: 'Aprovadas', valor: 5, cor: 'green' },
            { rotulo: 'Pendentes', valor: 2, cor: 'orange' },
          ]}
        />
      </>,
    );
    expect(container.querySelectorAll('rect[rx="5"]')).toHaveLength(2);
    expect(container.querySelectorAll('circle[stroke-dasharray]')).toHaveLength(2);
    expect(screen.getByText('Aprovadas')).toBeTruthy();
  });
});

describe('Toast', () => {
  it('mostra e some sozinho em 4,5 s', () => {
    vi.useFakeTimers();
    function Botoes() {
      const { mostrar } = useToast();
      return <Botao onClick={() => mostrar({ texto: 'Salvo.', tom: 'ok' })}>salvar</Botao>;
    }
    render(
      <ToastProvider>
        <Botoes />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('salvar'));
    expect(screen.getByRole('status').textContent).toContain('Salvo.');
    act(() => {
      vi.advanceTimersByTime(4600);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText('Salvo.')).toBeNull();
  });
});
