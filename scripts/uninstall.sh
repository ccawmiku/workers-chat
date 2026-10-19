#!/usr/bin/env bash
set -e

echo "=========================================="
echo "  Workers Chat - DeepSeek Harness 插件卸载器"
echo "=========================================="

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DESKTOP_PROFILE="$DSH_HOME/profiles/desktop"
TARGET_PLUGIN_DIR="$DESKTOP_PROFILE/node_modules/dsh-plugin-workers-chat"

# 1. 移除插件文件
if [ -e "$TARGET_PLUGIN_DIR" ]; then
    echo "[*] 移除插件文件: $TARGET_PLUGIN_DIR"
    rm -rf "$TARGET_PLUGIN_DIR"
fi

# 2. 从 package.json 移除
PKG_PATH="$DESKTOP_PROFILE/package.json"
if [ -f "$PKG_PATH" ]; then
    node -e "
    const fs = require('fs');
    try {
      const pkg = JSON.parse(fs.readFileSync('$PKG_PATH', 'utf8'));
      if (pkg.dependencies) delete pkg.dependencies['dsh-plugin-workers-chat'];
      if (pkg.dsh?.profile?.bundles) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== 'dsh-plugin-workers-chat');
      }
      fs.writeFileSync('$PKG_PATH', JSON.stringify(pkg, null, 2), 'utf8');
      console.log('[*] 已从 package.json 移除依赖声明。');
    } catch(e){}
    " 2>/dev/null || true
fi

# 3. 从 cordis.patch.yml 移除
PATCH_PATH="$DESKTOP_PROFILE/cordis.patch.yml"
if [ -f "$PATCH_PATH" ]; then
    node -e "
    const fs = require('fs');
    try {
      let content = fs.readFileSync('$PATCH_PATH', 'utf8');
      content = content.replace(/\\n?\\s*-\\s*id:\\s*workers-chat\\s*\\n\\s*name:\\s*dsh-plugin-workers-chat/g, '');
      fs.writeFileSync('$PATCH_PATH', content, 'utf8');
      console.log('[*] 已从 cordis.patch.yml 移除插件配置。');
    } catch(e){}
    " 2>/dev/null || true
fi

echo ""
echo "=========================================="
echo "  卸载完成！请重启 DeepSeek Harness 客户端。"
echo "=========================================="
