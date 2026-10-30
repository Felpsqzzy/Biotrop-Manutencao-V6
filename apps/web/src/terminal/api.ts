/**
 * Chamadas a /api/terminal/* (mesma origem, cookie próprio do terminal). No build de demonstração (VITE_DEMO) as
 * chamadas vão para ./demo (import() só nesse build: no build normal o demo nem entra no pacote).
 * Sucesso é só 2xx com {ok:true}: 200 em HTML (página de reserva, portal cativo) não é "entrou" nem "registrado".
 */
export const API = '/api/terminal';
export const MODO_DEMO = import.meta.env.VITE_DEMO === '1';
export const SEM_REDE = 'Sem conexão com o servidor. Confira a rede e tente de novo.';
export const ERRO_PADRAO = 'Não foi possível concluir agora. Tente de novo.';
const ESPERA_MS = 20000;

export type Metodo = 'GET' | 'POST';
export type Json = Record<string, unknown>;
export interface Resposta {
  status: number;
  json: Json;
  ok: boolean;
  /** Resposta de uma sessão que já acabou (ou que encerrou a sessão): quem chamou ignora. */
  velho?: boolean;
}
export type Transporte = (metodo: Metodo, url: string, corpo?: unknown) => Promise<{ status: number; json: unknown }>;

const http: Transporte = async (metodo, url, corpo) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ESPERA_MS);
  try {
    const res = await fetch(url, {
      method: metodo,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: ctl.signal,
      headers:
        corpo === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const json: unknown = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
};

let atual: Promise<Transporte> | null = null;
function transporte(): Promise<Transporte> {
  if (!atual) atual = MODO_DEMO ? import('./demo').then((m) => m.demoTerminal.handle) : Promise.resolve(http);
  return atual;
}

/** Acessos fictícios do demo (tela inicial). Fora do build de demonstração: lista vazia, sem tocar no ./demo. */
export function credenciaisDemo(): Promise<import('./demo').CredencialDemo[]> {
  return MODO_DEMO ? import('./demo').then((m) => m.demoTerminal.credenciais()) : Promise.resolve([]);
}

/** Só para testes: troca o transporte (null volta ao padrão). */
export function definirTransporte(t: Transporte | null): void {
  atual = t ? Promise.resolve(t) : null;
}

export async function chamar(metodo: Metodo, caminho: string, corpo?: unknown): Promise<Resposta> {
  try {
    const enviar = await transporte();
    const r = await enviar(metodo, API + caminho, corpo);
    const json = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? (r.json as Json) : {};
    const status = Number(r.status) || 0;
    return { status, json, ok: status >= 200 && status < 300 && json.ok === true };
  } catch {
    return { status: 0, json: { ok: false, erro: SEM_REDE }, ok: false };
  }
}

export function erroDe(r: Resposta): string {
  return typeof r.json.erro === 'string' && r.json.erro ? r.json.erro : r.status === 0 ? SEM_REDE : ERRO_PADRAO;
}

/** Lista segura de um campo da resposta. */
export function lista<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
