// dist/cjs sai como CommonJS, mas o package.json do pacote diz "type": "module": este marcador faz o Node (o servidor,
// com require) ler a pasta como CommonJS.
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), JSON.stringify({ type: 'commonjs' }) + '\n');
