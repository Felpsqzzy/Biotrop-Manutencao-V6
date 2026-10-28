// Componentes e nomes do sistema visual. Módulos importam daqui (nunca de arquivos internos de src/ui).
export { Botao, type BotaoProps } from './Botao';
export { Superficie, type SuperficieProps } from './Superficie';
export { alternarTema, definirTema, temaAtual, type Tema } from './tema';

/** Duração e curva padrão das animações (só transform e opacity, de 150 a 250 ms). */
export const MOVIMENTO = { rapido: 0.15, medio: 0.2, lento: 0.25, curva: [0.22, 1, 0.36, 1] as const };

/** Classes globais do sistema (prefixo bm-). Classe de módulo usa o prefixo do próprio módulo. */
export const CLASSES = {
  vidro: 'bm-vidro',
  painel: 'bm-painel',
  botao: 'bm-botao',
  botaoAcao: 'bm-botao--acao',
} as const;
