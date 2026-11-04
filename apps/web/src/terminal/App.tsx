// Casca do terminal: topo fixo, a tela da vez (entra suave a cada troca), a bandeja e as camadas por cima.
import type { ReactNode } from 'react';
import { m } from 'motion/react';
import { MOVIMENTO } from '../ui';
import { TelaAutorizacoes } from './Autorizacao';
import { Bandeja, TelaCatalogo } from './Catalogo';
import { TelaConferencia, TelaDevolver, TelaDevolverItens, TelaDevolverOk, TelaDevolverRevisao } from './Devolver';
import { TelaEntrega } from './Entrega';
import { Fundo, TelaEntrada, TelaPrimeiro } from './Entrada';
import { TerminalProvider, useTerminal, type Tela } from './estado';
import { TelaMeus } from './Meus';
import { TelaInicio } from './Inicio';
import { TelaReceber } from './Receber';
import { TelaRevisao, TelaSucesso } from './Revisao';
import { AvisoInatividade, SaidaAdmin, Saindo } from './Sobreposicoes';
import { useTelaAtiva } from './telaAtiva';
import { useTelaCheia } from './telaCheia';
import { Topo } from './Topo';

const TELAS: Record<Tela, () => ReactNode> = {
  entrada: () => <TelaEntrada />,
  primeiro: () => <TelaPrimeiro />,
  inicio: () => <TelaInicio />,
  catalogo: () => <TelaCatalogo />,
  revisao: () => <TelaRevisao />,
  sucesso: () => <TelaSucesso />,
  devolver: () => <TelaDevolver />,
  'devolver-itens': () => <TelaDevolverItens />,
  'devolver-revisao': () => <TelaDevolverRevisao />,
  'devolver-ok': () => <TelaDevolverOk />,
  receber: () => <TelaReceber />,
  meus: () => <TelaMeus />,
  entrega: () => <TelaEntrega />,
  autorizacoes: () => <TelaAutorizacoes />,
  conferencia: () => <TelaConferencia />,
};

function Casca() {
  const { tela, geracaoEntrada } = useTerminal();
  const publica = tela === 'entrada' || tela === 'primeiro';
  const chave = `${tela}:${publica ? geracaoEntrada : ''}`;
  return (
    <div className={`tm-app${publica ? ' tm-app--publica' : ''}`} data-tela={tela}>
      {publica && <Fundo />}
      <Topo />
      <main className="tm-principal">
        <m.div
          key={chave}
          className="tm-palco"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: MOVIMENTO.medio, ease: MOVIMENTO.curva }}
        >
          {TELAS[tela]()}
        </m.div>
      </main>
      <Bandeja />
      <AvisoInatividade />
      <SaidaAdmin />
      <Saindo />
    </div>
  );
}

export function Terminal() {
  useTelaCheia();
  useTelaAtiva();
  return (
    <TerminalProvider>
      <Casca />
    </TerminalProvider>
  );
}
