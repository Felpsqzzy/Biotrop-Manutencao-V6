/**
 * Logo depois do login: a tela inicial do empréstimo (só empréstimo de ferramentas, migration 49; a retirada sem
 * devolução saiu do terminal). Ações: pegar, devolver, meus empréstimos; e a faixa "Confirmar recebimento" quando o
 * almoxarife entregou no balcão um empréstimo que ainda espera o "recebi" do colaborador (dupla confirmação).
 */
import { m } from 'motion/react';
import { Badge, Botao, Icone, MOVIMENTO } from '../ui';
import { useTerminal } from './estado';
import { IconeTm, type NomeIconeTm } from './icones';
import { aberto, devolviveis, ehRM, pedeRecebimento, plural, prazoInfo, primeiroNome } from './regras';

const entrada = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: MOVIMENTO.medio, delay: Math.min(i, 6) * 0.04, ease: MOVIMENTO.curva },
});

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
  const { sessao, ir, abertos, bandeja } = useTerminal();
  const nome = primeiroNome(sessao?.colaborador.nome);
  const lista = abertos ?? [];
  const meusEM = lista.filter((e) => !ehRM(e) && aberto(e));
  const aDevolver = meusEM.filter((e) => devolviveis(e).length > 0);
  const atrasados = meusEM.filter((e) => prazoInfo(e)[0] === 'ruim');
  const aReceber = lista.filter(pedeRecebimento);
  const acoes: Acao[] = [
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
          <IconeTm nome="volta" tamanho={18} /> Olá{nome ? `, ${nome}` : ''}
        </p>
        <h1 className="tm-titulo-grande">Empréstimo de ferramentas</h1>
        <p className="tm-lead">A ferramenta volta: devolva até o fim do turno, em boas condições.</p>
      </div>
      {aReceber.length > 0 && (
        <div className="tm-faixa tm-faixa--aviso tm-faixa--acao" role="alert">
          <Icone nome="alerta" tamanho={20} />
          <span className="tm-faixa__texto">
            O almoxarifado entregou no balcão {plural(aReceber.length, 'empréstimo seu', 'empréstimos seus')}: confirme
            que recebeu.
          </span>
          <Botao variante="acao" onClick={() => ir('receber')}>
            <Icone nome="check" tamanho={20} /> Confirmar recebimento
          </Botao>
        </div>
      )}
      {atrasados.length > 0 && (
        <p className="tm-faixa tm-faixa--ruim" role="alert">
          <Icone nome="alerta" tamanho={20} />
          Você tem {plural(atrasados.length, 'empréstimo atrasado', 'empréstimos atrasados')}. Devolva o quanto antes.
        </p>
      )}
      <div className="tm-acoes-grade">
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
