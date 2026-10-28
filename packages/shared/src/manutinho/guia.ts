/**
 * Manutinho · guia de uso do site (portado de V5/web/src/copilot/guia.js). Dado estático: só descreve o que o site
 * faz, nenhum dado de operação. k = palavras que ativam o item, t = título, txt = resposta curta. Mantenha em sincronia
 * com as telas.
 */
export interface ItemGuiaManutinho {
  k: string[];
  t: string;
  txt: string;
}

export const GUIA_MANUTINHO: readonly ItemGuiaManutinho[] = [
  {
    k: ['bateladas', 'batelada', 'contador', 'apontar bateladas', 'supervisório', 'supervisorio'],
    t: 'Apontar bateladas',
    txt: 'Menu PCM › Apontar bateladas. Uma vez por dia, o técnico de turno digita (ou usa − e +) o contador acumulado do supervisório de cada tanque e clica em Salvar.\n- O contador só aumenta: o técnico não consegue baixar o número que outra pessoa já apontou. Se estiver errado, o PCM corrige com uma justificativa.\n- Mais de 10 bateladas de uma vez é bloqueado (quase sempre erro de digitação) e o técnico aponta até 7 dias para trás.\n- A tela atualiza sozinha: se outra pessoa apontar, aparece "Fulano acabou de apontar".',
  },
  {
    k: ['limite', 'preventiva', 'diafragma', 'desde a preventiva', 'passou'],
    t: 'Limite de bateladas e preventiva',
    txt: 'Cada tanque conta as bateladas desde a última preventiva de diafragmas. O limite é 18 bateladas nos fermentadores e propagadores e 30 nos blenders. A tela Bateladas (PCM) mostra a situação: em dia, atenção, alerta e passou do limite. Concluir a folha de diafragmas em Preventivas zera a contagem sozinho.',
  },
  {
    k: ['bateladas painel', 'abas', 'planilha', 'controle de bateladas', 'calendário', 'calendario', 'eba'],
    t: 'Tela Bateladas (painel e abas)',
    txt: 'Menu PCM › Bateladas. O Painel mostra a situação de cada tanque. As abas trazem o que havia na planilha "Controle de bateladas": dados de coleta, diária, mensal, semanal, pós-preventiva, gás e diafragma, calendário, preventivas por semana, preventivas dos EBAs e status. Só PCM, gestão e administração alteram; a equipe consulta.',
  },
  {
    k: ['scm', 'compra', 'solicitação de compra', 'solicitacao de compra', 'comprar'],
    t: 'SCM · solicitação de compra',
    txt: 'Menu Almoxarifado › SCM › Nova solicitação de compra: para comprar um item que já está cadastrado. Preencha time, CAMM, urgência, centro de custo, nº da OM e os itens. O pedido vai para a aprovação do responsável do seu time; depois a gestão de SCM abre a RC. Acompanhe em "Minhas SCM". Se for devolvido para revisão, corrija e reenvie.',
  },
  {
    k: ['sci', 'cadastro de item', 'item novo', 'cadastrar item'],
    t: 'SCI · cadastro de item novo',
    txt: 'Menu Almoxarifado › SCI › Nova solicitação: para pedir o cadastro de um item que ainda não existe. O almoxarifado analisa e cadastra. Acompanhe em "Minhas SCI". Depois de cadastrado o item pode ser usado numa SCM.',
  },
  {
    k: ['aprovar', 'aprovação', 'aprovacao', 'aprovações'],
    t: 'Aprovar solicitações',
    txt: 'Menu Almoxarifado › SCM › Aprovações (ou o aviso do Manutinho). Quem é responsável por um time vê os pedidos da equipe, pode aprovar, reprovar ou pedir revisão. O Manutinho mostra o que está aguardando você.',
  },
  {
    k: ['estoque', 'itens do estoque', 'catálogo', 'catalogo', 'ficha'],
    t: 'Itens do estoque',
    txt: 'Menu Almoxarifado › Itens do estoque (almoxarife, gestão e administração): a ficha de cada item, com filtros e busca.',
  },
  {
    k: ['inventário', 'inventario', 'contagem', 'camm', 'dynamics'],
    t: 'Inventário',
    txt: 'O inventário saiu do menu do site: agora é um arquivo próprio, que funciona sem internet, em /ferramentas/inventario.html. O responsável importa a Lista disponível do Dynamics, divide em listas com três contadores e manda a cada um o pacote de contagem (cego); depois junta as contagens, justifica as divergências, alguém que não contou aprova, e sai o Excel e o PDF para assinatura. Os dados ficam no navegador de quem usa: guarde o backup .json.',
  },
  {
    k: [
      'utilidades',
      'consumo',
      'medidor',
      'medidores',
      'leitura',
      'água',
      'agua',
      'gás',
      'gas',
      'energia',
      'horímetro',
      'horimetro',
    ],
    t: 'Utilidades · leituras de consumo',
    txt: 'Menu Utilidades › Apontar consumo: registre a leitura do medidor (água, gás, energia, horímetro). O consumo é a leitura atual menos a anterior; a primeira leitura de um medidor não gera consumo. "Pendências" mostra medidores sem leitura; "Gestão de medidores" é do PCM e da administração.',
  },
  {
    k: ['treinamento', 'treinamentos', 'curso', 'cursos', 'certificado', 'prazo'],
    t: 'Treinamentos',
    txt: 'Menu Treinamentos › Meus cursos: veja o que falta, assista às aulas e faça a avaliação. Cursos obrigatórios têm prazo. Ao concluir, o certificado vai por e-mail. Quem é líder ou gestor acompanha a equipe em Treinamentos › Acompanhamento, e o responsável do grupo recebe cobrança automática toda semana dos cursos com prazo vencendo.',
  },
  {
    k: ['cobrar', 'cobrança', 'cobranca', 'atrasado', 'atrasados'],
    t: 'Cobrar treinamentos',
    txt: 'Líder, gestor e administrador podem cobrar a equipe pelo Manutinho, na aba Pendências: marque as pessoas com treinamento vencido e clique em "Enviar cobrança". O e-mail usa um modelo fixo com os cursos que faltam. Cada pessoa recebe no máximo uma cobrança por dia e você vai em cópia.',
  },
  {
    k: ['conta', 'perfil', 'foto', 'senha', '2fa', 'dois fatores', 'verificação'],
    t: 'Minha conta',
    txt: 'Clique no seu nome no topo › Meu perfil: foto, nome de exibição e telefone. Em Segurança e acesso fica a verificação em duas etapas. O site não guarda senha: o login é pela conta Microsoft.',
  },
  {
    k: ['tema', 'escuro', 'claro', 'modo escuro', 'acessibilidade', 'fonte', 'contraste'],
    t: 'Tema e acessibilidade',
    txt: 'Clique no seu nome no topo: o interruptor "Tema escuro" troca o tema. Em Aparência e acessibilidade você ajusta tamanho do texto, contraste e reduz animações.',
  },
  {
    k: ['menu', 'barra lateral', 'recolher', 'esconder'],
    t: 'Menu lateral',
    txt: 'O botão no canto esquerdo do topo (ou Ctrl+B) recolhe o menu para só ícones e expande de novo. No celular o mesmo botão abre o menu.',
  },
  {
    k: ['permissão', 'permissao', 'acesso', 'não consigo', 'nao consigo', 'não aparece', 'nao aparece'],
    t: 'Não vejo uma tela',
    txt: 'Cada perfil (técnico, líder, PCM, almoxarife, gestor, administrador) vê só as telas e dados que precisa; isso é decidido no banco, não só no menu. Se você precisa de uma tela que não aparece, peça ao seu gestor ou à administração para ajustar o perfil.',
  },
];

/** Minúsculas e sem acento (busca tolerante). */
function normalizar(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Os itens do guia mais parecidos com o texto (palavras-chave valem mais que o título); [] se nada combina. */
export function buscarGuia(texto: string, n = 2): ItemGuiaManutinho[] {
  const q = normalizar(texto);
  if (!q.trim()) return [];
  const pontos: { g: ItemGuiaManutinho; p: number }[] = [];
  for (const g of GUIA_MANUTINHO) {
    let p = 0;
    for (const k of g.k) {
      const nk = normalizar(k);
      if (q.includes(nk)) p += nk.length > 5 ? 3 : 2;
    }
    for (const w of normalizar(g.t).split(/\s+/)) if (w.length > 3 && q.includes(w)) p += 1;
    if (p) pontos.push({ g, p });
  }
  return pontos
    .sort((a, b) => b.p - a.p)
    .slice(0, n)
    .map((x) => x.g);
}
