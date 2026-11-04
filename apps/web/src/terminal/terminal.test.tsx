// Terminal (tablet), só empréstimo (migration 49): login direto no empréstimo, cartões × lista, CAMM de cada ferramenta e
// filtro por CAMM, Separar/contador/bandeja, unidade pela etiqueta na folha, finalidade, prazo do fim do turno, termo de
// responsabilidade, dupla confirmação (recebimento, sem almoxarife), chave de operação (reenvio usa a mesma) e a trava
// de 700 ms no sucesso.
// Roda contra o demo em memória (mesmo contrato da rota /api/terminal), sem atraso.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { chamar, definirTransporte, erroDe, type Transporte } from './api';
import { Terminal } from './App';
import { criarDemo, prazoTurno } from './demo';

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
  await screen.findByRole('heading', { name: 'Empréstimo de ferramentas' });
}

async function buscar(texto: string) {
  fireEvent.change(screen.getByLabelText('Buscar ferramenta'), { target: { value: texto } });
}

/** Separa uma ferramenta por quantidade (busca e toca em Separar). */
async function separar(busca: string, nome: string) {
  await buscar(busca);
  const item = await screen.findByRole('article', { name: nome });
  fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
  return item;
}

/** Na revisão: CAMM, finalidade (e número), termo. Espera o termo vir do servidor (/prazo). */
async function preencherPedido(opc: { camm?: string; finalidade?: string; ref?: string; termo?: boolean } = {}) {
  const { camm = 'CAMM 2', finalidade = 'Manutenção (OM)', ref = '40125', termo = true } = opc;
  const termoCaixa = await screen.findByRole('checkbox', { name: /Termo de responsabilidade/ });
  if (camm)
    fireEvent.click(within(screen.getByRole('group', { name: 'Sua CAMM' })).getByRole('button', { name: camm }));
  if (finalidade)
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Finalidade' })).getByRole('button', { name: finalidade }),
    );
  if (ref) fireEvent.change(screen.getByLabelText(/^Número da/), { target: { value: ref } });
  if (termo) fireEvent.click(termoCaixa);
}

