# Windows PowerShell 5.1. No inline PowerShell in the BAT and no pipelines here.
# .env is data: it is never executed, expanded, uploaded, or printed.
[CmdletBinding()]
param(
    [string]$RepoPath = 'C:\Users\12804\Downloads\leanbridge-ai-hackathon-nebius-nvidia-2026',
    [switch]$PauseInLauncher
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Read-LocalEnv([string]$Path) {
    $values = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
    $lineNumber = 0
    foreach ($rawLine in [IO.File]::ReadAllLines($Path)) {
        $lineNumber++
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).TrimStart() }
        $equals = $line.IndexOf('=')
        if ($equals -lt 1) { throw "Invalid .env assignment on line $lineNumber. Use one KEY=value per line." }
        $name = $line.Substring(0, $equals).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid .env name on line $lineNumber." }
        $value = $line.Substring($equals + 1).Trim()
        if ($value.Length -gt 0 -and ($value[0] -eq [char]34 -or $value[0] -eq [char]39)) {
            $quote = $value[0]
            $closing = $value.IndexOf($quote, 1)
            if ($closing -lt 1) { throw "Unclosed .env quote on line $lineNumber. Multiline values are not supported." }
            $suffix = $value.Substring($closing + 1).Trim()
            if ($suffix.Length -gt 0 -and -not $suffix.StartsWith('#')) { throw "Invalid text after .env quote on line $lineNumber." }
            $value = $value.Substring(1, $closing - 1)
        } else {
            $comment = $value.IndexOf('#')
            if ($comment -ge 0) { $value = $value.Substring(0, $comment).TrimEnd() }
        }
        if ($value.IndexOf([char]0) -ge 0) { throw "Invalid .env value on line $lineNumber." }
        $values[$name] = $value
    }
    return ,$values
}

