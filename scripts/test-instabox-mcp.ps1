$ErrorActionPreference = 'Stop'

function Send-McpRequest {
    param(
        [Parameter(Mandatory = $true)] [System.Diagnostics.Process] $Process,
        [Parameter(Mandatory = $true)] [int] $Id,
        [Parameter(Mandatory = $true)] [string] $Method,
        [Parameter(Mandatory = $true)] [object] $Params
    )

    $request = @{
        jsonrpc = '2.0'
        id = $Id
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 20 -Compress
    $Process.StandardInput.WriteLine($request)
    $Process.StandardInput.Flush()

    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while ([DateTime]::UtcNow -lt $deadline) {
        $readTask = $Process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $readTask.Wait($remaining)) {
            throw "Timed out waiting for MCP response to $Method."
        }
        $line = $readTask.Result
        if ([string]::IsNullOrWhiteSpace($line)) {
            if ($Process.HasExited) { throw "MCP server exited before responding to $Method." }
            continue
        }
        try { $message = $line | ConvertFrom-Json -ErrorAction Stop }
        catch { continue }
        if ($message.id -eq $Id) { return $message }
    }
    throw "Timed out waiting for MCP response to $Method."
}

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'dist\index.js'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "Build output not found: $entry. Run 'npm run build' in the project first."
}
$node = (Get-Command node -ErrorAction Stop).Source

Write-Host 'This runs a real, read-only MCP SSH test (uname -a). The token is prompted securely and is not written to a file.'
Write-Host 'The previously observed CA fingerprint has not been independently verified.'
$pinChoice = Read-Host 'Enter an independently verified SHA256:... CA fingerprint, or type USE-OBSERVED-ONCE for a one-time functional test'
if ($pinChoice -ceq 'USE-OBSERVED-ONCE') {
    $pin = 'SHA256:rGanWVZg/oHA5vVgCK8dunVX2ZaTRQAPFhLm8u3xDfk'
    Write-Warning 'Using the previously observed CA pin for functional testing only; this does NOT independently authenticate the CA source.'
} elseif ($pinChoice -cmatch '^SHA256:[A-Za-z0-9+/]{43}$') {
    $pin = $pinChoice
} else {
    throw 'A complete SHA256 CA fingerprint or the exact text USE-OBSERVED-ONCE is required.'
}

$secure = Read-Host 'Enter your InstaBox SSH token (input hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$token = $null
$proc = $null
$psi = $null
$stderrTask = $null
$exitCode = 1

try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ($token -notmatch '^ibssh_.+') { throw 'The token format is not the expected ibssh_ format.' }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = '"' + $entry + '"'
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['SSH_MCP_INSTABOX_TOKEN'] = $token
    $psi.EnvironmentVariables['SSH_MCP_TRUSTED_HOST_CA_FINGERPRINTS'] = ('{"ssh.instabox.sh:2222":"' + $pin + '"}')

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    if (-not $proc.Start()) { throw 'Could not start the MCP server process.' }
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    $init = Send-McpRequest -Process $proc -Id 1 -Method 'initialize' -Params @{
        protocolVersion = '2025-03-26'
        capabilities = @{}
        clientInfo = @{ name = 'instabox-mcp-live-test'; version = '1.0.0' }
    }
    if ($null -eq $init.result.serverInfo) { throw 'MCP initialize did not return serverInfo.' }

    $proc.StandardInput.WriteLine((@{
        jsonrpc = '2.0'
        method = 'notifications/initialized'
        params = @{}
    } | ConvertTo-Json -Depth 10 -Compress))
    $proc.StandardInput.Flush()

    $listed = Send-McpRequest -Process $proc -Id 2 -Method 'tools/list' -Params @{}
    $tool = @($listed.result.tools | Where-Object { $_.name -eq 'ssh_run_openssh_temporary' } | Select-Object -First 1)
    if ($tool.Count -eq 0) { throw 'The MCP tool ssh_run_openssh_temporary is not registered.' }

    $call = Send-McpRequest -Process $proc -Id 3 -Method 'tools/call' -Params @{
        name = 'ssh_run_openssh_temporary'
        arguments = @{
            host = 'ssh.instabox.sh'
            usernameEnvVar = 'SSH_MCP_INSTABOX_TOKEN'
            port = 2222
            command = 'uname -a'
            timeoutMs = 15000
            maxOutputBytes = 4096
        }
    }

    $safeResponse = ($call | ConvertTo-Json -Depth 30) -replace [regex]::Escape($token), '[REDACTED]'
    Write-Host ''
    Write-Host 'MCP_RESPONSE (token redacted):'
    Write-Output $safeResponse

    $responseFailed = [bool]$call.result.isError
    $toolPayload = $null
    foreach ($content in @($call.result.content)) {
        if ($content.type -eq 'text') {
            try { $toolPayload = $content.text | ConvertFrom-Json -ErrorAction Stop }
            catch { $responseFailed = $true }
        }
    }
    if ($null -eq $toolPayload -or $toolPayload.ok -ne $true -or $toolPayload.result.exitCode -ne 0 -or $toolPayload.result.trustStoreDeleted -ne $true -or $toolPayload.result.stdout -notmatch 'Linux') {
        $responseFailed = $true
    }
    if ($responseFailed) {
        Write-Host 'MCP_E2E_RESULT=FAILED'
        $exitCode = 1
    } else {
        Write-Host 'MCP_E2E_RESULT=PASSED'
        Write-Host 'Assertions passed: remote uname -a returned Linux, SSH exit code was 0, and MCP reported trustStoreDeleted=true.'
        $exitCode = 0
    }
}
catch {
    $safeMessage = $_.Exception.Message
    if ($token) { $safeMessage = $safeMessage.Replace($token, '[REDACTED]') }
    Write-Host "TEST_ERROR=$safeMessage" -ForegroundColor Red
    $exitCode = 1
}
finally {
    if ($null -ne $proc) {
        try { $proc.StandardInput.Close() } catch {}
        if (-not $proc.HasExited -and -not $proc.WaitForExit(4000)) {
            try { $proc.Kill() } catch {}
            try { $proc.WaitForExit(2000) } catch {}
        }
        try { $proc.Dispose() } catch {}
    }
    if ($null -ne $psi) {
        try { $psi.EnvironmentVariables['SSH_MCP_INSTABOX_TOKEN'] = '' } catch {}
        $psi = $null
    }
    if ($null -ne $bstr -and $bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $token = $null
    $secure = $null
}

exit $exitCode
