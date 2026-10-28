/**
 * Manutinho: assistente de manutenção sem IA. Abas Alertas (avisos + guia), Preventivas (relatório por equipamento,
 * setor e CAMM, exportável em CSV e PDF/A4) e Pendências (SCI/SCM, aprovações, medidores e treinamentos vencidos, com
 * a cobrança). Tudo vem do servidor já no recorte do perfil; esta tela só organiza.
 */
import { useEffect, useId, useState } from 'react';
import { contarNiveisManutinho, type ModuloManutinho } from '@biomanut/shared';
import { useSessao } from '../../../auth/useSessao';
import { Botao, Superficie } from '../../../ui';
import { Abas } from '../componentes/Abas';
import { BuscaGuia } from '../componentes/BuscaGuia';
import { CobrancaTreinamentos } from '../componentes/CobrancaTreinamentos';
import { ListaAvisos } from '../componentes/ListaAvisos';
import { RelatorioImpressao } from '../componentes/RelatorioImpressao';
import { TabelaPreventivas } from '../componentes/TabelaPreventivas';
import { baixarCsv, csvPreventivas, imprimirRelatorio } from '../exportar';
import { useManutinhoResumo, useRelatorioPreventivas, useTreinamentosVencidos } from '../hooks';
import '../manutinho.css';

type AbaId = 'alertas' | 'preventivas' | 'pendencias';
const PENDENCIAS: ModuloManutinho[] = ['solicitacoes', 'aprovacoes', 'medidores', 'treinamentos'];

function Estado({ carregando, erro }: { carregando: boolean; erro: unknown }) {
  if (carregando) return <p className="manu-vazio">Carregando…</p>;
  if (erro) return <p className="manu-vazio">Não foi possível carregar agora. Tente de novo em instantes.</p>;
  return null;
}

export default function ManutinhoPage() {
  const { data: eu } = useSessao();
  const idBase = useId();
  const [aba, setAba] = useState<AbaId>('alertas');
  const [imprimindo, setImprimindo] = useState(false);
  const resumo = useManutinhoResumo();
  const fontes = resumo.data?.fontes ?? [];
  const vePreventivas = fontes.includes('preventivas');
  const relatorio = useRelatorioPreventivas(vePreventivas && aba === 'preventivas');
  const treinamentos = useTreinamentosVencidos(fontes.includes('treinamentos') && aba === 'pendencias');

  useEffect(() => {
    if (!imprimindo) return;
    imprimirRelatorio();
    setImprimindo(false);
  }, [imprimindo]);

  const itens = resumo.data?.itens ?? [];
  const alertas = itens.filter((i) => i.nivel !== 'info' || !PENDENCIAS.includes(i.modulo));
  const pendencias = itens.filter((i) => PENDENCIAS.includes(i.modulo));
  const c = contarNiveisManutinho(itens);
  const abas = [
    { id: 'alertas' as const, rotulo: 'Alertas', contador: c.critico + c.atencao },
    ...(vePreventivas ? [{ id: 'preventivas' as const, rotulo: 'Preventivas' }] : []),
    { id: 'pendencias' as const, rotulo: 'Pendências', contador: pendencias.length },
  ];
  const rel = relatorio.data;

  return (
    <div className="manu-pagina">
      <header className="manu-cabecalho">
        <div>
          <h1 className="manu-h1">Manutinho</h1>
          <p className="manu-sub">
            Avisos e relatórios da manutenção a partir do banco, no recorte do seu perfil. Atualiza a cada minuto.
          </p>
        </div>
        {resumo.data ? (
          <p className="manu-resumo-contagem" aria-label="Contagem de avisos">
            <span className="manu-selo manu-selo--critico">{c.critico} críticos</span>
            <span className="manu-selo manu-selo--atencao">{c.atencao} de atenção</span>
          </p>
        ) : null}
      </header>

      <Abas abas={abas} atual={aba} onTrocar={setAba} idBase={idBase} />

      <div
        role="tabpanel"
        id={`${idBase}-painel-${aba}`}
        aria-labelledby={`${idBase}-aba-${aba}`}
        className="manu-painel-aba"
      >
        {aba === 'alertas' ? (
          <div className="manu-grade">
            <Superficie className="manu-bloco">
              <h2 className="manu-h2">Alertas</h2>
              <Estado carregando={resumo.isPending} erro={resumo.error} />
              {resumo.data ? <ListaAvisos itens={alertas} vazio="Tudo em dia por aqui." /> : null}
            </Superficie>
            <Superficie className="manu-bloco">
              <h2 className="manu-h2">Busca no guia</h2>
              <BuscaGuia resultados={3} />
            </Superficie>
          </div>
        ) : null}

        {aba === 'preventivas' ? (
          <Superficie className="manu-bloco">
            <div className="manu-bloco-topo">
              <h2 className="manu-h2">Relatório das preventivas</h2>
              <div className="manu-acoes">
                <Botao
                  disabled={!rel}
                  onClick={() => rel && baixarCsv(`preventivas-${rel.hoje}.csv`, csvPreventivas(rel))}
                >
                  Exportar CSV
                </Botao>
                <Botao disabled={!rel} onClick={() => setImprimindo(true)}>
                  Imprimir / PDF
                </Botao>
              </div>
            </div>
            <Estado carregando={relatorio.isPending} erro={relatorio.error} />
            {rel ? (
              <>
                <dl className="manu-kpis">
                  <div className="manu-kpi manu-kpi--critico">
                    <dt>Atrasadas</dt>
                    <dd>{rel.totais.atrasadas}</dd>
                  </div>
                  <div className="manu-kpi manu-kpi--atencao">
                    <dt>Sem programação</dt>
                    <dd>{rel.totais.semProgramacao}</dd>
                  </div>
                  <div className="manu-kpi manu-kpi--ok">
                    <dt>Em dia</dt>
                    <dd>{rel.totais.emDia}</dd>
                  </div>
                  <div className="manu-kpi">
                    <dt>Equipamentos</dt>
                    <dd>{rel.totais.total}</dd>
                  </div>
                </dl>
                <h3 className="manu-h3">Por setor</h3>
                <ul className="manu-setores">
                  {rel.porSetor.map((s) => (
                    <li key={s.setor} className="manu-setor">
                      <b>{s.setor}</b>
                      <span>
                        {s.atrasadas} atrasadas · {s.semProgramacao} sem programação · {s.emDia} em dia
                      </span>
                    </li>
                  ))}
                </ul>
                <h3 className="manu-h3">Por equipamento</h3>
                <TabelaPreventivas equipamentos={rel.equipamentos} />
                {imprimindo ? <RelatorioImpressao rel={rel} emitidoPor={eu?.nome ?? ''} /> : null}
              </>
            ) : null}
          </Superficie>
        ) : null}

        {aba === 'pendencias' ? (
          <div className="manu-grade">
            <Superficie className="manu-bloco">
              <h2 className="manu-h2">Pendências</h2>
              <Estado carregando={resumo.isPending} erro={resumo.error} />
              {resumo.data ? <ListaAvisos itens={pendencias} vazio="Nenhuma pendência no seu recorte." /> : null}
            </Superficie>
            {fontes.includes('treinamentos') && eu ? (
              <Superficie className="manu-bloco">
                <h2 className="manu-h2">Treinamentos vencidos</h2>
                <Estado carregando={treinamentos.isPending} erro={treinamentos.error} />
                {treinamentos.data ? (
                  <CobrancaTreinamentos
                    vencidos={treinamentos.data}
                    perfil={eu.perfilId}
                    euId={eu.id}
                    euNome={eu.nome}
                  />
                ) : null}
              </Superficie>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
