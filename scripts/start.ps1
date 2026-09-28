param([switch]$NoBrowser, [switch]$SkipSpeechSetup)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$dataDirectory = Join-Path $projectRoot 'data'
$runtimePath = Join-Path $dataDirectory 'runtime.json'
$appUrl = 'http://127.0.0.1:4317'
$appName = 'nihongo-small-steps'
$launchMutex = $null
$ownsLaunchMutex = $false

function Get-AppHealth {
    try {
        $reply = Invoke-WebRequest -Uri ($appUrl + '/api/health') -UseBasicParsing -TimeoutSec 2
        return ($reply.Content | ConvertFrom-Json)
    } catch { return $null }
}

function Test-SameApplication($health) {
    if (-not $health -or -not $health.ok -or $health.app -ne $appName) { return $false }
    if ($health.root) {
        try { return [IO.Path]::GetFullPath([string]$health.root).TrimEnd('\') -ieq $projectRoot } catch { return $false }
    }
    # Compatibility with a health response that only contains an application marker.
    if (Test-Path -LiteralPath $runtimePath) {
        try {
            $state = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
            if ([IO.Path]::GetFullPath([string]$state.root).TrimEnd('\') -ine $projectRoot -or [int]$state.port -ne 4317) { return $false }
            $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$state.pid)
            if (-not $process -or $process.Name -ine 'node.exe') { return $false }
            $command = ([Uri]::UnescapeDataString([string]$process.CommandLine)).Replace('/', '\')
            return $command.Contains((Join-Path $projectRoot 'src\server\index.ts'))
        } catch { return $false }
    }
    return $false
}

function Test-PortInUse {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connection = $client.ConnectAsync('127.0.0.1', 4317)
        if ($connection.Wait(500)) { return $client.Connected }
        return $false
    } catch { return $false } finally { $client.Dispose() }
}

function Open-AppBrowser {
    if ($NoBrowser) { return }
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    )
    $edge = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    # A visible browser is the requested user interface; only helper processes are hidden.
    if ($edge) { Start-Process -FilePath $edge -ArgumentList $appUrl }
    else { Start-Process -FilePath $appUrl }
}

function Start-SpeechSetup($nodePath) {
    if ($SkipSpeechSetup) { return }
    $manifest = Join-Path $dataDirectory 'speech\install.json'
    $model = Join-Path $dataDirectory 'speech\ggml-small.bin'
    if ((Test-Path -LiteralPath $manifest) -and (Test-Path -LiteralPath $model)) { return }
    $setupPath = Join-Path $projectRoot 'scripts\setup-speech.mjs'
    if (-not (Test-Path -LiteralPath $setupPath)) { return }
    $existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($setupPath) }
    if ($existing) { return }
    Write-Host '正在后台准备本机语音。下载期间可以先用文字学习。' -ForegroundColor Cyan
    Start-Process -FilePath $nodePath -ArgumentList ('--use-env-proxy "' + $setupPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dataDirectory 'speech-install.log') `
        -RedirectStandardError (Join-Path $dataDirectory 'speech-install-error.log') | Out-Null
}

try {
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try { $rootHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $hashAlgorithm.Dispose() }
    $launchMutex = [Threading.Mutex]::new($false, ('Local\NihongoSmallSteps-' + $rootHash))
    try { $ownsLaunchMutex = $launchMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsLaunchMutex = $true }
    if (-not $ownsLaunchMutex) {
        Write-Host '应用正在启动中，请等待第一个启动窗口完成。' -ForegroundColor Yellow
        exit 0
    }
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    Set-Location -LiteralPath $projectRoot
    $health = Get-AppHealth
    if (Test-SameApplication $health) {
        Write-Host '应用已经运行，正在打开学习页面。' -ForegroundColor Green
        Open-AppBrowser
        exit 0
    }
    if (Test-PortInUse) { throw '4317 端口正在被其他程序使用。请先关闭占用程序，再重新启动；不会结束其他程序。' }

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not $npmCommand) { throw '请安装 Node.js 24 LTS，然后重新双击启动。下载地址：https://nodejs.org/' }
    $nodePath = $nodeCommand.Source
    $nodeVersion = (& $nodePath --version).Trim()
    if ([version]($nodeVersion.TrimStart('v')) -lt [version]'24.5.0') { throw ('当前 Node.js 版本为 ' + $nodeVersion + '，请升级到 Node.js 24.5 或更高版本。') }

    $tsxPath = Join-Path $projectRoot 'node_modules\tsx\dist\cli.mjs'
    $databasePackage = Join-Path $projectRoot 'node_modules\better-sqlite3\package.json'
    $packageFiles = @((Join-Path $projectRoot 'package.json'), (Join-Path $projectRoot 'package-lock.json')) | Where-Object { Test-Path -LiteralPath $_ }
    $dependencyHash = ($packageFiles | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join ':'
    $dependencyStamp = Join-Path $dataDirectory 'dependencies.sha256'
    $installedHash = if (Test-Path -LiteralPath $dependencyStamp) { [IO.File]::ReadAllText($dependencyStamp).Trim() } else { '' }
    if (-not (Test-Path -LiteralPath $tsxPath) -or -not (Test-Path -LiteralPath $databasePackage) -or $installedHash -ne $dependencyHash) {
        Write-Host '正在检查和安装应用依赖，首次启动需要联网。' -ForegroundColor Cyan
        & $npmCommand.Source install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。请检查网络后重新启动，详细错误见上方。' }
        $packageFiles = @((Join-Path $projectRoot 'package.json'), (Join-Path $projectRoot 'package-lock.json')) | Where-Object { Test-Path -LiteralPath $_ }
        $dependencyHash = ($packageFiles | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join ':'
        [IO.File]::WriteAllText($dependencyStamp, $dependencyHash)
    }

    & $nodePath -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();"
    if ($LASTEXITCODE -ne 0) {
        Write-Host '正在为当前 Node.js 版本重建本地数据库依赖。' -ForegroundColor Cyan
        & $npmCommand.Source rebuild better-sqlite3
        if ($LASTEXITCODE -ne 0) { throw '本地数据库组件不可用。请查看上方安装错误后重试。' }
    }

    $builtPage = Join-Path $projectRoot 'dist\index.html'
    $needsBuild = -not (Test-Path -LiteralPath $builtPage)
    if (-not $needsBuild) {
        $builtAt = (Get-Item -LiteralPath $builtPage).LastWriteTimeUtc
        $sources = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -File -Recurse)
        $publicDirectory = Join-Path $projectRoot 'public'
        if (Test-Path -LiteralPath $publicDirectory) { $sources += Get-ChildItem -LiteralPath $publicDirectory -File -Recurse }
        foreach ($name in @('index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json')) {
            $candidate = Join-Path $projectRoot $name
            if (Test-Path -LiteralPath $candidate) { $sources += Get-Item -LiteralPath $candidate }
        }
        $needsBuild = [bool]($sources | Where-Object { $_.LastWriteTimeUtc -gt $builtAt } | Select-Object -First 1)
    }
    if ($needsBuild) {
        Write-Host '正在准备学习页面。' -ForegroundColor Cyan
        & $npmCommand.Source run build
        if ($LASTEXITCODE -ne 0) { throw '页面构建失败。请查看上方错误，或联系维护者。' }
    }

    # Recheck after installation/build in case another launch completed meanwhile.
    $health = Get-AppHealth
    if (Test-SameApplication $health) { Open-AppBrowser; exit 0 }
    if (Test-PortInUse) { throw '启动期间 4317 端口被其他程序占用，请重试。' }

    Write-Host '正在启动日语学习应用。' -ForegroundColor Cyan
    $serverEntry = Join-Path $projectRoot 'src\server\index.ts'
    $env:PORT = '4317'
    $env:DATA_DIR = $dataDirectory
    $serverProcess = Start-Process -FilePath $nodePath -ArgumentList ('--use-env-proxy --import tsx "' + $serverEntry + '"') `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $dataDirectory 'server.log') `
        -RedirectStandardError (Join-Path $dataDirectory 'server-error.log')
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        $health = Get-AppHealth
        if (Test-SameApplication $health) { $ready = $true; break }
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        $serverProcess.Refresh()
        if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue }
        throw '服务未能启动。请查看 data\server-error.log，然后重新启动。'
    }
    try { Start-SpeechSetup $nodePath }
    catch { Write-Host '本机语音暂未安装，可以先用文字学习，再双击「安装本机语音.cmd」。' -ForegroundColor Yellow }
    Write-Host ('已启动：' + $appUrl) -ForegroundColor Green
    Open-AppBrowser
    exit 0
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($ownsLaunchMutex -and $launchMutex) { $launchMutex.ReleaseMutex() }
    if ($launchMutex) { $launchMutex.Dispose() }
}
