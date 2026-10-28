# Trajeto Seguro SP - prepara, testa, baixa os dados reais e publica no GitHub.
# Uso (na pasta do projeto):
#   powershell -ExecutionPolicy Bypass -File .\publicar.ps1
# Opções:
#   -PularDados      não baixa os dados da SSP-SP/iluminação
#   -SoDados         só atualiza os dados (sem git)
#   -Repo nome       nome do repositório no GitHub (padrão: trajeto-seguro-sp)

param(
  [switch]$PularDados,
  [switch]$SoDados,
  [string]$Repo = "trajeto-seguro-sp"
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Etapa($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Ok($texto) { Write-Host "    OK  $texto" -ForegroundColor Green }
function Aviso($texto) { Write-Host "    !!  $texto" -ForegroundColor Yellow }
function Falha($texto) { Write-Host "    XX  $texto" -ForegroundColor Red; exit 1 }
function Rodar($cmd, $descricao) {
  Write-Host "    > $cmd" -ForegroundColor DarkGray
  cmd /c $cmd
  if ($LASTEXITCODE -ne 0) { Falha "$descricao falhou (código $LASTEXITCODE)." }
  Ok $descricao
}
function Existe($nome) { [bool](Get-Command $nome -ErrorAction SilentlyContinue) }

# ------------------------------------------------------------------ 1. ambiente
Etapa "Verificando o ambiente"
if (-not (Existe "node")) { Falha "Node.js não encontrado. Instale a versão 20 ou mais nova (nodejs.org)." }
$nodeMajor = [int]((node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) { Falha "Node $(node -v) é antigo demais; instale a versão 20 ou mais nova." }
Ok "Node $(node -v)"

# ------------------------------------------------------------------ 2. dependências e testes
Etapa "Instalando dependências"
Rodar "npm install --no-audit --no-fund" "npm install"

if (-not $SoDados) {
  Etapa "Rodando os testes"
  Rodar "npm test" "Testes"
  Etapa "Checando tipos e gerando o build"
  Rodar "npm run build" "Build"
}

# ------------------------------------------------------------------ 3. dados reais
if (-not $PularDados) {
  Etapa "Baixando as planilhas da SSP-SP (pode levar vários minutos na primeira vez)"
  $env:NODE_OPTIONS = "--max-old-space-size=6144"
  Rodar "npm run data:update" "Dados criminais da SSP-SP"

  Etapa "Baixando a iluminação pública (GeoSampa / OpenStreetMap)"
  cmd /c "npm run data:lighting"
  if ($LASTEXITCODE -ne 0) { Aviso "Iluminação não atualizada; o mapa usa o arquivo anterior. Veja a saída acima." }
  else { Ok "Iluminação pública" }
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
}
if ($SoDados) { Write-Host "`nDados atualizados. Rode 'npm run dev' para ver." -ForegroundColor Green; exit 0 }

# ------------------------------------------------------------------ 4. git
Etapa "Preparando o repositório git"
if (-not (Existe "git")) { Falha "Git não encontrado. Instale em git-scm.com e rode o script de novo." }
if (-not (git config user.name)) {
  $nome = Read-Host "    Seu nome para os commits"
  git config --global user.name "$nome"
}
if (-not (git config user.email)) {
  $email = Read-Host "    Seu e-mail do GitHub"
  git config --global user.email "$email"
}
if (-not (Test-Path ".git")) {
  git init -b main | Out-Null
  Ok "Repositório criado"
}
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m "Trajeto Seguro SP: mapa 3D de criminalidade com rotas seguras" | Out-Null
  Ok "Commit feito"
} else { Ok "Nada novo para commitar" }

# ------------------------------------------------------------------ 5. GitHub
Etapa "Publicando no GitHub"
$temRemoto = (git remote) -contains "origin"
if (-not $temRemoto) {
  if (Existe "gh") {
    # Via cmd: no Windows PowerShell 5.1, redirecionar stderr de programas externos com "Stop" vira exceção.
    cmd /c "gh auth status >nul 2>nul"
    if ($LASTEXITCODE -ne 0) { Rodar "gh auth login" "Login no GitHub" }
    Rodar "gh repo create $Repo --public --source . --remote origin --push" "Repositório $Repo criado e enviado"
  } else {
    Aviso "GitHub CLI (gh) não instalado. Faça assim:"
    Write-Host "      1. Crie um repositório vazio chamado '$Repo' em https://github.com/new (sem README)"
    Write-Host "      2. Cole a URL do repositório abaixo (ex.: https://github.com/SEU_USUARIO/$Repo.git)"
    $url = Read-Host "    URL do repositório"
    if (-not $url) { Falha "Sem URL; rode o script de novo quando criar o repositório." }
    git remote add origin $url
    Rodar "git push -u origin main" "Código enviado ao GitHub"
  }
} else {
  Rodar "git push" "Alterações enviadas ao GitHub"
}

# ------------------------------------------------------------------ 6. próximos passos
$remoto = git remote get-url origin
$base = $remoto -replace "\.git$", ""
Write-Host "`nPronto! Falta só ativar o site (uma única vez):" -ForegroundColor Green
Write-Host "  1. $base/settings/pages  ->  Source: GitHub Actions"
Write-Host "  2. $base/settings/actions  ->  Workflow permissions: Read and write"
Write-Host "  3. Em alguns minutos o site estará em https://<seu-usuario>.github.io/$Repo/"