const posts = (chamadas: Chamada[], url = '/api/terminal/emprestimos') =>
  chamadas.filter((c) => c.metodo === 'POST' && c.url === url);

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
  it('depois do login vai direto ao empréstimo: sem Retirada (RM) nem troca de módulo', async () => {
    montar();
    await entrar();
    expect(screen.queryByRole('navigation', { name: 'Trocar de módulo' })).toBeNull();
    expect(screen.queryByText(/Retirada|Retirar/)).toBeNull();
    expect(screen.getByRole('button', { name: /Pegar ferramentas/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Devolver/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Meus empréstimos/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sair/ })).toBeTruthy();
  });

  it('alterna cartões ↔ lista, lembra a escolha e cada ferramenta mostra a CAMM onde fica', async () => {
    montar();
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('trena');
    const item = await screen.findByRole('article', { name: 'Trena 5 m' });
    expect(item.classList.contains('tm-item--cards')).toBe(true);
    expect(item.querySelector('.tm-item__camm')?.textContent).toBe('CAMM 3');
    fireEvent.click(screen.getByRole('button', { name: 'Lista' }));
    expect(screen.getByRole('article', { name: 'Trena 5 m' }).classList.contains('tm-item--lista')).toBe(true);
    expect(localStorage.getItem('tm-vista')).toBe('lista');
    expect(screen.getByRole('button', { name: 'Lista' }).getAttribute('aria-pressed')).toBe('true');
    // sem CAMM ainda: não mostra nada
    await buscar('paquimetro');
    const sem = await screen.findByRole('article', { name: 'Paquímetro digital 150 mm' });
    expect(sem.querySelector('.tm-item__camm')).toBeNull();
  });

  it('todas as ferramentas aparecem (lista virtualizada); o chip de CAMM filtra no servidor e "Todas" volta', async () => {
    const { chamadas } = montar();
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    const camms = await screen.findByRole('group', { name: 'CAMM' });
    expect(
      within(camms)
        .getAllByRole('button')
        .map((b) => b.textContent!.trim()),
    ).toEqual(['Todas', 'CAMM 1', 'CAMM 2', 'CAMM 3', 'C. LOG']);
    // mais de 100 itens: lista virtualizada (só as linhas à vista vão para o DOM)
    await waitFor(() => expect(document.querySelector('.tm-virtual')).toBeTruthy());
    const ferramentas = () =>
      chamadas.filter((c) => c.metodo === 'GET' && c.url.startsWith('/api/terminal/ferramentas'));
    expect(ferramentas().at(-1)!.url).toBe('/api/terminal/ferramentas');
    fireEvent.click(within(camms).getByRole('button', { name: /CAMM 2/ }));
    await waitFor(() => expect(ferramentas().at(-1)!.url).toBe('/api/terminal/ferramentas?camm=CAMM+2'));
    await buscar('allen 1,5');
    const grupo = await screen.findByRole('article', { name: 'Jogo de chaves Allen 1,5-10 mm' });
    // só as peças da CAMM 2 (3 das 6)
    expect(within(grupo).getByText(/de 3 peças livres/)).toBeTruthy();
    await waitFor(() => expect(ferramentas().at(-1)!.url).toBe('/api/terminal/ferramentas?q=allen+1%2C5&camm=CAMM+2'));
    expect(grupo.querySelector('.tm-item__camm')?.textContent).toBe('CAMM 2');
    fireEvent.click(within(camms).getByRole('button', { name: 'Todas' }));
    const todas = await screen.findByText(/de 6 peças livres/);
    expect(todas.closest('article')!.querySelector('.tm-item__camm')?.textContent).toBe('Em 2 CAMMs');
  });

  it('avisa "Muitos itens" quando a lista vem cortada', async () => {
    montar({ maxCatalogo: 50 });
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await screen.findByText(/Muitos itens: refine a busca/);
    const chips = screen.getByRole('group', { name: 'Categorias' });
    expect(within(chips).getByRole('button', { name: /Todas/ }).textContent).toContain('50');
    await buscar('trena');
    await waitFor(() => expect(screen.queryByText(/Muitos itens/)).toBeNull());
    expect(screen.getByRole('article', { name: 'Trena 5 m' })).toBeTruthy();
  });

  it('Separar vira contador; a revisão mostra o prazo do fim do turno (do servidor) e pede o termo antes de confirmar', async () => {
    const { chamadas } = montar();
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    const item = await separar('trena', 'Trena 5 m');
    expect(screen.queryByText(/carrinho/i)).toBeNull();
    expect(within(item).getByText('Separado')).toBeTruthy();
    expect(within(item).getByRole('status').textContent).toBe('1');
    fireEvent.click(within(item).getByRole('button', { name: 'Mais um de Trena 5 m' }));
    expect(within(item).getByRole('status').textContent).toBe('2');
    expect(screen.getByText('2 itens separados')).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Tirar um de Trena 5 m' }));
    expect(screen.getByText('1 item separado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await screen.findByText('Revisar o empréstimo');
    const termo = await screen.findByRole('checkbox', { name: /Termo de responsabilidade/ });
    expect(termo.closest('label')!.textContent).toContain('me responsabilizo por devolvê-las no prazo');
    expect(chamadas.some((c) => c.metodo === 'GET' && c.url === '/api/terminal/prazo')).toBe(true);
    expect(screen.getByText(/Devolver até \d\d\/\d\d às \d\d:\d\d \(fim do turno\)/)).toBeTruthy();
    // prazo só exibido: nenhum campo de prazo
    expect(document.querySelector('input[type="date"], input[type="datetime-local"]')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    const confirmar = screen.getByRole('button', { name: /Confirmar empréstimo/ }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.click(termo);
    expect(confirmar.disabled).toBe(false);
  });

  it('pedido: CAMM, finalidade e número obrigatórios na tela; CAPEX vai sem número; o corpo leva o termo aceito', async () => {
    const { chamadas } = montar();
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await separar('trena', 'Trena 5 m');
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    expect(
      within(await screen.findByRole('group', { name: 'Finalidade' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Manutenção (OM)', 'CAPEX', 'TPM', 'Empresa terceira', 'Outra']);
    await preencherPedido({ camm: '', finalidade: '', ref: '' });
    const confirmar = screen.getByRole('button', { name: /Confirmar empréstimo/ });
    fireEvent.click(confirmar);
    expect(screen.getByRole('alert').textContent).toBe('Escolha a sua CAMM.');
    fireEvent.click(within(screen.getByRole('group', { name: 'Sua CAMM' })).getByRole('button', { name: 'C. LOG' }));
    fireEvent.click(confirmar);
    expect(screen.getByRole('alert').textContent).toBe('Escolha a finalidade do empréstimo.');
    fireEvent.click(within(screen.getByRole('group', { name: 'Finalidade' })).getByRole('button', { name: 'TPM' }));
    fireEvent.click(confirmar);
    expect(screen.getByRole('alert').textContent).toBe('Informe o número da TPM.');
    expect(posts(chamadas)).toHaveLength(0);
    // terceira e outra: campo opcional; CAPEX: sem campo
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Finalidade' })).getByRole('button', { name: 'Empresa terceira' }),
    );
    expect(screen.getByLabelText('Qual empresa? (opcional)')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Finalidade' })).getByRole('button', { name: 'CAPEX' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(confirmar);
    await screen.findByText('Empréstimo registrado');
    const corpo = posts(chamadas)[0]!.corpo as Record<string, unknown>;
    expect(corpo).toMatchObject({ finalidade: 'capex', finalidadeRef: '', camm: 'C. LOG', termoAceito: true });
    expect(corpo).not.toHaveProperty('modalidade');
    expect(corpo).not.toHaveProperty('semAlmoxarife');
    expect(corpo).not.toHaveProperty('prazo');
    expect(screen.getByText(/Devolva até .* \(fim do turno\)/)).toBeTruthy();
  });

  it('erro do servidor no empréstimo: a mensagem dele aparece como veio', async () => {
    const { chamadas } = montar({
      desvio: (metodo, url) =>
        metodo === 'POST' && url === '/api/terminal/emprestimos'
          ? Promise.resolve({ status: 400, json: { ok: false, erro: 'Informe o número da OM.' } })
          : null,
    });
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await separar('trena', 'Trena 5 m');
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await preencherPedido({ ref: '  7  ' });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText('Informe o número da OM.');
    expect((posts(chamadas)[0]!.corpo as { finalidadeRef: string }).finalidadeRef).toBe('7');
    expect(screen.getByText('Revisar o empréstimo')).toBeTruthy();
  });

  it('item por unidade: Separar abre a folha e a unidade escolhida pela etiqueta vai no pedido', async () => {
    const { chamadas } = montar();
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('furadeira');
    const item = await screen.findByRole('article', { name: 'Furadeira de impacto 650 W' });
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    const folha = await screen.findByRole('dialog');
    // PAT-D1001 está emprestada no demo: não aparece
    expect(within(folha).queryByText('PAT-D1001')).toBeNull();
    // a etiqueta mostra a CAMM e o local
    expect(within(folha).getByRole('button', { name: /PAT-D1002/ }).textContent).toContain('CAMM 1 · Armário A');
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
    await preencherPedido();
    fireEvent.click(screen.getByRole('checkbox', { name: /Sem almoxarife no turno/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText('Empréstimo registrado');
    const corpo = posts(chamadas)[0]!.corpo as {
      itens: { unidadeId?: string; quantidade: number }[];
      finalidade: string;
      finalidadeRef: string;
      camm: string;
      semAlmoxarife?: boolean;
    };
    expect(corpo.itens).toHaveLength(1);
    expect(corpo.itens[0]!.unidadeId).toBeTruthy();
    expect(corpo.itens[0]!.quantidade).toBe(1);
    expect([corpo.finalidade, corpo.finalidadeRef, corpo.camm, corpo.semAlmoxarife]).toEqual([
      'om',
      '40125',
      'CAMM 2',
      true,
    ]);
  });

  it('chave de operação: o reenvio sem resposta usa a mesma chave; o próximo pedido usa outra', async () => {
    const { chamadas } = montar({ falharPrimeiroPost: true });
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await separar('trena', 'Trena 5 m');
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await preencherPedido();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText(/Sem conexão com o servidor/);
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText('Empréstimo registrado');
    await screen.findByText(/já estava registrado/);
    const chave = (c: Chamada) => (c.corpo as { chave: string }).chave;
    expect(posts(chamadas)).toHaveLength(2);
    expect(chave(posts(chamadas)[1]!)).toBe(chave(posts(chamadas)[0]!));

    // próximo pedido: chave nova
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    fireEvent.click(screen.getByRole('button', { name: /Fazer outro empréstimo/ }));
    vi.restoreAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: /Pegar ferramentas/ }));
    await separar('alicate universal', 'Alicate universal 8"');
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await preencherPedido();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText('Empréstimo registrado');
    const todos = posts(chamadas);
    expect(todos).toHaveLength(3);
    expect(chave(todos[2]!)).not.toBe(chave(todos[0]!));
  });

  it('na tela de sucesso, toques nos primeiros 700 ms são ignorados', async () => {
    montar();
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await separar('trena', 'Trena 5 m');
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await preencherPedido();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
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

  it('dupla confirmação: empréstimo entregue no balcão pede "Confirmar recebimento" com o termo', async () => {
    const { chamadas } = montar();
    await entrar();
    const faixa = await screen.findByText(/entregou no balcão 1 empréstimo seu/);
    fireEvent.click(
      within(faixa.closest('.tm-faixa') as HTMLElement).getByRole('button', { name: /Confirmar recebimento/ }),
    );
    await screen.findByRole('heading', { name: 'Confirmar recebimento' });
    const cartao = await screen.findByRole('article');
    expect(cartao.textContent).toContain('Alicate universal 8"');
    expect(cartao.textContent).toContain('CAPEX · CAMM 2');
    const botao = within(cartao).getByRole('button', { name: /Confirmar recebimento/ }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.click(within(cartao).getByRole('checkbox', { name: /Termo de responsabilidade/ }));
    fireEvent.click(botao);
    await screen.findByText('Nada para confirmar');
    const rec = chamadas.filter((c) => c.metodo === 'POST' && c.url.endsWith('/recebimento'));
    expect(rec).toHaveLength(1);
    expect(rec[0]!.corpo).toEqual({ termoAceito: true });
    fireEvent.click(screen.getByRole('button', { name: /Voltar ao início/ }));
    await screen.findByRole('heading', { name: 'Empréstimo de ferramentas' });
    expect(screen.queryByText(/entregou no balcão/)).toBeNull();
  });

  it('recebimento recusado pelo servidor (409): mostra a mensagem dele', async () => {
    montar({
      desvio: (metodo, url) =>
        metodo === 'POST' && url.endsWith('/recebimento')
          ? Promise.resolve({
              status: 409,
              json: { ok: false, erro: 'Este empréstimo não pede confirmação de recebimento.' },
            })
          : null,
    });
    await entrar();
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar recebimento/ }));
    const cartao = await screen.findByRole('article');
    fireEvent.click(within(cartao).getByRole('checkbox', { name: /Termo de responsabilidade/ }));
    fireEvent.click(within(cartao).getByRole('button', { name: /Confirmar recebimento/ }));
    await screen.findByText('Este empréstimo não pede confirmação de recebimento.');
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

  it('durante o envio, "Separar mais" e Voltar ficam parados', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await separar('trena', 'Trena 5 m');
    fireEvent.click(screen.getByRole('button', { name: /Revisar/ }));
    await preencherPedido();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar empréstimo/ }));
    await screen.findByText(/Registrando/);
    const voltar = screen.getByRole('button', { name: /Voltar/ }) as HTMLButtonElement;
    expect((screen.getByRole('button', { name: /Separar mais/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(voltar.disabled).toBe(true);
    fireEvent.click(voltar);
    expect(screen.getByText('Revisar o empréstimo')).toBeTruthy();
    await act(async () => soltar());
    await screen.findByText('Empréstimo registrado');
  });

  it('devolução: durante o envio Voltar e Alterar ficam parados; "Sem almoxarife no turno" vai no pedido', async () => {
    let soltar: () => void = () => {};
    const segura = new Promise<void>((r) => (soltar = r));
    let demoRef: ReturnType<typeof criarDemo> | null = null;
    const { demo, chamadas } = montar({
      desvio: (metodo, url, corpo) =>
        metodo === 'POST' && url.endsWith('/devolucoes')
          ? segura.then(() => demoRef!.handle(metodo, url, corpo))
          : null,
    });
    demoRef = demo;
    await entrar();
    fireEvent.click(screen.getByRole('button', { name: /^Devolver/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Devolver deste/ }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /Marcar todos/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar devolução/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Sem almoxarife no turno/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmar devolução/ }));
    await screen.findByText(/Registrando/);
    const voltar = screen.getByRole('button', { name: /Voltar/ }) as HTMLButtonElement;
    const alterar = screen.getByRole('button', { name: /Alterar/ }) as HTMLButtonElement;
    expect([voltar.disabled, alterar.disabled]).toEqual([true, true]);
    expect(screen.getByText('Revisar a devolução')).toBeTruthy();
    await act(async () => soltar());
    await screen.findByText('Devolução registrada');
    const dev = chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/devolucoes'));
    expect((dev!.corpo as { semAlmoxarife?: boolean }).semAlmoxarife).toBe(true);
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
    fireEvent.click(screen.getByRole('button', { name: /Meus empréstimos/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: /^Devolver$/ }))[0]!);
    await screen.findByText('Não deu para buscar seus empréstimos');
    falhar = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    await screen.findByRole('button', { name: /Revisar devolução/ });
  });

  it('Meus empréstimos: finalidade, CAMM e entrega; a RM antiga fica no histórico; mais de 100 é virtualizado', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Meus empréstimos/ }));
    await screen.findAllByRole('article');
    const balcao = screen.getAllByRole('article').find((a) => a.textContent!.includes('Alicate universal'))!;
    expect(balcao.textContent).toContain('CAPEX · CAMM 2');
    expect(balcao.textContent).toContain('confirme o recebimento');
    expect(within(balcao).getByRole('button', { name: /Confirmar recebimento/ })).toBeTruthy();
    const terminal = screen.getAllByRole('article').find((a) => a.textContent!.includes('Furadeira'))!;
    expect(terminal.textContent).toContain('Manutenção (OM) 40125 · CAMM 1');
    fireEvent.click(screen.getByRole('button', { name: /Histórico/ }));
    const rm = (await screen.findAllByRole('article')).find((a) => a.textContent!.includes('Martelo'))!;
    expect(within(rm).getByText('RM')).toBeTruthy();
    expect(rm.textContent).toContain('Baixada pelo almoxarifado');
    lote = true;
    fireEvent.click(screen.getByRole('button', { name: /Voltar/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /Pegar ferramentas/ }));
    await buscar('furadeira');
    const item = await screen.findByRole('article', { name: 'Furadeira de impacto 650 W' });
    fireEvent.click(within(item).getByRole('button', { name: /Separar/ }));
    const folha = await screen.findByRole('dialog');
    expect(folha.querySelector('.tm-etiquetas--virtual')).toBeTruthy();
    expect(within(folha).queryAllByRole('button', { name: /PAT-V/ }).length).toBeLessThan(150);
  });
});

describe('demo do terminal (contrato da rota, migration 49)', () => {
  it('prazo do fim do turno pela hora de Brasília: antes das 18:00 → 18:00; depois → 07:00 do dia seguinte', () => {
    expect(new Date(prazoTurno(Date.UTC(2026, 10, 3, 12, 0))).toISOString()).toBe('2026-11-03T21:00:00.000Z');
    expect(new Date(prazoTurno(Date.UTC(2026, 10, 3, 21, 0))).toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(new Date(prazoTurno(Date.UTC(2026, 11, 31, 23, 30))).toISOString()).toBe('2027-01-01T10:00:00.000Z');
    // madrugada (00:00–06:59 de Brasília, turno da noite) → 07:00 do mesmo dia
    expect(new Date(prazoTurno(Date.UTC(2026, 10, 4, 5, 30))).toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(new Date(prazoTurno(Date.UTC(2026, 10, 4, 9, 59))).toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(new Date(prazoTurno(Date.UTC(2026, 10, 4, 10, 0))).toISOString()).toBe('2026-11-04T21:00:00.000Z');
  });

  it('recusa retirada (RM), material, finalidade fora da lista, OM sem número e sem termo', async () => {
    const demo = criarDemo({ atraso: 0 });
    await demo.handle('POST', '/api/terminal/entrar', { matricula: '10421', senha: '480256' });
    const ferr = (await demo.handle('GET', '/api/terminal/ferramentas?q=trena')).json as unknown as {
      rows: { id: string }[];
    };
    const base = {
      chave: 'tm-teste-0001',
      itens: [{ ferramentaId: ferr.rows[0]!.id, quantidade: 1 }],
      finalidade: 'capex',
      camm: 'CAMM 1',
      termoAceito: true,
    };
    const erro = async (corpo: Record<string, unknown>) =>
      ((await demo.handle('POST', '/api/terminal/emprestimos', { ...base, ...corpo })).json as { erro?: string }).erro;
    expect(await erro({ modalidade: 'retirada' })).toMatch(/Retirada sem devolução/);
    expect(await erro({ itens: [{ materialCodigo: 'MAT-1', quantidade: 1 }] })).toMatch(/só ferramentas/);
    expect(await erro({ finalidade: 'consumo' })).toMatch(/Finalidade inválida/);
    expect(await erro({ finalidade: 'om', finalidadeRef: '' })).toBe('Informe o número da OM.');
    expect(await erro({ termoAceito: undefined })).toMatch(/termo de responsabilidade/);
    expect(await erro({ camm: 'CAMM 9' })).toMatch(/CAMM inválida/);
    const r = await demo.handle('POST', '/api/terminal/emprestimos', base);
    expect(r.status).toBe(201);
  });
});

describe('demo da V5 (window.BIOTROP_EMPRESTIMO_DEMO)', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'BIOTROP_EMPRESTIMO_DEMO');
    definirTransporte(null);
    vi.unstubAllGlobals();
  });

  it('ativo: a chamada vai para handle(método, url, corpo), sem rede, com o mesmo tratamento de resposta e erro', async () => {
    const rede = vi.fn();
    vi.stubGlobal('fetch', rede);
    const handle = vi.fn((_m: string, url: string) =>
      Promise.resolve(
        url.endsWith('/eu')
          ? { status: 200, json: { ok: true, colaborador: { nome: '[TESTE]' } } }
          : { status: 400, json: { ok: false, erro: 'O PIN precisa ter exatamente 6 dígitos (só números).' } },
      ),
    );
    Object.assign(globalThis, { BIOTROP_EMPRESTIMO_DEMO: { ativo: () => true, handle } });
    definirTransporte(null);
    const eu = await chamar('GET', '/eu');
    expect(eu.ok).toBe(true);
    const corpo = { matricula: '10421', codigo: 'ABCD-EFGH', senha: '12' };
    const r = await chamar('POST', '/primeiro-acesso', corpo);
    expect([r.ok, r.status, erroDe(r)]).toEqual([false, 400, 'O PIN precisa ter exatamente 6 dígitos (só números).']);
    expect(handle).toHaveBeenNthCalledWith(1, 'GET', '/api/terminal/eu', undefined);
    expect(handle).toHaveBeenNthCalledWith(2, 'POST', '/api/terminal/primeiro-acesso', corpo);
    expect(rede).not.toHaveBeenCalled();
  });

  it('inativo (VM, ou fora da prévia): segue com o fetch de /api/terminal', async () => {
    const rede = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal('fetch', rede);
    const handle = vi.fn();
    Object.assign(globalThis, { BIOTROP_EMPRESTIMO_DEMO: { ativo: () => false, handle } });
    definirTransporte(null);
    expect((await chamar('GET', '/eu')).ok).toBe(true);
    expect(handle).not.toHaveBeenCalled();
    expect(rede).toHaveBeenCalledWith('/api/terminal/eu', expect.objectContaining({ method: 'GET' }));
  });
});

describe('terminal no tablet: tela cheia e teclado da tela', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  });

  it('pede tela cheia no toque, não repete em tela cheia e pede de novo se o tablet sair dela', () => {
    const pedir = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, 'requestFullscreen', { value: pedir, configurable: true });
    montar();
    expect(pedir).not.toHaveBeenCalled();
    fireEvent.pointerUp(document.body);
    expect(pedir).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true });
    fireEvent.pointerUp(document.body);
    expect(pedir).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    fireEvent.pointerUp(document.body);
    expect(pedir).toHaveBeenCalledTimes(2);
  });

  it('matrícula e PIN não abrem o teclado do tablet (entrada, primeiro acesso e saída administrativa)', async () => {
    montar();
    const semNativo = (el: HTMLElement) => expect(el.getAttribute('inputmode')).toBe('none');
    semNativo(screen.getByLabelText('Matrícula'));
    const pin = screen.getByLabelText(/^PIN,/);
    semNativo(pin);
    expect(pin.hasAttribute('readonly')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Primeiro acesso/ }));
    const mat = await screen.findByLabelText('Matrícula');
    semNativo(mat);
    const teclado = screen.getByRole('group', { name: /Teclado numérico/ });
    for (const d of '104') fireEvent.click(within(teclado).getByRole('button', { name: d }));
    expect((mat as HTMLInputElement).value).toBe('104');
    // código do convite tem letras (ABCD-EFGH): fica com o teclado do tablet, só ao tocar
    expect(screen.getByLabelText('Código do convite').getAttribute('inputmode')).not.toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'Minha matrícula tem letras' }));
    expect(mat.getAttribute('inputmode')).toBe('text');

    fireEvent.keyDown(document, { key: 'S', code: 'KeyS', ctrlKey: true, altKey: true, shiftKey: true });
    const dlg = await screen.findByRole('dialog', { name: 'Liberar o tablet' });
    semNativo(within(dlg).getByLabelText('Matrícula'));
  });
});

