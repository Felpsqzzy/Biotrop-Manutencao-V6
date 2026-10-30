// Terminal (tablet): escolha dos dois módulos após o login, cartões × lista, Separar/contador/bandeja, unidade pela
// etiqueta na folha, Retirada só com retiráveis, chave de operação (reenvio usa a mesma) e a trava de 700 ms no sucesso.
// Roda contra o demo em memória (mesmo contrato da rota /api/terminal), sem atraso.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { definirTransporte, type Transporte } from './api';
import { Terminal } from './App';
import { criarDemo } from './demo';

type Chamada = { metodo: string; url: string; corpo: unknown };

type Desvio = (metodo: string, url: string, corpo: unknown) => Promise<{ status: number; json: unknown }> | null;

function montar(opc: { falharPrimeiroPost?: boolean; maxCatalogo?: number; desvio?: Desvio } = {}) {
  const demo = criarDemo({ atraso: 0, maxCatalogo: opc.maxCatalogo });
  const chamadas: Chamada[] = [];
  let falhar = !!opc.falharPrimeiroPost;
  const t: Transporte = async (metodo, url, corpo) => {
    chamadas.push({ metodo, url, corpo });
    const d = opc.desvio?.(metodo, url, corpo);
    if (d) return d;
    if (falhar && metodo === 'POST' && url === '/api/terminal/emprestimos') {
      falhar = false;
      // o servidor gravou, mas a resposta se perdeu
      await demo.handle(metodo, url, corpo);
      throw new Error('rede caiu');
    }
    return demo.handle(metodo, url, corpo);
  };
  definirTransporte(t);
  render(
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="always">
        <ToastProvider>
          <Terminal />
        </ToastProvider>
      </MotionConfig>
    </LazyMotion>,
  );
  return { chamadas, demo };
}

async function entrar(matricula = '10421', pin = '480256') {
  fireEvent.change(screen.getByLabelText('Matrícula'), { target: { value: matricula } });
  fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));
  const teclado = screen.getByRole('group', { name: /Teclado numérico/ });
  for (const d of pin) fireEvent.click(within(teclado).getByRole('button', { name: d }));
  await screen.findByText('O que você vai fazer?');
}

async function abrirModulo(nome: 'Empréstimo' | 'Retirada') {
  const cartao = screen
    .getAllByRole('button')
    .find((b) => b.classList.contains('tm-modulo') && b.textContent?.includes(nome));
  fireEvent.click(cartao!);
  await screen.findByText(nome === 'Empréstimo' ? 'Empréstimo de ferramentas' : 'Retirada de material');
}

async function buscar(texto: string) {
  fireEvent.change(screen.getByLabelText('Buscar ferramenta'), { target: { value: texto } });
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  try {
    localStorage.clear();
  } catch {
    /* ok */
  }
});
afterEach(() => {
  cleanup();
  definirTransporte(null);
  vi.restoreAllMocks();
});

