/* BIOMANUT V6 · tema antes da primeira pintura (carregado no <head>, sem defer). Arquivo próprio porque a CSP
   (script-src 'self') recusa <script> inline. Escolha guardada em localStorage "bm.tema" ("claro" | "escuro");
   sem escolha, segue o sistema. O React lê e troca o mesmo atributo (src/ui/tema.ts). */
(function () {
  var tema = null;
  try { tema = localStorage.getItem('bm.tema'); } catch (e) { /* aba privada */ }
  if (tema !== 'claro' && tema !== 'escuro') {
    tema = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
  }
  document.documentElement.setAttribute('data-theme', tema === 'escuro' ? 'dark' : 'light');
})();
