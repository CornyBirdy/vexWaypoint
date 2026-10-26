# Static file server for the sim using only what ships with Windows.
# Used by run-sim.bat when Python is not installed.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 -Port 8137
param([int]$Port = 8137)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$rootPrefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

$mime = @{
    '.html'    = 'text/html; charset=utf-8'
    '.js'      = 'text/javascript; charset=utf-8'
    '.css'     = 'text/css; charset=utf-8'
    '.json'    = 'application/json'
    '.jerryio' = 'application/json'
    '.txt'     = 'text/plain; charset=utf-8'
    '.cpp'     = 'text/plain; charset=utf-8'
    '.svg'     = 'image/svg+xml'
    '.png'     = 'image/png'
    '.ico'     = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try {
    $listener.Start()
} catch {
    Write-Host "Could not listen on port ${Port}: $($_.Exception.Message)"
    exit 1
}
Write-Host "VEX Auton Sim serving $root"
Write-Host "Listening on http://127.0.0.1:$Port/"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $res = $ctx.Response
        try {
            $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
            if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
            $hidden = $false
            foreach ($part in $rel.Split('/')) { if ($part.StartsWith('.')) { $hidden = $true } }
            $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
            if ($hidden -or -not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
                $res.StatusCode = 404
                $bytes = [System.Text.Encoding]::UTF8.GetBytes('Not found')
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
                Write-Host "404 $rel"
            } else {
                $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
                if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
                $res.Headers.Add('Cache-Control', 'no-cache')
                $bytes = [System.IO.File]::ReadAllBytes($full)
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
                Write-Host "200 $rel"
            }
        } catch {
            try { $res.StatusCode = 500 } catch { }
        } finally {
            $res.Close()
        }
    }
} finally {
    $listener.Stop()
}
