/**
 * Botão flutuante do Manutinho + gaveta com o resumo. A Parte do Shell monta este componente (com sessão, dentro do
 * Router). O contador do botão = avisos críticos + de atenção; atualiza a cada 60 s com a aba visível.
 */
import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { contarNiveisManutinho } from '@biomanut/shared';
import { BuscaGuia } from './componentes/BuscaGuia';
import { GavetaManutinho } from './componentes/GavetaManutinho';
import { ListaAvisos } from './componentes/ListaAvisos';
import { useManutinhoResumo } from './hooks';
import './manutinho.css';

const LIMITE_NA_GAVETA = 6;

export function ManutinhoLauncher() {
  const [aberta, setAberta] = useState(false);
  const botao = useRef<HTMLButtonElement>(null);
  const resumo = useManutinhoResumo();
  const itens = resumo.data?.itens ?? [];
  const c = contarNiveisManutinho(itens);
  const urgentes = c.critico + c.atencao;
  const fechar = useCallback(() => {
    setAberta(false);
    botao.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={botao}
        type="button"
        className={`manu-launcher${c.critico ? ' manu-launcher--critico' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={aberta}
        aria-label={`Abrir o Manutinho${urgentes ? `: ${urgentes} ${urgentes === 1 ? 'aviso' : 'avisos'}` : ''}`}
        onClick={() => setAberta(true)}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M22.7 19.3 13.6 10.2a6 6 0 0 0-7.8-7.8l3.9 3.9-2.8 2.8-3.9-3.9a6 6 0 0 0 7.8 7.8l9.1 9.1a1 1 0 0 0 1.4 0l1.4-1.4a1 1 0 0 0 0-1.4Z"
          />
        </svg>
        {urgentes ? <span className="manu-launcher-contador">{urgentes > 99 ? '99+' : urgentes}</span> : null}
      </button>
      <GavetaManutinho aberta={aberta} onFechar={fechar} titulo="Manutinho">
        {resumo.isPending ? <p className="manu-vazio">Carregando…</p> : null}
        {resumo.isError ? <p className="manu-vazio">Não foi possível carregar os avisos agora.</p> : null}
        {resumo.data ? (
          <ListaAvisos itens={itens} limite={LIMITE_NA_GAVETA} vazio="Tudo em dia por aqui." onNavegar={fechar} />
        ) : null}
        <Link to="/manutinho" className="bm-botao bm-botao--acao manu-abrir" onClick={fechar}>
          Abrir o Manutinho
        </Link>
        <BuscaGuia />
      </GavetaManutinho>
    </>
  );
}
