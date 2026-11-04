/**
 * Fotos do empréstimo (migration 50): entrega, devolução, divergência e conferência. Câmera traseira do tablet
 * (input capture="environment"), uma foto por vez, reduzida aqui no navegador (até 1600 px em JPEG, sem EXIF/GPS: o
 * canvas não leva metadados; até 1,2 MB) com a miniatura de até 360 px — a mesma redução do painel da V5
 * (web/src/almox/emprestimo.js). Cada foto vai num POST /fotos próprio (o corpo tem limite de 2 MB) e fica como
 * rascunho no servidor até o registro anexar. Câmera aberta = espera longa: a sessão é segurada até a foto voltar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Botao, Icone } from '../ui';
import { API, erroDe } from './api';
import { useTerminal } from './estado';
import { IconeTm } from './icones';
import { MAX_FOTOS, plural, texto } from './regras';
import { MensagemErro } from './teclado';
import type { EtapaFoto, FotoEnviada, FotoRegistro } from './tipos';

export interface FotoPreparada {
  imagem: string;
  miniatura: string;
  largura: number;
  altura: number;
}
export type Redutor = (arquivo: File) => Promise<FotoPreparada>;

/** Limite do servidor (server/src/lib/imagem.js): foto 1,2 MB e miniatura 80 KB, em bytes. */
export const LIMITE_FOTO = 1200000;
export const LIMITE_MINI = 80000;
/** Bytes de um data URL base64. */
export const bytesDataUrl = (u: string) => {
  const b64 = u.slice(u.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
};

/** O arquivo serve? '' = sim; senão, o motivo (antes de gastar tempo reduzindo). */
export function problemaArquivo(f: File | null | undefined): string {
  if (!f) return 'Tire uma foto.';
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type || '') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || ''))
    return 'Use uma foto JPG, PNG ou WEBP.';
  if (f.size > 25 * 1024 * 1024) return 'Arquivo grande demais (máximo de 25 MB antes de reduzir).';
  return '';
}

async function abrirImagem(f: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function')
    return createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(f));
  return new Promise((ok, falhou) => {
    const u = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(u);
      ok(im);
    };
    im.onerror = () => {
      URL.revokeObjectURL(u);
      falhou(new Error('não abriu'));
    };
    im.src = u;
  });
}

/** Reduz a foto no navegador: até 1600 px (cai para 1280 e 1024 se passar de 1,2 MB) e a miniatura de até 360 px. */
export async function reduzirFoto(f: File): Promise<FotoPreparada> {
  const motivo = problemaArquivo(f);
  if (motivo) throw new Error(motivo);
  let img: ImageBitmap | HTMLImageElement;
  try {
    img = await abrirImagem(f);
  } catch {
    throw new Error('Não foi possível ler a foto neste navegador. Tente de novo.');
  }
  const desenhar = (max: number, q: number) => {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    const g = c.getContext('2d');
    if (!g) throw new Error('Não foi possível preparar a foto neste navegador.');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return { url: c.toDataURL('image/jpeg', q), w: c.width, h: c.height };
  };
  try {
    let grande = desenhar(1600, 0.82);
    if (bytesDataUrl(grande.url) > LIMITE_FOTO) grande = desenhar(1280, 0.76);
    if (bytesDataUrl(grande.url) > LIMITE_FOTO) grande = desenhar(1024, 0.7);
    let mini = desenhar(360, 0.72);
    if (bytesDataUrl(mini.url) > LIMITE_MINI) mini = desenhar(260, 0.62);
    if (bytesDataUrl(grande.url) > LIMITE_FOTO || bytesDataUrl(mini.url) > LIMITE_MINI)
      throw new Error('Foto grande demais mesmo reduzida. Tire outra.');
    return { imagem: grande.url, miniatura: mini.url, largura: grande.w, altura: grande.h };
  } finally {
    if ('close' in img) img.close();
  }
}

let redutor: Redutor = reduzirFoto;
/** Só para testes (o jsdom não desenha em canvas): troca a redução; null volta à real. */
export function definirRedutor(r: Redutor | null): void {
  redutor = r ?? reduzirFoto;
}

/** Endereço da miniatura de uma foto já anexada (no demo, ela vem pronta na linha). */
export const urlMiniatura = (f: FotoRegistro) =>
  f.miniatura || `${API}/fotos/${encodeURIComponent(f.id)}?mini=1&v=${encodeURIComponent(texto(f.v))}`;

