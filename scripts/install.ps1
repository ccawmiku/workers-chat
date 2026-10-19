[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }),
    [string]$Branch = "DeepSeekHarness",
    [string]$RepoUrl = "https://github.com/ccawmiku/workers-chat.git"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Workers Chat - DeepSeek Harness 插件安装器" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. 检查 DSH 用户目录
if (-not (Test-Path $DshHome)) {
    Write-Host "[错误] 未检测到 DeepSeek Harness 目录: $DshHome" -ForegroundColor Red
    Write-Host "请确保已安装并至少启动过一次 DeepSeek Harness 客户端。" -ForegroundColor Yellow
    exit 1
}

$DesktopProfile = Join-Path $DshHome "profiles\desktop"
if (-not (Test-Path $DesktopProfile)) {
    Write-Host "[*] 创建桌面 profile 目录: $DesktopProfile" -ForegroundColor Gray
    New-Item -ItemType Directory -Path $DesktopProfile -Force | Out-Null
}

# 2. 检查插件安装路径
$PluginsDir = Join-Path $DesktopProfile "node_modules"
if (-not (Test-Path $PluginsDir)) {
    New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null
}
$TargetPluginDir = Join-Path $PluginsDir "dsh-plugin-workers-chat"

# 判断当前是否已在本地仓库目录中运行该脚本
$CurrentScriptDir = $PSScriptRoot
$LocalRepoRoot = if ($CurrentScriptDir) { Split-Path -Parent $CurrentScriptDir } else { "" }
$IsLocalRepo = ($LocalRepoRoot -and (Test-Path (Join-Path $LocalRepoRoot "cordis.patch.yml")) -and (Test-Path (Join-Path $LocalRepoRoot "package.json")))

if ($IsLocalRepo) {
    Write-Host "[*] 检测到从本地仓库运行，创建目录软链接 (Junction)..." -ForegroundColor Green
    if (Test-Path $TargetPluginDir) {
        cmd /c rmdir "$TargetPluginDir" 2>$null
        if (Test-Path $TargetPluginDir) { Remove-Item -Recurse -Force $TargetPluginDir }
    }
    New-Item -ItemType Junction -Path $TargetPluginDir -Target $LocalRepoRoot -Force | Out-Null
} else {
    Write-Host "[*] 正在下载/克隆 Workers Chat ($Branch 分支)..." -ForegroundColor Green
    $InstallStorage = Join-Path $DshHome "storages\workers_chat_repo"
    if (Test-Path (Join-Path $InstallStorage ".git")) {
        Write-Host "[*] 更新现有仓库代码..." -ForegroundColor Gray
        git -C $InstallStorage fetch origin $Branch
        git -C $InstallStorage reset --hard "origin/$Branch"
    } else {
        if (Test-Path $InstallStorage) { Remove-Item -Recurse -Force $InstallStorage }
        git clone -b $Branch --depth 1 $RepoUrl $InstallStorage
    }
    
    # 链接到 node_modules
    if (Test-Path $TargetPluginDir) {
        cmd /c rmdir "$TargetPluginDir" 2>$null
        if (Test-Path $TargetPluginDir) { Remove-Item -Recurse -Force $TargetPluginDir }
    }
    New-Item -ItemType Junction -Path $TargetPluginDir -Target $InstallStorage -Force | Out-Null
}

# 3. 配置 desktop-preferences.json (开启 browserAccess)
$DesktopPrefsPath = Join-Path $DshHome "desktop-preferences.json"
$prefs = @{}
if (Test-Path $DesktopPrefsPath) {
    try {
        $prefs = Get-Content $DesktopPrefsPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    } catch {}
}
if ($prefs["browserAccess"] -ne $true) {
    Write-Host "[*] 配置桌面客户端 browserAccess = true..." -ForegroundColor Green
    $prefs["browserAccess"] = $true
    $prefs | ConvertTo-Json -Depth 5 | Set-Content $DesktopPrefsPath -Encoding UTF8
}

# 4. 配置 package.json (声明依赖和 bundles)
$PkgJsonPath = Join-Path $DesktopProfile "package.json"
$pkg = @{
    name = "dsh-profile-desktop"
    private = $true
    dependencies = @{}
    dsh = @{
        profile = @{
            bundles = @()
        }
    }
}
if (Test-Path $PkgJsonPath) {
    try {
        $pkg = Get-Content $PkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    } catch {}
}
if (-not $pkg.dependencies) { $pkg.dependencies = @{} }
if (-not $pkg.dsh) { $pkg.dsh = @{} }
if (-not $pkg.dsh.profile) { $pkg.dsh.profile = @{} }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile.bundles = @() }

$pkg.dependencies["dsh-plugin-workers-chat"] = "*"
if ($pkg.dsh.profile.bundles -notcontains "dsh-plugin-workers-chat") {
    $pkg.dsh.profile.bundles += "dsh-plugin-workers-chat"
}
$pkg | ConvertTo-Json -Depth 10 | Set-Content $PkgJsonPath -Encoding UTF8
Write-Host "[*] 已在 $PkgJsonPath 中注册插件依赖与 bundle。" -ForegroundColor Green

# 5. 配置 cordis.patch.yml
$PatchYmlPath = Join-Path $DesktopProfile "cordis.patch.yml"
$patchContent = ""
if (Test-Path $PatchYmlPath) {
    $patchContent = Get-Content $PatchYmlPath -Raw -Encoding UTF8
}
if ($patchContent -notmatch "id:\s*workers-chat") {
    Write-Host "[*] 在 cordis.patch.yml 中激活 workers-chat 插件..." -ForegroundColor Green
    $entry = @"

- id: workers-chat
  name: dsh-plugin-workers-chat
"@
    Add-Content -Path $PatchYmlPath -Value $entry -Encoding UTF8
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  安装成功！" -ForegroundColor Green
Write-Host "  请完全退出并重新打开 DeepSeek Harness 客户端。" -ForegroundColor Green
Write-Host "  打开后，左侧面板将出现 'Workers Chat' 图标。" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
