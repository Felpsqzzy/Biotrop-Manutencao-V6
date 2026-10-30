/**
 * Atualização sem ninguém recarregar o tablet (ele fica dias aberto em modo quiosque). No build do Vite os arquivos
 * levam o hash no nome (/assets/terminal-XXXX.js): parada e limpa na tela inicial, a página relê o próprio HTML (sem
 * cache) e compara os /assets/ que ele carrega com os desta página. Mudou, recarrega — só com resposta 2xx que traz o
 * módulo do terminal (página de erro ou de manutenção não derruba o tablet) e uma vez por versão (history.state guarda
 * para qual já recarregou: se a diferença não sumir, não fica em laço). Em dev (/src/…) não há /assets/: não confere.
 */
const ESPERA_MS = 20000;
let conferindo = false;

/** /assets/ que esta página carregou (script e css), em ordem fixa. */
export function arquivosDaPagina(doc: Document = document): string {
  return [...doc.querySelectorAll('script[src^="/assets/"], link[href^="/assets/"]')]
    .map((el) => el.getAttribute('src') || el.getAttribute('href') || '')
    .sort()
    .join(' ');
}

/** Os mesmos arquivos no texto do HTML publicado (fora de comentário e de <noscript>). */
export function arquivosDoHtml(t: string): string {
  const s = String(t || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
  const out: string[] = [];
  for (const m of s.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="(\/assets\/[^"]+)"/g)) if (m[1]) out.push(m[1]);
  return out.sort().join(' ');
}

export async function conferirVersao(aindaParada: () => boolean): Promise<void> {
  const atuais = arquivosDaPagina();
  if (conferindo || !atuais) return;
  conferindo = true;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ESPERA_MS);
  try {
    const res = await fetch(location.pathname, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: ctl.signal,
      headers: { Accept: 'text/html' },
    });
    if (!res.ok) return;
    const nova = arquivosDoHtml(await res.text());
    let jaFoi = '';
    try {
      jaFoi = (history.state as { versao?: string } | null)?.versao ?? '';
    } catch {
      /* sem history */
    }
    if (!/\/assets\/terminal-[^ ]+\.js/.test(nova) || nova === atuais || nova === jaFoi || !aindaParada()) return;
    try {
      history.replaceState({ terminal: 1, versao: nova }, '', location.href);
    } catch {
      /* ok */
    }
    location.reload();
  } catch {
    /* rede: tenta na próxima */
  } finally {
    clearTimeout(t);
    conferindo = false;
  }
}