export function Fotos({
  etapa,
  fotos,
  aoAdicionar,
  aoRemover,
  max = MAX_FOTOS,
  rotulo,
  desligado,
}: {
  etapa: EtapaFoto;
  fotos: FotoEnviada[];
  aoAdicionar: (f: FotoEnviada) => void;
  aoRemover: (fotoId: string) => void;
  max?: number;
  rotulo: string;
  desligado?: boolean;
}) {
  const { chamar, segurarSessao } = useTerminal();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const campo = useRef<HTMLInputElement>(null);
  const soltar = useRef<(() => void) | null>(null);
  // envios ainda sem resposta: contam no teto (dois eventos seguidos não passam de max)
  const emVoo = useRef(0);
  const liberar = useCallback(() => {
    soltar.current?.();
    soltar.current = null;
  }, []);

  // câmera fechada sem foto ("cancel") ou a página voltou a ter foco: a espera longa acaba
  useEffect(() => {
    const el = campo.current;
    const aoVoltar = () => setTimeout(liberar, 1500);
    el?.addEventListener('cancel', liberar);
    window.addEventListener('focus', aoVoltar);
    return () => {
      el?.removeEventListener('cancel', liberar);
      window.removeEventListener('focus', aoVoltar);
      liberar();
    };
  }, [liberar]);

  function abrirCamera() {
    if (enviando || desligado || fotos.length >= max) return;
    setErro('');
    liberar();
    soltar.current = segurarSessao();
    campo.current?.click();
  }

  async function aoEscolher(arquivo: File | undefined) {
    liberar();
    if (!arquivo) return;
    if (desligado || fotos.length + emVoo.current >= max) return setErro(`Limite de ${plural(max, 'foto', 'fotos')}.`);
    emVoo.current += 1;
    setErro('');
    setEnviando(true);
    let prep: FotoPreparada;
    try {
      prep = await redutor(arquivo);
    } catch (e) {
      emVoo.current -= 1;
      setEnviando(false);
      return setErro(e instanceof Error && e.message ? e.message : 'Não foi possível preparar a foto.');
    }
    const r = await chamar('POST', '/fotos', { etapa, ...prep });
    emVoo.current -= 1;
    if (r.velho) return;
    setEnviando(emVoo.current > 0);
    const fotoId = texto(r.json.fotoId);
    if (!r.ok || !fotoId) return setErro(r.ok ? 'A foto não foi registrada. Tire de novo.' : erroDe(r));
    aoAdicionar({ fotoId, miniatura: prep.miniatura });
  }

  const cheio = fotos.length >= max;
  return (
    <div className="tm-fotos" role="group" aria-label={rotulo}>
      <input
        ref={campo}
        className="tm-fotos__campo"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        data-testid={`foto-${etapa}`}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          void aoEscolher(f);
        }}
      />
      {fotos.length > 0 && (
        <ul className="tm-fotos__lista">
          {fotos.map((f, i) => (
            <li key={f.fotoId} className="tm-fotos__item">
              <img src={f.miniatura} alt={`Foto ${i + 1}`} className="tm-fotos__mini" />
              <button
                type="button"
                className="tm-fotos__tirar"
                disabled={desligado || enviando}
                aria-label={`Remover foto ${i + 1}`}
                onClick={() => aoRemover(f.fotoId)}
              >
                <IconeTm nome="lixo" tamanho={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Botao
        className="tm-botao-grande tm-fotos__botao"
        disabled={desligado || enviando || cheio}
        aria-busy={enviando}
        onClick={abrirCamera}
      >
        {enviando ? (
          <>
            <span className="tm-giro" aria-hidden="true" /> Enviando a foto…
          </>
        ) : (
          <>
            <IconeTm nome="camera" tamanho={22} /> {fotos.length ? 'Tirar outra foto' : 'Tirar foto'}
          </>
        )}
      </Botao>
      <p className="tm-fotos__conta">
        {cheio ? (
          <>
            <Icone nome="check" tamanho={16} /> Limite de {plural(max, 'foto', 'fotos')}.
          </>
        ) : (
          `${plural(fotos.length, 'foto', 'fotos')} de até ${max}.`
        )}
      </p>
      <MensagemErro texto={erro} />
    </div>
  );
}

/** Miniaturas das fotos já anexadas (ex.: como as ferramentas saíram, na hora da devolução). */
export function FotosRegistradas({ fotos, rotulo }: { fotos: FotoRegistro[]; rotulo: string }) {
  if (!fotos.length) return null;
  return (
    <figure className="tm-fotos tm-fotos--registro">
      <figcaption className="tm-rotulo">{rotulo}</figcaption>
      <ul className="tm-fotos__lista">
        {fotos.map((f, i) => (
          <li key={f.id} className="tm-fotos__item">
            <img src={urlMiniatura(f)} alt={`${rotulo}: foto ${i + 1}`} className="tm-fotos__mini" loading="lazy" />
          </li>
        ))}
      </ul>
    </figure>
  );
}