function New-BackendToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Write-DockerEnv($Values, [string]$Path, [string]$Token) {
    # Only known application settings are copied; host paths cannot override Docker's Lean tools.
    $settings = [ordered]@{
        MODEL_PROVIDER = 'nebius'
        NEBIUS_API_KEY = ''
        NEBIUS_MODEL = 'nvidia/nemotron-3-super-120b-a12b'
        NEBIUS_BASE_URL = 'https://api.tokenfactory.us-central1.nebius.com/v1/'
        OPENAI_API_KEY = ''
        OPENAI_MODEL = 'gpt-5.6'
        OPENAI_REASONING_EFFORT = 'high'
        TAVILY_API_KEY = ''
        LEANBRIDGE_ACCESS_PASSWORD = ''
        MAX_REPAIR_ATTEMPTS = '3'
    }
    foreach ($name in @($settings.Keys)) {
        if ($Values.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace($Values[$name])) {
            $settings[$name] = $Values[$name]
        }
    }
    $provider = $settings['MODEL_PROVIDER'].Trim().ToLowerInvariant()
    if ($provider -ne 'nebius' -and $provider -ne 'openai') { throw 'MODEL_PROVIDER must be nebius or openai in .env.' }
    $settings['MODEL_PROVIDER'] = $provider
    $requiredKey = 'NEBIUS_API_KEY'
    if ($provider -eq 'openai') { $requiredKey = 'OPENAI_API_KEY' }
    if ([string]::IsNullOrWhiteSpace($settings[$requiredKey])) { throw "Set $requiredKey in the local .env file first." }
    $settings['TAVILY_GROUNDING_ENABLED'] = 'false'
    $settings['LEANBRIDGE_BACKEND_TOKEN'] = $Token
    $settings['CLOUD_MODE'] = 'true'
    $settings['DEMO_MODE'] = 'false'
    $settings['NODE_ENV'] = 'production'
    $settings['LEAN_PROJECT_PATH'] = '/app/lean-project'
    $settings['LEAN_COMMAND'] = '/opt/elan/bin/lean'
    $settings['LAKE_COMMAND'] = '/usr/local/bin/leanbridge-lake-env'
    $settings['LEAN_TIMEOUT_MS'] = '60000'
    $settings['PORT'] = '4310'
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.Add('# Generated locally by LeanBridge preflight V2. Contains secrets. Do not share.')
    foreach ($name in $settings.Keys) {
        # docker --env-file reads literal values; do not add shell quotes or expand dollars.
        $value = [string]$settings[$name]
        if ($value.Contains("`r") -or $value.Contains("`n") -or $value.IndexOf([char]0) -ge 0) {
            throw 'An environment setting contains an unsupported control character.'
        }
        $lines.Add($name + '=' + $value)
    }
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllLines($temporary, $lines.ToArray(), (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Invoke-Docker([string[]]$Arguments, [int]$TimeoutSeconds = 60, [switch]$ShowProgress) {
    # Capture both streams privately; only fixed diagnostic labels may be displayed.
    $quoted = New-Object 'System.Collections.Generic.List[string]'
    foreach ($argument in $Arguments) {
        $escaped = [regex]::Replace($argument, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        $quoted.Add('"' + $escaped + '"')
    }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $script:DockerExecutable
    $start.Arguments = [string]::Join(' ', $quoted.ToArray())
    $start.WorkingDirectory = $script:WorkingRepo
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $timedOut = $false
        $nextNotice = 20
        while (-not $process.WaitForExit(500)) {
            if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                $process.Kill()
                $null = $process.WaitForExit(5000)
                $timedOut = $true
                break
            }
            if ($ShowProgress -and $watch.Elapsed.TotalSeconds -ge $nextNotice) {
                Write-Host ('  Building image... {0} seconds elapsed.' -f [int]$watch.Elapsed.TotalSeconds)
                $nextNotice += 20
            }
        }
        if ($timedOut) {
            return [pscustomobject]@{ ExitCode = -1; Output = ''; StandardError = ''; ElapsedSeconds = [int]$watch.Elapsed.TotalSeconds; TimedOut = $true }
        }
        $output = $stdout.GetAwaiter().GetResult()
        $errorOutput = $stderr.GetAwaiter().GetResult()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output.Trim(); StandardError = $errorOutput; ElapsedSeconds = [int]$watch.Elapsed.TotalSeconds; TimedOut = $false }
    } finally {
        $process.Dispose()
    }
}

# Windows PowerShell 5.1. Raw build output is inspected privately and never returned.
# Every textual output below is a fixed allowlist value; no redaction is required.
function Get-BuildFailureDiagnostic {
    param(
        [int]$ExitCode,
        [string]$StandardOutput = '',
        [string]$StandardError = '',
        [switch]$TimedOut
    )
    if ($ExitCode -eq 0 -and -not $TimedOut) {
        return [pscustomobject]@{ ExitCode=0; StepExitCode=$null; Stage='unknown'; Category='none'; Summary='Docker image build succeeded.'; NextStep='Continue the preflight checks.' }
    }

    $stage = 'unknown'
    $stepExitCode = $null
    $raw = $StandardOutput + "`n" + $StandardError
    $lines = [regex]::Split($raw, '\r?\n')
    $stages = @{}
    $failedVertex = ''
    $errorLine = ''
    foreach ($line in $lines) {
        $header = [regex]::Match($line, '^#(?<vertex>[0-9]+)\s+\[(?<stage>application-build|lean-environment|runtime|internal)(?:\s|\])')
        if ($header.Success) { $stages[$header.Groups['vertex'].Value] = $header.Groups['stage'].Value }
        $failure = [regex]::Match($line, '^#(?<vertex>[0-9]+)\s+ERROR:')
        if ($failure.Success -and $failedVertex.Length -eq 0) {
            $failedVertex = $failure.Groups['vertex'].Value
            $errorLine = $line
        }
    }
    $evidence = $raw
    if ($failedVertex.Length -gt 0) {
        if ($stages.ContainsKey($failedVertex)) { $stage = $stages[$failedVertex] }
        $focused = New-Object 'System.Collections.Generic.List[string]'
        foreach ($line in $lines) {
            if ([regex]::IsMatch($line, '^#' + $failedVertex + '(?:\s|$)')) { $focused.Add($line) }
        }
        $evidence = [string]::Join("`n", $focused.ToArray())
    } else { $errorLine = $raw }
    $exitMatch = [regex]::Match($errorLine, '\bexit code:\s*(?<code>[0-9]+)\b')
    $parsedCode = 0
    if ($exitMatch.Success -and [int]::TryParse($exitMatch.Groups['code'].Value, [ref]$parsedCode)) { $stepExitCode = $parsedCode }

    # Earlier attempts can fail differently; diagnose only the final outer attempt.
    $retryMarkers = [regex]::Matches($evidence, '(?m)^#[0-9]+\s+[0-9]+(?:\.[0-9]+)?\s+Retrying Lean dependency/cache download[^\r\n]*\r?\n')
    if ($retryMarkers.Count -gt 0) {
        $lastRetry = $retryMarkers[$retryMarkers.Count - 1]
        $evidence = $evidence.Substring($lastRetry.Index + $lastRetry.Length)
    }

    $category = 'unknown'
    if ($TimedOut) { $category = 'build-timeout' }
    elseif ($evidence -match 'no space left on device|\bENOSPC\b') { $category = 'disk-space' }
    elseif ($evidence -match '\.lean:[0-9]+:[0-9]+:\s*error:') { $category = 'lean' }
    elseif ($evidence -match 'could not resolve host|temporary failure (in name resolution|resolving)|name or service not known|\bEAI_AGAIN\b|\bENOTFOUND\b|no such host') { $category = 'network-dns' }
    elseif ($evidence -match 'SSL certificate problem|certificate verify failed|x509: certificate|server certificate verification failed') { $category = 'network-certificate' }
    elseif ($evidence -match 'SSL_ERROR_SYSCALL|SSL_connect|TLS connect error|curl:\s*\(35\)') { $category = 'network-tls' }
    elseif ($evidence -match 'connection timed out|operation timed out|i/o timeout|\bETIMEDOUT\b|context deadline exceeded|TLS handshake timeout') { $category = 'network-timeout' }
    elseif ($evidence -match 'RPC failed|unexpected EOF|early EOF|connection reset|\bECONNRESET\b|HTTP/2 stream|GnuTLS recv error') { $category = 'network-interrupted' }
    elseif ($evidence -match 'pull access denied|insufficient_scope|unauthorized: authentication required') { $category = 'registry-access' }
    elseif ($evidence -match 'toomanyrequests|rate limit exceeded') { $category = 'rate-limit' }
    elseif ($evidence -match 'out of memory|cannot allocate memory') { $category = 'memory' }
    elseif ($stepExitCode -eq 137 -or $ExitCode -eq 137) { $category = 'process-killed' }
    elseif ($evidence -match '\berror TS[0-9]+\b') { $category = 'application-compile' }
    elseif ($evidence -match '\bnpm (ERR!|error)(?:\s|$)') { $category = 'npm' }
    elseif ($evidence -match '\.lean:[0-9]+:[0-9]+:\s*error:|unknown module prefix|invalid import') { $category = 'lean' }
    elseif ($evidence -match '\bgit\b[^\r\n]*(?:code|status)\s*:?\s*128\b') { $category = 'dependency-checkout' }

    $summary = 'The Docker build failed; the cause is unknown from the recognized diagnostics.'
    $nextStep = 'Inspect the failed build step in Docker Desktop. Keep raw logs private because they may contain credentials.'
    switch ($category) {
        'build-timeout' {
            $summary = 'The preflight build time limit was reached.'
            $nextStep = 'Check whether Docker Desktop is still building, and inspect the active step before retrying.'
        }
        'disk-space' {
            $summary = 'A build step reported insufficient disk space.'
            $nextStep = 'Check free space in Docker Desktop and on its data drive, then retry after making space available.'
        }
        'network-dns' {
            $summary = 'A build download could not resolve a remote hostname.'
            $nextStep = 'Check Docker Desktop DNS and proxy settings, then retry the build.'
        }
        'network-certificate' {
            $summary = 'A build download failed certificate verification.'
            $nextStep = 'Check Docker Desktop proxy certificates and the system clock; keep TLS verification enabled.'
        }
        'network-tls' {
            $summary = 'A build download failed while establishing its encrypted connection.'
            $nextStep = 'Check Docker Desktop proxy and network access, then retry the failed download step.'
        }
        'network-timeout' {
            $summary = 'A build network operation timed out.'
            $nextStep = 'Check Docker Desktop network and proxy connectivity, then retry the build.'
        }
        'network-interrupted' {
            $summary = 'A build network transfer was interrupted.'
            $nextStep = 'Check Docker Desktop network and proxy stability, then retry the failed download step.'
        }
        'registry-access' {
            $summary = 'A container registry denied access to a build image.'
            $nextStep = 'Check Docker Desktop registry sign-in and the image access permissions.'
        }
        'rate-limit' {
            $summary = 'A build service reported a request rate limit.'
            $nextStep = 'Wait for the service limit to reset, then retry the build.'
        }
        'memory' {
            $summary = 'A build step reported insufficient memory.'
            $nextStep = 'Check Docker Desktop memory availability and other running workloads before retrying.'
        }
        'process-killed' {
            $summary = 'A build process was killed with exit code 137; the reason is unknown.'
            $nextStep = 'Check Docker Desktop events and memory usage to determine why the process was killed.'
        }
        'application-compile' {
            $summary = 'The application build reported a TypeScript compilation error.'
            $nextStep = 'Inspect the application-build step in Docker Desktop and correct the reported source error.'
        }
        'npm' {
            $summary = 'An npm dependency or application build command failed.'
            $nextStep = 'Inspect the npm failure in the application-build step in Docker Desktop.'
        }
        'lean' {
            $summary = 'The Lean setup or compilation reported an error.'
            $nextStep = 'Inspect the lean-environment step and verify the Lean toolchain, dependencies, and project sources.'
        }
        'dependency-checkout' {
            $summary = 'A Git dependency checkout exited with code 128; the cause is unknown.'
            $nextStep = 'Inspect the dependency checkout failure in Docker Desktop to identify the cause before retrying.'
        }
    }
    return [pscustomobject]@{ ExitCode=$ExitCode; StepExitCode=$stepExitCode; Stage=$stage; Category=$category; Summary=$summary; NextStep=$nextStep }
}

function Write-BuildDiagnostic($Diagnostic, [int]$ElapsedSeconds) {
    # Input is the fixed-label object produced by Get-BuildFailureDiagnostic.
    $report = @(
        'LeanBridge Preflight V2 - safe build diagnostic',
        ('Docker exit code: ' + [int]$Diagnostic.ExitCode),
        ('Elapsed seconds: ' + $ElapsedSeconds),
        ('Failed stage: ' + $Diagnostic.Stage),
        ('Category: ' + $Diagnostic.Category),
        ('Summary: ' + $Diagnostic.Summary),
        ('Next step: ' + $Diagnostic.NextStep)
    )
    foreach ($line in $report) { Write-Host $line }
    try {
        $reportPath = Join-Path $PSScriptRoot 'leanbridge_preflight_v2_diagnostic.txt'
        [IO.File]::WriteAllLines($reportPath, $report, (New-Object Text.UTF8Encoding($false)))
        Write-Host 'Saved leanbridge_preflight_v2_diagnostic.txt beside this launcher.'
    } catch {
        Write-Host 'Could not save the diagnostic file; the safe summary is shown above.'
    }
}

function Invoke-LocalProbe([string]$Uri, [string]$Token = '', [int]$TimeoutSeconds = 10) {
    # No proxy, no redirects, no external URLs, and no raw exception/body logging.
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Method = 'GET'
    $request.Timeout = $TimeoutSeconds * 1000
    $request.ReadWriteTimeout = $TimeoutSeconds * 1000
    if ($Token.Length -gt 0) { $request.Headers['Authorization'] = 'Bearer ' + $Token }
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { return $null }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd()
        return ConvertFrom-Json -InputObject $body -ErrorAction Stop
    } catch {
        return $null
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Invoke-Preflight([string]$Path) {
    $script:FailureHint = 'Check the repository path and file permissions.'
    $script:WorkingRepo = [IO.Path]::GetFullPath($Path)
    foreach ($required in @('Dockerfile', '.dockerignore', 'package.json', '.env')) {
        if (-not [IO.File]::Exists((Join-Path $script:WorkingRepo $required))) {
            throw "Missing required repository file: $required"
        }
    }
    # Require the repository's existing secret exclusion before any Docker build context upload.
    $ignoreLines = [IO.File]::ReadAllLines((Join-Path $script:WorkingRepo '.dockerignore'))
    $protectsEnv = $false
    foreach ($line in $ignoreLines) {
        $rule = $line.Trim()
        if ($rule -eq '.env*') { $protectsEnv = $true }
        if ($rule.StartsWith('!') -and $rule -ne '!.env.example' -and $rule -ne '!.env.docker.example') {
            throw 'Review .dockerignore: unexpected include rule could expose .env secrets to the build.'
        }
    }
    if (-not $protectsEnv -or [IO.File]::Exists((Join-Path $script:WorkingRepo 'Dockerfile.dockerignore'))) {
        throw 'Build requires .env* in .dockerignore and no overriding Dockerfile.dockerignore.'
    }
    Write-Host '[1/5] Reading local .env and generating .env.docker (values hidden).'
    $script:FailureHint = 'Check .env formatting and the selected provider API key. Values are never printed.'
    $values = Read-LocalEnv (Join-Path $script:WorkingRepo '.env')
    $backendToken = New-BackendToken
    $dockerEnv = Join-Path $script:WorkingRepo '.env.docker'
    Write-DockerEnv $values $dockerEnv $backendToken

    Write-Host '[2/5] Checking Docker engine.'
    $script:FailureHint = 'Start Docker Desktop, wait for its engine, select Linux containers, then retry.'
    $script:DockerExecutable = (Get-Command docker.exe -CommandType Application -ErrorAction Stop).Source
    $engine = Invoke-Docker @('info', '--format', '{{.OSType}}')
    if ($engine.ExitCode -ne 0 -or $engine.Output -ne 'linux') { throw 'Docker Linux engine is not ready.' }

    Write-Host '[3/5] Building Docker image. First build may take a long time.'
    $script:FailureHint = 'Docker build failed. Check Docker Desktop build history for the failing step, network access to GitHub, and available disk space.'
    $imageName = 'leanbridge-ai:preflight-v2'
    $build = Invoke-Docker @('build', '--progress=plain', '--tag', $imageName, '.') -TimeoutSeconds 7200 -ShowProgress
    if ($build.ExitCode -ne 0) {
        $diagnostic = Get-BuildFailureDiagnostic -ExitCode $build.ExitCode -StandardOutput $build.Output -StandardError $build.StandardError -TimedOut:$build.TimedOut
        $script:FailureHint = $diagnostic.Summary + ' ' + $diagnostic.NextStep
        Write-BuildDiagnostic $diagnostic $build.ElapsedSeconds
        $build = $null
        throw 'Docker image build failed.'
    }

    Write-Host '[4/5] Starting a separate preflight container on a loopback-only port.'
    $script:FailureHint = 'Container startup failed. Check Docker Desktop container state and available resources.'
    $containerName = 'leanbridge-preflight-v2-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $completed = $false
    try {
        $run = Invoke-Docker @('run', '--detach', '--name', $containerName, '--env-file', $dockerEnv, '--publish', '127.0.0.1::4310', $imageName)
        if ($run.ExitCode -ne 0) { throw 'Docker could not start the preflight container.' }
        $portResult = Invoke-Docker @('port', $containerName, '4310/tcp')
        if ($portResult.ExitCode -ne 0 -or $portResult.Output -notmatch '^127\.0\.0\.1:(\d+)$') {
            throw 'Could not find the local preflight port.'
        }
        $baseUrl = 'http://127.0.0.1:' + $Matches[1]
        Write-Host '[5/5] Checking /api/health and authenticated /api/ready.'
        $script:FailureHint = 'Health check failed. The container may have stopped or could not load its configuration.'
        $healthy = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $health = Invoke-LocalProbe ($baseUrl + '/api/health')
            if ($null -ne $health -and $health.ok -eq $true -and $health.service -eq 'leanbridge') {
                $healthy = $true
                break
            }
            $state = Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $containerName)
            if ($state.ExitCode -ne 0 -or $state.Output -ne 'true') { throw 'Preflight container stopped before becoming healthy.' }
            Start-Sleep -Seconds 2
        }
        if (-not $healthy) { throw 'Health check timed out.' }
        Write-Host 'Health: {"ok":true,"service":"leanbridge"}'
        $script:FailureHint = 'Lean readiness failed. Check Docker Desktop for Lean/mathlib setup issues; readiness must return ok=true and lean=ready.'
        $ready = Invoke-LocalProbe ($baseUrl + '/api/ready') -Token $backendToken -TimeoutSeconds 90
        if ($null -eq $ready -or $ready.ok -ne $true -or $ready.lean -ne 'ready') { throw 'Authenticated Lean readiness did not pass.' }
        Write-Host 'Lean readiness: {"ok":true,"lean":"ready"}'
        Write-Host ''
        Write-Host 'PREFLIGHT PASSED' -ForegroundColor Green
        Write-Host ('Container left running: ' + $containerName)
        Write-Host ('Local address: ' + $baseUrl)
        Write-Host 'The new backend token is stored only in your local .env.docker and container.'
        Write-Host 'No model inference or Tavily search was requested.'
        Write-Host ('To remove this preflight container later: docker rm -f ' + $containerName)
        $completed = $true
    } finally {
        if (-not $completed) {
            # Remove only the uniquely named container created by this run.
            try {
                $cleanup = Invoke-Docker @('rm', '--force', $containerName)
                if ($cleanup.ExitCode -ne 0) { Write-Host ('If present, remove the failed container in Docker Desktop: ' + $containerName) }
            } catch { Write-Host ('If present, remove the failed container in Docker Desktop: ' + $containerName) }
        }
        $backendToken = $null
        $values = $null
    }
}

$exitCode = 1
$script:FailureHint = 'Check repository access and Docker Desktop, then retry.'
try {
    Write-Host 'LeanBridge FIXED Preflight V2 - build diagnostics revision' -ForegroundColor Cyan
    Write-Host 'Local configuration only. Secrets and raw command output are hidden.'
    Invoke-Preflight $RepoPath
    $exitCode = 0
} catch {
    # Do not print the exception, invocation details, env contents, or HTTP response body.
    Write-Host ''
    Write-Host 'PREFLIGHT FAILED' -ForegroundColor Red
    Write-Host $script:FailureHint
} finally {
    if (-not $PauseInLauncher) {
        Write-Host 'Press Enter to close'
        $null = Read-Host
    }
}
exit $exitCode
