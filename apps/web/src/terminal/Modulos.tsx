/**
 * Logo depois do login: dois cartões grandes (Empréstimo × Retirada). Dentro de cada módulo, a tela inicial com as
 * ações dele: Empréstimo → pegar, devolver, meus empréstimos; Retirada → retirar, minhas retiradas.
 */
import { m } from 'motion/react';
import { Badge, Icone, MOVIMENTO } from '../ui';
import { useTerminal } from './estado';
import { IconeTm, type NomeIconeTm } from './icones';
import { aberto, devolviveis, ehRM, plural, prazoInfo, primeiroNome } from './regras';
import type { Modulo } from './tipos';

const entrada = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: MOVIMENTO.medio, delay: Math.min(i, 6) * 0.04, ease: MOVIMENTO.curva },
});

const TEXTO: Record<Modulo, { titulo: string; reg: string; icone: NomeIconeTm; desc: string; pontos: string[] }> = {
  emprestimo: {
    titulo: 'Empréstimo',
    reg: 'EM · REG.0306',
    icone: 'volta',
    desc: 'Pega a ferramenta e devolve depois.',
    pontos: ['Pegar ferramentas', 'Devolver', 'Meus empréstimos'],
  },
  retirada: {
    titulo: 'Retirada',
    reg: 'RM · REG.0305',
    icone: 'saida',
    desc: 'O item sai do estoque e não volta.',
    pontos: ['Só itens liberados para retirada', 'O almoxarifado confirma a baixa'],
  },
};

export function TelaModulos() {
  const { sessao, ir, abertos } = useTerminal();
  const nome = primeiroNome(sessao?.colaborador.nome);
  const emAberto = (abertos ?? []).filter((e) => !ehRM(e) && aberto(e));
  const rmAguardando = (abertos ?? []).filter((e) => ehRM(e) && e.status === 'aguardando_baixa');
  const contagem: Record<Modulo, string> = {
    emprestimo: emAberto.length ? plural(emAberto.length, 'empréstimo em aberto', 'empréstimos em aberto') : '',
    retirada: rmAguardando.length ? plural(rmAguardando.length, 'aguardando baixa', 'aguardando baixa') : '',
  };
  return (
    <section className="tm-tela tm-modulos">
      <div className="tm-cabecalho__textos">
        <p className="tm-sobretitulo">Olá{nome ? `, ${nome}` : ''}</p>
        <h1 className="tm-titulo-grande">O que você vai fazer?</h1>
      </div>
      <div className="tm-modulos__grade">
        {(Object.keys(TEXTO) as Modulo[]).map((k, i) => (
          <m.button
            key={k}
            type="button"
            className={`bm-painel tm-modulo tm-modulo--${k}`}
            onClick={() => ir('inicio', k)}
            whileTap={{ scale: 0.98 }}
            {...entrada(i)}
          >
            <span className="tm-modulo__icone" aria-hidden="true">
              <IconeTm nome={TEXTO[k].icone} tamanho={40} />
            </span>
            <span className="tm-modulo__reg">{TEXTO[k].reg}</span>
            <span className="tm-modulo__titulo">{TEXTO[k].titulo}</span>
            <span className="tm-modulo__desc">{TEXTO[k].desc}</span>
            <span className="tm-modulo__pontos">
              {TEXTO[k].pontos.map((p) => (
                <span key={p}>
                  <Icone nome="check" tamanho={16} /> {p}
                </span>
              ))}
            </span>
            {contagem[k] && (
              <Badge tom={k === 'retirada' ? 'info' : 'aviso'} className="tm-modulo__selo">
                {contagem[k]}
              </Badge>
            )}
            <span className="tm-modulo__ir" aria-hidden="true">
              <Icone nome="direita" tamanho={26} />
            </span>
          </m.button>
        ))}
      </div>
    </section>
  );
}

interface Acao {
  id: string;
  titulo: string;
  desc: string;
  icone: NomeIconeTm;
  principal?: boolean;
  ir: () => void;
  selo?: string;
}

