-- Cobranças automáticas de treinamentos vencidos ou próximos do prazo.
-- Idempotente: no máximo uma cobrança por matrícula a cada 7 dias.

CREATE OR REPLACE FUNCTION lms.escape_html(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT replace(replace(replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

CREATE OR REPLACE FUNCTION lms.enfileirar_cobrancas_treinamento(p_agora timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = lms, core, pg_temp AS $$
DECLARE
  v_total integer;
BEGIN
  INSERT INTO core.email_fila
    (destinatario, copia, assunto, corpo_html, referencia_tabela, referencia_id, motivo)
  SELECT
    gestor.email,
    ARRAY[aluno.email]::citext[],
    CASE WHEN m.prazo_em < p_agora THEN '[Ação necessária] Treinamento atrasado'
         ELSE '[Lembrete] Prazo de treinamento próximo' END,
    '<div style="font-family:Arial,sans-serif;color:#173431;max-width:640px">' ||
    '<h2 style="color:#087b66">Treinamento da equipe</h2><p><b>' || lms.escape_html(aluno.nome) ||
    '</b> precisa concluir <b>' || lms.escape_html(t.titulo) || '</b>.</p><p>Prazo: <b>' ||
    to_char(m.prazo_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') ||
    '</b></p><p style="color:#55706d">Acesse a plataforma BIOTROP para acompanhar a conformidade da equipe.</p></div>',
    'lms.matricula', m.id::text, 'lms_cobranca_gestor'
  FROM lms.matricula m
  JOIN lms.treinamento t ON t.id = m.treinamento_id AND t.ativo
  JOIN core.usuario aluno ON aluno.id = m.usuario_id AND aluno.ativo AND NOT aluno.bloqueado
  JOIN core.grupo g ON g.id = aluno.grupo_id AND g.ativo
  JOIN core.usuario gestor ON gestor.id = g.responsavel_id AND gestor.ativo AND NOT gestor.bloqueado
  WHERE m.obrigatoria
    AND m.status IN ('nao_iniciada', 'em_andamento', 'aguardando_avaliacao')
    AND m.prazo_em IS NOT NULL
    AND m.prazo_em <= p_agora + interval '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM core.email_fila f
      WHERE f.motivo = 'lms_cobranca_gestor'
        AND f.referencia_tabela = 'lms.matricula'
        AND f.referencia_id = m.id::text
        AND f.criado_em >= p_agora - interval '7 days'
        AND f.status <> 'cancelado'
    );
  GET DIAGNOSTICS v_total = ROW_COUNT;
  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION lms.enfileirar_cobrancas_treinamento(timestamptz) IS
  'Enfileira cobrança semanal ao gestor, com cópia ao colaborador, para treinamento obrigatório vencido ou a vencer em 7 dias.';

REVOKE ALL ON FUNCTION lms.enfileirar_cobrancas_treinamento(timestamptz) FROM PUBLIC;
