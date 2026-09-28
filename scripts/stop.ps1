$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$runtimePath = Join-Path $projectRoot 'data\runtime.json'

function Get-OwnedNode([int]$processId) {
    if ($processId -le 0) { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction SilentlyContinue
    if (-not $candidate -or $candidate.Name -ine 'node.exe' -or -not $candidate.CommandLine) { return $null }
    $command = ([Uri]::UnescapeDataString([string]$candidate.CommandLine)).Replace('/', '\')
    $serverEntry = Join-Path $projectRoot 'src\server\index.ts'
    $tsxDirectory = Join-Path $projectRoot 'node_modules\tsx\'
    if ($command.IndexOf($serverEntry, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    $hasProjectLoader = $command.IndexOf($tsxDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $hasTsxImport = $command -match '(?i)(?:^|\s)--import\s+"?tsx"?(?:\s|$)'
    if (-not $hasProjectLoader -and -not $hasTsxImport) { return $null }
    return $candidate
}

try {
    $runtime = $null
    if (Test-Path -LiteralPath $runtimePath) {
        try { $runtime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json } catch { $runtime = $null }
    }
    $server = $null
    if ($runtime -and $runtime.root -and [IO.Path]::GetFullPath([string]$runtime.root).TrimEnd('\') -ieq $projectRoot) {
        $server = Get-OwnedNode ([int]$runtime.pid)
    }

    # Recover a stale/missing PID file only after verifying the running application's identity.
    if (-not $server) {
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4317/api/health' -UseBasicParsing -TimeoutSec 2
            $health = $response.Content | ConvertFrom-Json
            if ($health.ok -and $health.app -eq 'nihongo-small-steps' -and $health.root -and
                [IO.Path]::GetFullPath([string]$health.root).TrimEnd('\') -ieq $projectRoot) {
                $server = Get-OwnedNode ([int]$health.pid)
            }
        } catch { }
    }

    if (-not $server) {
        Write-Host '没有找到本目录启动的学习服务。其他程序保持运行。' -ForegroundColor Yellow
        exit 0
    }
    # tsx has a launcher parent. Stop only a parent proven to have the same project command line.
    $launcher = Get-OwnedNode ([int]$server.ParentProcessId)
    Stop-Process -Id ([int]$server.ProcessId) -ErrorAction Stop
    if ($launcher) { Stop-Process -Id ([int]$launcher.ProcessId) -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $runtimePath) {
        $current = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
        if ([int]$current.pid -eq [int]$server.ProcessId -and [IO.Path]::GetFullPath([string]$current.root).TrimEnd('\') -ieq $projectRoot) {
            Remove-Item -LiteralPath $runtimePath -Force
        }
    }
    Write-Host '学习服务已停止。学习记录已保存在本机。' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ('停止失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
