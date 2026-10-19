[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" })
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Workers Chat - DeepSeek Harness 插件卸载器" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$DesktopProfile = Join-Path $DshHome "profiles\desktop"
$TargetPluginDir = Join-Path $DesktopProfile "node_modules\dsh-plugin-workers-chat"

# 1. 移除插件链接/目录
if (Test-Path $TargetPluginDir) {
    Write-Host "[*] 移除插件文件: $TargetPluginDir" -ForegroundColor Gray
    cmd /c rmdir "$TargetPluginDir" 2>$null
    if (Test-Path $TargetPluginDir) { Remove-Item -Recurse -Force $TargetPluginDir }
}

# 2. 从 package.json 移除
$PkgJsonPath = Join-Path $DesktopProfile "package.json"
if (Test-Path $PkgJsonPath) {
    try {
        $pkg = Get-Content $PkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if ($pkg.dependencies -and $pkg.dependencies.ContainsKey("dsh-plugin-workers-chat")) {
            $pkg.dependencies.Remove("dsh-plugin-workers-chat")
        }
        if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
            $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne "dsh-plugin-workers-chat" })
        }
        $pkg | ConvertTo-Json -Depth 10 | Set-Content $PkgJsonPath -Encoding UTF8
        Write-Host "[*] 已从 package.json 移除依赖声明。" -ForegroundColor Gray
    } catch {}
}

# 3. 从 cordis.patch.yml 移除
$PatchYmlPath = Join-Path $DesktopProfile "cordis.patch.yml"
if (Test-Path $PatchYmlPath) {
    $lines = Get-Content $PatchYmlPath -Encoding UTF8
    $newLines = @()
    $skipNext = $false
    foreach ($line in $lines) {
        if ($line -match "id:\s*workers-chat") {
            $skipNext = $true
            continue
        }
        if ($skipNext -and $line -match "name:\s*dsh-plugin-workers-chat") {
            $skipNext = $false
            continue
        }
        $skipNext = $false
        $newLines += $line
    }
    $newLines | Set-Content $PatchYmlPath -Encoding UTF8
    Write-Host "[*] 已从 cordis.patch.yml 移除插件配置。" -ForegroundColor Gray
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  卸载完成！请重启 DeepSeek Harness 客户端。" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
