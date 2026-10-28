// O app monta: sem sessão mostra o login Microsoft; com sessão (pessoa FICTÍCIA) mostra o menu do perfil e o Painel.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { definirTransporte } from '../lib/api/transport';
import { MODULOS, Router } from './router';
import { Providers, queryClient } from './providers';

function montar(resposta: { status: number; corpo: unknown }) {
  definirTransporte({ enviar: async () => resposta });
  return render(
    <Providers>
      <Router />
    </Providers>,
  );
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  definirTransporte(null);
});

describe('app', () => {
  it('registra os módulos achados em src/modules/*/module.ts', () => {
    expect(MODULOS.map((m) => m.id)).toContain('painel');
  });

  it('sem sessão (401): botão de entrar com a conta Microsoft', async () => {
    montar({ status: 401, corpo: { ok: false, erro: 'Sessão expirada.' } });
    const entrar = await screen.findByRole('link', { name: 'Entrar' });
    expect(entrar.getAttribute('href')).toBe('/auth/microsoft');
  });

  it('com sessão: menu do perfil e a página do Painel (lazy)', async () => {
    montar({
      status: 200,
      corpo: {
        ok: true,
        usuario: { id: 'u-teste', nome: '[TESTE] Pessoa Técnico', email: 't@teste.invalid', perfilId: 'tecnico' },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Painel' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Menu' }).textContent).toContain('Início');
    expect(screen.getByText('[TESTE] Pessoa Técnico')).toBeTruthy();
  });
});
