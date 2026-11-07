#!/bin/bash
# 部署入口：bash deploy.sh [local|vps|all]   默认 all
#
# 源 = ./static/index.html（唯一改动点）。部署时自动注入 window.__BUILD__ 版本戳。
# local: 刷新本机运行时插件目录（RUNTIME_DIR，默认 ~/.config/magpie/my-usage-page），
#        即改即生效，无需重启。
# vps:   可选，只部署独立看板；本机归因不需要它。未设 VPS_HOST 时跳过。
#
# 环境变量：
#   RUNTIME_DIR  本机运行时插件目录        默认 ~/.config/magpie/my-usage-page
#   VPS_HOST     ssh 主机别名/地址         默认空（表示不部署 VPS）
#   VPS_DIR      VPS 上的安装目录          默认 /opt/magpie-usage
#   PORT         看板端口                  默认 3455
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/static"
RUNTIME_DIR="${RUNTIME_DIR:-$HOME/.config/magpie/my-usage-page}"
VPS_HOST="${VPS_HOST:-}"
VPS_DIR="${VPS_DIR:-/opt/magpie-usage}"
PORT="${PORT:-3455}"
MODE="${1:-all}"
STAMP="$(date +%Y%m%d-%H%M)-$(md5sum "$SRC/index.html" | awk '{print substr($1,1,8)}')"

stamp() { # stamp <输出路径> —— 写入带版本戳的 index.html；注入 <head> 后，保证先于主脚本执行
  # QLOGOS 不再由部署注入：服务端启动时扫描用户已装插件并在返回页面时注入（见 server.mjs）
  sed "s#<head>#<head><script>window.__BUILD__=\"$STAMP\";</script>#" "$SRC/index.html" > "$1"
}

page_with_port() { # 带路页只写固定端口；口令由服务端注入返回的看板 HTML，不落进文件
  sed -E "s#127\.0\.0\.1:[0-9]+/#127.0.0.1:${PORT}/#g" "$DIR/page/index.html" > "$1"
}

sync_local() {
  local t="$RUNTIME_DIR"
  mkdir -p "$t/static" "$t/page" || return 1
  if stamp "$t/static/index.html.new"; then
    mv "$t/static/index.html.new" "$t/static/index.html"
    cp "$SRC/echarts.min.js" "$t/static/echarts.min.js"
    rm -rf "$t/static/logos" # logo 已改为运行时扫描（DATA_DIR），不再随部署携带
    rm -f "$t/static/remote.js"
    page_with_port "$t/page/index.html.new" && mv "$t/page/index.html.new" "$t/page/index.html"
    sed -E "s#127\.0\.0\.1:[0-9]+#127.0.0.1:${PORT}#g" "$DIR/page/boot.js" > "$t/page/boot.js"
    cp "$DIR/page/icon.svg" "$t/page/icon.svg" 2>/dev/null
    cp "$DIR/server.mjs" "$t/server.mjs"
    cp "$DIR/index.mjs" "$t/index.mjs"
    # 插件清单：以仓库为准同步（icon/标题/service 声明），保留运行时既有包名
    # （magpie 按目录注册插件，改 name 有被当成另一个插件的风险）
    if [ -f "$t/package.json" ]; then
      node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(r.name)p.name=r.name;fs.writeFileSync(process.argv[2]+'.new',JSON.stringify(p,null,2)+'\n')" "$DIR/package.json" "$t/package.json" && mv "$t/package.json.new" "$t/package.json"
    else
      cp "$DIR/package.json" "$t/package.json"
    fi
    echo "local ok: $t  ($STAMP, port $PORT)"
  else
    echo "local FAIL: $t"; return 1
  fi
}

sync_vps() {
  if [ -z "$VPS_HOST" ]; then echo "vps skipped: VPS_HOST is not set"; return 0; fi
  local tmp="/tmp/usage-index-$STAMP.html"
  stamp "$tmp" || return 1
  for i in 1 2 3; do
    if timeout 90 scp -q -o ConnectTimeout=10 "$tmp" "$VPS_HOST:$VPS_DIR/static/index.html"; then
      RM=$(timeout 30 ssh -o ConnectTimeout=10 "$VPS_HOST" "md5sum $VPS_DIR/static/index.html" 2>/dev/null | awk '{print $1}')
      LM=$(md5sum "$tmp" | awk '{print $1}')
      if [ -n "$RM" ] && [ "$RM" = "$LM" ]; then echo "vps ok: $VPS_DIR/static/index.html ($STAMP)"; return 0; fi
    fi
    echo "vps retry $i"; sleep 5
  done
  echo "vps push FAIL: check SSH to $VPS_HOST" >&2
  return 1
}

case "$MODE" in
  local) sync_local ;;
  vps)   sync_vps ;;
  all)   sync_local && sync_vps ;;
  *) echo "用法: bash deploy.sh [local|vps|all]"; exit 1 ;;
esac