export function TelaInicio() {
  const { modulo, ir, abertos, bandeja } = useTerminal();
  const rm = modulo === 'retirada';
  const lista = abertos ?? [];
  const meusEM = lista.filter((e) => !ehRM(e) && aberto(e));
  const aDevolver = meusEM.filter((e) => devolviveis(e).length > 0);
  const atrasados = meusEM.filter((e) => prazoInfo(e)[0] === 'ruim');
  const rmAguardando = lista.filter((e) => ehRM(e) && e.status === 'aguardando_baixa');
  const acoes: Acao[] = rm
    ? [
        {
          id: 'retirar',
          titulo: 'Retirar',
          desc: 'Itens que saem do estoque e não voltam.',
          icone: 'saida',
          principal: true,
          ir: () => ir('catalogo'),
          selo: bandeja.length ? plural(bandeja.length, 'separado', 'separados') : undefined,
        },
        {
          id: 'meus',
          titulo: 'Minhas retiradas',
          desc: 'Aguardando baixa e já baixadas.',
          icone: 'historico',
          ir: () => ir('meus'),
          selo: rmAguardando.length ? plural(rmAguardando.length, 'aguardando baixa', 'aguardando baixa') : undefined,
        },
      ]
    : [
        {
          id: 'pegar',
          titulo: 'Pegar ferramentas',
          desc: 'Separe, confira e confirme o empréstimo.',
          icone: 'separar',
          principal: true,
          ir: () => ir('catalogo'),
          selo: bandeja.length ? plural(bandeja.length, 'separado', 'separados') : undefined,
        },
        {
          id: 'devolver',
          titulo: 'Devolver',
          desc: aDevolver.length ? 'Escolha o empréstimo e o que está devolvendo.' : 'Nada para devolver agora.',
          icone: 'devolver',
          ir: () => ir('devolver'),
          selo: aDevolver.length ? plural(aDevolver.length, 'em aberto', 'em aberto') : undefined,
        },
        {
          id: 'meus',
          titulo: 'Meus empréstimos',
          desc: 'Em aberto, prazos e histórico.',
          icone: 'historico',
          ir: () => ir('meus'),
        },
      ];
  return (
    <section className="tm-tela tm-inicio">
      <div className="tm-cabecalho__textos">
        <p className="tm-sobretitulo">
          <IconeTm nome={rm ? 'saida' : 'volta'} tamanho={18} /> {rm ? 'Retirada · RM' : 'Empréstimo · EM'}
        </p>
        <h1 className="tm-titulo-grande">{rm ? 'Retirada de material' : 'Empréstimo de ferramentas'}</h1>
        <p className="tm-lead">
          {rm
            ? 'O que você retirar sai do estoque e fica aguardando a baixa do almoxarifado. Não precisa devolver.'
            : 'A ferramenta volta: devolva até o prazo, em boas condições.'}
        </p>
      </div>
      {!rm && atrasados.length > 0 && (
        <p className="tm-faixa tm-faixa--ruim" role="alert">
          <Icone nome="alerta" tamanho={20} />
          Você tem {plural(atrasados.length, 'empréstimo atrasado', 'empréstimos atrasados')}. Devolva o quanto antes.
        </p>
      )}
      <div className={`tm-acoes-grade${rm ? ' tm-acoes-grade--dois' : ''}`}>
        {acoes.map((a, i) => (
          <m.button
            key={a.id}
            type="button"
            className={`bm-painel tm-acao${a.principal ? ' tm-acao--principal' : ''}`}
            onClick={a.ir}
            whileTap={{ scale: 0.98 }}
            {...entrada(i)}
          >
            <span className="tm-acao__icone" aria-hidden="true">
              <IconeTm nome={a.icone} tamanho={32} />
            </span>
            <span className="tm-acao__titulo">{a.titulo}</span>
            <span className="tm-acao__desc">{a.desc}</span>
            {a.selo && <Badge tom={a.principal ? 'acao' : 'info'}>{a.selo}</Badge>}
          </m.button>
        ))}
      </div>
    </section>
  );
}
