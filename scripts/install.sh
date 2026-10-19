#!/usr/bin/env bash
set -e

echo "=========================================="
echo "  Workers Chat - DeepSeek Harness 插件安装器"
echo "=========================================="

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
BRANCH="${BRANCH:-DeepSeekHarness}"
REPO_URL="${REPO_URL:-https://github.com/ccawmiku/workers-chat.git}"

if [ ! -d "$DSH_HOME" ]; then
    echo "[错误] 未检测到 DeepSeek Harness 目录: $DSH_HOME"
    echo "请确保已安装并至少启动过一次 DeepSeek Harness 客户端。"
    exit 1
fi

DESKTOP_PROFILE="$DSH_HOME/profiles/desktop"
mkdir -p "$DESKTOP_PROFILE/node_modules"
TARGET_PLUGIN_DIR="$DESKTOP_PROFILE/node_modules/dsh-plugin-workers-chat"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
LOCAL_REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -n "$SCRIPT_DIR" ] && [ -f "$LOCAL_REPO_ROOT/cordis.patch.yml" ] && [ -f "$LOCAL_REPO_ROOT/package.json" ]; then
    echo "[*] 检测到从本地仓库运行，创建目录软链接..."
    rm -rf "$TARGET_PLUGIN_DIR"
    ln -s "$LOCAL_REPO_ROOT" "$TARGET_PLUGIN_DIR"
else
    echo "[*] 正在下载/克隆 Workers Chat ($BRANCH 分支)..."
    INSTALL_STORAGE="$DSH_HOME/storages/workers_chat_repo"
    if [ -d "$INSTALL_STORAGE/.git" ]; then
        echo "[*] 更新现有仓库代码..."
        git -C "$INSTALL_STORAGE" fetch origin "$BRANCH"
        git -C "$INSTALL_STORAGE" reset --hard "origin/$BRANCH"
    else
        rm -rf "$INSTALL_STORAGE"
        git clone -b "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_STORAGE"
    fi
    rm -rf "$TARGET_PLUGIN_DIR"
    ln -s "$INSTALL_STORAGE" "$TARGET_PLUGIN_DIR"
fi

# desktop-preferences.json: browserAccess = true
PREFS_PATH="$DSH_HOME/desktop-preferences.json"
if [ -f "$PREFS_PATH" ]; then
    node -e "
    const fs = require('fs');
    try {
      const p = JSON.parse(fs.readFileSync('$PREFS_PATH', 'utf8'));
      p.browserAccess = true;
      fs.writeFileSync('$PREFS_PATH', JSON.stringify(p, null, 2), 'utf8');
    } catch(e){}
    " 2>/dev/null || true
else
    echo '{"browserAccess": true}' > "$PREFS_PATH"
fi

# package.json: register bundle
PKG_PATH="$DESKTOP_PROFILE/package.json"
node -e "
const fs = require('fs');
let pkg = { name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
if (fs.existsSync('$PKG_PATH')) {
  try { pkg = JSON.parse(fs.readFileSync('$PKG_PATH', 'utf8')); } catch(e){}
}
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
pkg.dependencies['dsh-plugin-workers-chat'] = '*';
if (!pkg.dsh.profile.bundles.includes('dsh-plugin-workers-chat')) {
  pkg.dsh.profile.bundles.push('dsh-plugin-workers-chat');
}
fs.writeFileSync('$PKG_PATH', JSON.stringify(pkg, null, 2), 'utf8');
" 2>/dev/null || true

# cordis.patch.yml: add entry
PATCH_PATH="$DESKTOP_PROFILE/cordis.patch.yml"
if [ ! -f "$PATCH_PATH" ]; then
    touch "$PATCH_PATH"
fi
if ! grep -q "id: workers-chat" "$PATCH_PATH"; then
    cat << 'EOF' >> "$PATCH_PATH"

- id: workers-chat
  name: dsh-plugin-workers-chat
EOF
fi

echo ""
echo "=========================================="
echo "  安装成功！"
echo "  请完全退出并重新打开 DeepSeek Harness 客户端。"
echo "  打开后，左侧面板将出现 'Workers Chat' 图标。"
echo "=========================================="
