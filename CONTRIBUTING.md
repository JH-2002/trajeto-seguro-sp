# Como contribuir

Obrigado pelo interesse no **Trajeto Seguro SP**! Contribuições de todos os níveis são bem-vindas: correções de bugs, novas funcionalidades, melhorias de desempenho, documentação, testes e revisão de metodologia.

> *English speakers are welcome too: issues and pull requests in English are fine.*

## Antes de começar

- Para mudanças pequenas (erro de digitação, ajuste visual, bug óbvio), pode abrir o pull request direto.
- Para mudanças maiores (nova funcionalidade, nova fonte de dados, alteração no cálculo de risco), **abra uma issue primeiro** para combinarmos a abordagem. Assim ninguém perde tempo com algo que não vai entrar.
- Procure as issues marcadas como **`good first issue`** se for sua primeira contribuição.

## Preparando o ambiente

Requer **Node.js 20+**.

```bash
git clone https://github.com/<seu-usuario>/trajeto-seguro-sp.git   # o seu fork
cd trajeto-seguro-sp
npm install
npm run dev     # http://localhost:5173
npm test        # testes automatizados
```

O repositório já traz dados reais processados em `public/data/`, então o mapa funciona sem baixar nada. Se preferir dados leves para desenvolver, `npm run data:demo` gera dados **sintéticos** (uma faixa amarela no app avisa quando estão em uso; não faça commit deles por cima dos reais).

Para reprocessar os dados oficiais: `npm run data:update` (baixa ~500 MB de planilhas da SSP-SP).

## Fluxo de trabalho

1. Faça um **fork** do repositório e crie uma branch a partir da `main`:
   `git checkout -b fix/descricao-curta` ou `feat/descricao-curta`
2. Faça as mudanças em commits pequenos e com mensagens claras (ex.: `fix: corrige quebra de linha nos cards de rota`).
3. Antes de enviar, confira:
   ```bash
   npm test          # todos os testes passando
   npm run build     # checagem de tipos + build
   ```
4. Abra o **pull request** para a `main` descrevendo o que mudou e por quê. Prints ou GIFs ajudam muito em mudanças visuais.

O CI roda testes e build automaticamente em cada pull request.

## Padrões do projeto

- **TypeScript estrito**, sem `any` desnecessário.
- **Sem frameworks de UI**: o front-end é TypeScript + CSS puro. Mantenha assim, salvo discussão prévia.
- **Textos da interface em português**, com linguagem clara e sem jargão.
- **Lógica nova vem com teste** em `tests/` (usamos o `node:test`).
- **Funções puras sempre que possível**: o cálculo de risco e o processamento de dados devem ser testáveis sem navegador.
- Parâmetros ajustáveis (pesos, raios, limites) ficam em `src/config.ts`, não espalhados pelo código.
- Novos serviços externos precisam ser **gratuitos, sem chave de API** e configuráveis por variável de ambiente.

## Cuidados com os dados

Este projeto lida com um tema sensível. Ao propor mudanças:

- **Não adicione dados que identifiquem pessoas** (vítimas, autores, endereços exatos de residências). O projeto trabalha apenas com dados agregados em células de ~110 m.
- Mudanças no **cálculo de risco** devem explicar a motivação e, se possível, mostrar o efeito em rotas reais.
- Textos e visualizações devem deixar claro que o índice reflete **registros de ocorrência**, com subnotificação e vieses, e não estigmatizar bairros ou comunidades.
- Respeite as licenças das fontes (veja `LICENSE` e a seção "Fontes de dados" do README).

## Arquitetura em 1 minuto

| Pasta | O que tem |
|---|---|
| `scripts/` | Coleta (scraper da SSP-SP, iluminação) e processamento das planilhas em JSON agregado |
| `src/data/` | Carga dos JSON, filtros por categoria/hora/recência, inspetor de área |
| `src/risk/` | Índice espacial, densidade por kernel, pontuação de rotas, trechos evitados |
| `src/routing/` | Interface de roteamento (OSRM) e geração de desvios |
| `src/map/` | Renderização (MapLibre + deck.gl) |
| `src/ui/` | Componentes do painel |
| `tests/` | Testes automatizados |

Detalhes do algoritmo na seção "Como funciona" do [README](README.md).

## Ideias para contribuir

- **Acessibilidade**: navegação completa por teclado no mapa e leitor de tela no inspetor.
- **Dia da semana**: filtrar o calor e a rota por dia útil × fim de semana.
- **Outras cidades do estado**: o pipeline já lê o estado inteiro; falta parametrizar recorte e visualização.
- **Transporte público**: considerar trechos a pé até estações de metrô/trem.
- **Comparação de períodos**: ver o mapa de dois anos lado a lado.
- **Internacionalização**: versão da interface em inglês.
- **Testes de interface** com Playwright.

## Reportando problemas

Use as issues do GitHub. Para bugs, inclua: o que você fez, o que esperava, o que aconteceu, navegador/sistema e, se possível, o link da rota (o botão "Copiar link desta rota" ajuda a reproduzir).

**Vulnerabilidades de segurança** não devem ser reportadas em issues públicas: veja [SECURITY.md](SECURITY.md).

## Código de conduta

Ao participar, você concorda em seguir o nosso [Código de Conduta](CODE_OF_CONDUCT.md).