describe('terminal no tablet: tela sempre acesa (Wake Lock)', () => {
  type TravaFalsa = EventTarget & { released: boolean; release: () => Promise<void> };
  function travaFalsa(recusar = 0) {
    const travas: TravaFalsa[] = [];
    const cair = (t: TravaFalsa) => {
      if (t.released) return;
      t.released = true;
      t.dispatchEvent(new Event('release'));
    };
    const request = vi.fn(async () => {
      if (recusar > 0) {
        recusar--;
        throw new DOMException('sem gesto', 'NotAllowedError');
      }
      const t = new EventTarget() as TravaFalsa;
      t.released = false;
      t.release = vi.fn(async () => cair(t));
      travas.push(t);
      return t;
    });
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    return { request, travas, cair };
  }
  const oculta = (sim: boolean) => {
    Object.defineProperty(document, 'hidden', { value: sim, configurable: true });
    fireEvent(document, new Event('visibilitychange'));
  };
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    Reflect.deleteProperty(document, 'hidden');
  });

  it('pede ao abrir, pede de novo quando o sistema solta e ao voltar a aba, e solta ao fechar', async () => {
    const wl = travaFalsa();
    montar();
    await waitFor(() => expect(wl.request).toHaveBeenCalledTimes(1));
    expect(wl.request).toHaveBeenCalledWith('screen');
    // toque com a trava de pé não pede outra
    fireEvent.pointerUp(document.body);
    await act(async () => {});
    expect(wl.request).toHaveBeenCalledTimes(1);

    // o sistema soltou (bateria, etc.) com a aba visível: pede outra
    act(() => wl.cair(wl.travas[0]!));
    await waitFor(() => expect(wl.request).toHaveBeenCalledTimes(2));

    // aba oculta: o sistema solta e não adianta pedir; ao voltar, pede
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    act(() => wl.cair(wl.travas[1]!));
    oculta(true);
    await act(async () => {});
    expect(wl.request).toHaveBeenCalledTimes(2);
    oculta(false);
    await waitFor(() => expect(wl.request).toHaveBeenCalledTimes(3));

    cleanup();
    expect(wl.travas[2]!.release).toHaveBeenCalledTimes(1);
    expect(wl.travas[2]!.released).toBe(true);
    await act(async () => {});
    expect(wl.request).toHaveBeenCalledTimes(3);
  });

  it('recusado ao abrir (sem gesto): pede no primeiro toque ou tecla; pagehide solta sem pedir de novo', async () => {
    const wl = travaFalsa(2);
    montar();
    await waitFor(() => expect(wl.request).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: '1' });
    await waitFor(() => expect(wl.request).toHaveBeenCalledTimes(2));
    fireEvent.pointerUp(document.body);
    await waitFor(() => expect(wl.travas).toHaveLength(1));
    expect(wl.request).toHaveBeenCalledTimes(3);

    fireEvent(window, new Event('pagehide'));
    expect(wl.travas[0]!.released).toBe(true);
    await act(async () => {});
    expect(wl.request).toHaveBeenCalledTimes(3);
  });

  it('navegador sem Wake Lock (ou fora de HTTPS): o terminal abre normal', () => {
    expect('wakeLock' in navigator).toBe(false);
    expect(() => montar()).not.toThrow();
    expect(screen.getByLabelText('Matrícula')).toBeTruthy();
    fireEvent.pointerUp(document.body);
    oculta(false);
  });
});