describe('terminal', () => {
  it('depois do login, escolhe entre os dois módulos e troca pelo topo sem sair', async () => {
    montar();
    await entrar();
    const cartoes = screen.getAllByRole('button').filter((b) => b.classList.contains('tm-modulo'));
    expect(cartoes.map((c) => c.textContent)).toEqual([
      expect.stringContaining('Empréstimo'),
      expect.stringContaining('Retirada'),
    ]);
    expect(screen.getByRole('button', { name: /Sair/ })).toBeTruthy();
    await abrirModulo('Retirada');
    expect(screen.getByRole('button', { name: /Minhas retiradas/ })).toBeTruthy();
    const troca = screen.getByRole('navigation', { name: 'Trocar de módulo' });
    fireEvent.click(within(troca).getByRole('button', { name: /Empréstimo/ }));
    await screen.findByText('Empréstimo de ferramentas');
    expect(screen.getByRole('button', { name: /Pegar ferramentas/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Devolver/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Meus empréstimos/ })).toBeTruthy();
  });

  it('alterna cartões ↔ lista e lembra a escolha', async () => {
    montar();
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('trena');
    const item = await screen.findByRole('article', { name: 'Trena 5 m' });
    expect(item.classList.contains('tm-item--cards')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Lista' }));
    expect(screen.getByRole('article', { name: 'Trena 5 m' }).classList.contains('tm-item--lista')).toBe(true);
    expect(localStorage.getItem('tm-vista')).toBe('lista');
    expect(screen.getByRole('button', { name: 'Lista' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Separar vira contador com selo, soma, e a bandeja leva à revisão com o prazo padrão', async () => {
    montar();
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('trena');
    const item = await screen.findByRole('article', { name: 'Trena 5 m' });
    expect(screen.queryByText(/carrinho/i)).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    expect(within(item).getByText('Separado')).toBeTruthy();
    expect(within(item).getByRole('status').textContent).toBe('1');
    fireEvent.click(within(item).getByRole('button', { name: 'Mais um de Trena 5 m' }));
    expect(within(item).getByRole('status').textContent).toBe('2');
    expect(screen.getByText('2 itens separados')).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Tirar um de Trena 5 m' }));
    expect(screen.getByText('1 item separado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await screen.findByText('Revisar o empréstimo');
    expect(screen.getByText(/Prazo padrão: devolver em até 7 dias/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Confirmar empréstimo/ })).toBeTruthy();
  });

  it('item por unidade: Separar abre a folha e a unidade escolhida pela etiqueta vai no pedido', async () => {
    const { chamadas } = montar();
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('furadeira');
    const item = await screen.findByRole('article', { name: 'Furadeira de impacto 650 W' });
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    const folha = await screen.findByRole('dialog');
    // PAT-D1001 está emprestada no demo: não aparece
    expect(within(folha).queryByText('PAT-D1001')).toBeNull();
    fireEvent.click(within(folha).getByRole('button', { name: /PAT-D1002/ }));
    expect(
      within(folha)
        .getByRole('button', { name: /PAT-D1002/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(within(folha).getByRole('button', { name: /Pronto/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await screen.findByText('Revisar o empréstimo');
    expect(screen.getByText('PAT-D1002')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText('Empréstimo registrado');
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url === '/api/terminal/emprestimos');
    const corpo = post!.corpo as { modalidade: string; itens: { unidadeId?: string; quantidade: number }[] };
    expect(corpo.modalidade).toBe('emprestimo');
    expect(corpo.itens).toHaveLength(1);
    expect(corpo.itens[0]!.unidadeId).toBeTruthy();
    expect(corpo.itens[0]!.quantidade).toBe(1);
  });

  it('Retirada mostra só os itens retiráveis', async () => {
    montar();
    await entrar();
    await abrirModulo('Retirada');
    fireEvent.click(screen.getByRole('button', { name: /Retirar/ }));
    const chips = await screen.findByRole('group', { name: 'Categorias' });
    // mais de 100 itens: lista virtualizada (só as linhas à vista vão para o DOM)
    expect(document.querySelector('.tm-virtual')).toBeTruthy();
    expect(within(chips).queryByRole('button', { name: /Manual/ })).toBeNull();
    expect(within(chips).getByRole('button', { name: /Todas/ }).textContent).toContain('113');
    await buscar('furadeira');
    await screen.findByText('Nada encontrado');
  });

  it('chave de operação: o reenvio sem resposta usa a mesma chave; o próximo pedido usa outra', async () => {
    const { chamadas } = montar({ falharPrimeiroPost: true });
    await entrar();
    await abrirModulo('Retirada');
    fireEvent.click(screen.getByRole('button', { name: /Retirar/ }));
    await buscar('disco');
    const item = await screen.findByRole('article', { name: 'Disco de corte 4 1/2"' });
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar retirada/ }));
    await screen.findByText(/Sem conexão com o servidor/);
    fireEvent.click(screen.getByRole('button', { name: /Confirmar retirada/ }));
    await screen.findByText('Retirada registrada');
    await screen.findByText(/já estava registrado/);
    const posts = chamadas.filter((c) => c.metodo === 'POST' && c.url === '/api/terminal/emprestimos');
    const chave = (c: Chamada) => (c.corpo as { chave: string }).chave;
    expect(posts).toHaveLength(2);
    expect(chave(posts[1]!)).toBe(chave(posts[0]!));
    expect((posts[0]!.corpo as { modalidade: string }).modalidade).toBe('retirada');

    // próximo pedido: chave nova
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    fireEvent.click(screen.getByRole('button', { name: /Fazer outra retirada/ }));
    vi.restoreAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: /^Retirar/ }));
    await buscar('fita');
    const outro = await screen.findByRole('article', { name: 'Fita isolante 19 mm' });
    fireEvent.click(within(outro).getByRole('button', { name: /Separar/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar retirada/ }));
    await screen.findByText('Retirada registrada');
    const todos = chamadas.filter((c) => c.metodo === 'POST' && c.url === '/api/terminal/emprestimos');
    expect(todos).toHaveLength(3);
    expect(chave(todos[2]!)).not.toBe(chave(todos[0]!));
  });

  it('na tela de sucesso, toques nos primeiros 700 ms são ignorados', async () => {
    montar();
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('trena');
    const item = await screen.findByRole('article', { name: 'Trena 5 m' });
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText('Empréstimo registrado');
    const sairBtn = screen.getByRole('button', { name: /Terminar e sair/ });
    const agora = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(agora + 100);
    fireEvent.click(sairBtn);
    expect(screen.getByText('Empréstimo registrado')).toBeTruthy();
    vi.spyOn(Date, 'now').mockReturnValue(agora + 1000);
    await act(async () => {
      fireEvent.click(sairBtn);
    });
    await screen.findByText('Acesso do colaborador');
  });

  it('Retirada pede só os retiráveis ao servidor e avisa "Muitos itens" quando a lista vem cortada', async () => {
    const { chamadas } = montar({ maxCatalogo: 50 });
    await entrar();
    await abrirModulo('Retirada');
    fireEvent.click(screen.getByRole('button', { name: /Retirar/ }));
    await screen.findByText(/Muitos itens: refine a busca/);
    const get = chamadas.filter((c) => c.metodo === 'GET' && c.url.startsWith('/api/terminal/ferramentas'));
    expect(get.at(-1)!.url).toContain('modalidade=retirada');
    const chips = screen.getByRole('group', { name: 'Categorias' });
    expect(within(chips).getByRole('button', { name: /Todas/ }).textContent).toContain('50');
    await buscar('disco');
    await waitFor(() => expect(screen.queryByText(/Muitos itens/)).toBeNull());
    expect(screen.getByRole('article', { name: 'Disco de corte 4 1/2"' })).toBeTruthy();
    expect(chamadas.at(-1)!.url).toBe('/api/terminal/ferramentas?q=disco&modalidade=retirada');
  });

  it('saída administrativa aberta e largada: 1 min sem uso fecha e limpa (também sem sessão)', async () => {
    montar();
    fireEvent.keyDown(document, { key: 'S', code: 'KeyS', ctrlKey: true, altKey: true, shiftKey: true });
    const dlg = await screen.findByRole('dialog', { name: 'Liberar o tablet' });
    fireEvent.change(within(dlg).getByLabelText('Matrícula'), { target: { value: 'A1234' } });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Liberar o tablet' })).toBeNull(), {
      timeout: 2000,
    });
    vi.restoreAllMocks();
    fireEvent.keyDown(document, { key: 'S', code: 'KeyS', ctrlKey: true, altKey: true, shiftKey: true });
    const outro = await screen.findByRole('dialog', { name: 'Liberar o tablet' });
    expect((within(outro).getByLabelText('Matrícula') as HTMLInputElement).value).toBe('');
  });

  it('o fim da sessão (voltarInicio) fecha a saída administrativa aberta', async () => {
    montar();
    await entrar();
    fireEvent.keyDown(document, { key: 'S', code: 'KeyS', ctrlKey: true, altKey: true, shiftKey: true });
    await screen.findByRole('dialog', { name: 'Liberar o tablet' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 200_000);
    await screen.findByText('Acesso do colaborador', undefined, { timeout: 2000 });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Liberar o tablet' })).toBeNull());
  });

  it('durante o envio, "Separar mais", Voltar e a troca de módulo ficam parados', async () => {
    let soltar: () => void = () => {};
    const segura = new Promise<void>((r) => (soltar = r));
    let demoRef: ReturnType<typeof criarDemo> | null = null;
    const { demo } = montar({
      desvio: (metodo, url, corpo) =>
        metodo === 'POST' && url === '/api/terminal/emprestimos'
          ? segura.then(() => demoRef!.handle(metodo, url, corpo))
          : null,
    });
    demoRef = demo;
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('trena');
    const item = await screen.findByRole('article', { name: 'Trena 5 m' });
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText(/Registrando/);
    const troca = screen.getByRole('navigation', { name: 'Trocar de módulo' });
    const retirada = within(troca).getByRole('button', { name: /Retirada/ }) as HTMLButtonElement;
    const voltar = screen.getByRole('button', { name: /Voltar/ }) as HTMLButtonElement;
    expect(retirada.disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Separar mais/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(voltar.disabled).toBe(true);
    fireEvent.click(retirada);
    fireEvent.click(voltar);
    expect(screen.getByText('Revisar o empréstimo')).toBeTruthy();
    await act(async () => soltar());
    await screen.findByText('Empréstimo registrado');
  });

  it('durante o envio da devolução, Voltar, Alterar e a troca de módulo ficam parados', async () => {
    let soltar: () => void = () => {};
    const segura = new Promise<void>((r) => (soltar = r));
    let demoRef: ReturnType<typeof criarDemo> | null = null;
    const { demo } = montar({
      desvio: (metodo, url, corpo) =>
        metodo === 'POST' && url.endsWith('/devolucoes')
          ? segura.then(() => demoRef!.handle(metodo, url, corpo))
          : null,
    });
    demoRef = demo;
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /^Devolver/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Devolver deste/ }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /Marcar todos/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar devolução/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar devolução/ }));
    await screen.findByText(/Registrando/);
    const troca = screen.getByRole('navigation', { name: 'Trocar de módulo' });
    const retirada = within(troca).getByRole('button', { name: /Retirada/ }) as HTMLButtonElement;
    const voltar = screen.getByRole('button', { name: /Voltar/ }) as HTMLButtonElement;
    const alterar = screen.getByRole('button', { name: /Alterar/ }) as HTMLButtonElement;
    expect([retirada.disabled, voltar.disabled, alterar.disabled]).toEqual([true, true, true]);
    expect(screen.getByText('Revisar a devolução')).toBeTruthy();
    await act(async () => soltar());
    await screen.findByText('Devolução registrada');
    expect((within(troca).getByRole('button', { name: /Retirada/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('devolução: se a busca dos abertos falha, mostra o erro com "Tentar de novo" (não fica carregando)', async () => {
    let falhar = true;
    montar({
      desvio: (metodo, url) =>
        falhar && metodo === 'GET' && url.includes('situacao=abertos')
          ? Promise.resolve({ status: 503, json: { ok: false, erro: 'Servidor fora do ar.' } })
          : null,
    });
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /Meus empréstimos/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: /^Devolver$/ }))[0]!);
    await screen.findByText('Não deu para buscar seus empréstimos');
    falhar = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    await screen.findByRole('button', { name: /Revisar devolução/ });
  });

  it('Meus empréstimos com mais de 100 registros é virtualizado; retirada aguardando não repete o status', async () => {
    const muitos = Array.from({ length: 150 }, (_, i) => ({
      id: `e${i}`,
      numero: `EM-D${String(i).padStart(4, '0')}`,
      modalidade: 'emprestimo',
      status: 'devolvido',
      criadoEm: new Date(2026, 0, 1 + (i % 28)).toISOString(),
      itensLista: [],
    }));
    let lote = false;
    montar({
      desvio: (metodo, url) =>
        lote && metodo === 'GET' && url.includes('situacao=todos')
          ? Promise.resolve({ status: 200, json: { ok: true, rows: muitos, cortado: false } })
          : null,
    });
    await entrar();
    await abrirModulo('Retirada');
    fireEvent.click(screen.getByRole('button', { name: /Minhas retiradas/ }));
    const regs = await screen.findAllByRole('article');
    for (const r of regs) expect(r.textContent!.match(/baixa do almoxarifado/g)?.length ?? 0).toBeLessThanOrEqual(1);
    lote = true;
    const troca = screen.getByRole('navigation', { name: 'Trocar de módulo' });
    fireEvent.click(within(troca).getByRole('button', { name: /Empréstimo/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Meus empréstimos/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Histórico \(150\)/ }));
    await waitFor(() => expect(document.querySelector('.tm-virtual')).toBeTruthy());
    expect(screen.getAllByRole('article').length).toBeLessThan(150);
  });

  it('folha com mais de 100 etiquetas é virtualizada', async () => {
    const unidades = Array.from({ length: 150 }, (_, i) => ({ id: `u${i}`, identificador: `PAT-V${i}` }));
    let demoRef: ReturnType<typeof criarDemo> | null = null;
    const { demo } = montar({
      desvio: (metodo, url, corpo) =>
        metodo === 'GET' && url.startsWith('/api/terminal/ferramentas')
          ? demoRef!.handle(metodo, url, corpo).then((r) => {
              const j = r.json as unknown as { rows: Record<string, unknown>[] };
              j.rows = j.rows.map((f) =>
                f.nome === 'Furadeira de impacto 650 W' ? { ...f, unidadesDisponiveis: unidades } : f,
              );
              return r;
            })
          : null,
    });
    demoRef = demo;
    await entrar();
    await abrirModulo('Empréstimo');
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('furadeira');
    const item = await screen.findByRole('article', { name: 'Furadeira de impacto 650 W' });
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    const folha = await screen.findByRole('dialog');
    expect(folha.querySelector('.tm-etiquetas--virtual')).toBeTruthy();
    expect(within(folha).queryAllByRole('button', { name: /PAT-V/ }).length).toBeLessThan(150);
  });
});
