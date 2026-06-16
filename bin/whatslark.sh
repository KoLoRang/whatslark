#!/bin/sh
# WhatsLark CLI 命令工具（在容器内通过 docker exec 调用）
# 用法：docker exec whatslark whatslark <command>
#
# 命令：
#   status          查看服务状态（飞书配置、WA 连接、映射数量）
#   feishu-config   查看/修改飞书配置
#   wa-login        触发 WhatsApp 登录（终端显示 QR）
#   wa-logout       WhatsApp 登出
#   mappings        查看消息映射（群 + 私聊话题）
#   help            显示帮助

DATA_DIR="${DATA_DIR:-/data}"
DB_PATH="${DB_PATH:-$DATA_DIR/bridge.db}"
STATUS_FILE="$DATA_DIR/status.json"
CMD_DIR="$DATA_DIR/cmd"
CONFIG_FILE="$DATA_DIR/config.json"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

print_help() {
  cat <<EOF
WhatsLark CLI 命令工具

用法: whatslark <command> [options]

命令:
  status              查看服务运行状态
  feishu-config       查看当前配置
  feishu-set <id> <secret> [open_id]   设置飞书配置（会触发热加载）
  wa-login            触发 WhatsApp 登录（QR 会打印到容器日志）
  wa-logout           WhatsApp 登出
  mappings            查看消息映射表
  help                显示此帮助

示例:
  whatslark status
  whatslark feishu-set cli_xxx mysecret ou_yyy
  whatslark wa-login
  docker compose logs -f whatslark   # 扫描终端 QR
EOF
}

cmd_status() {
  if [ ! -f "$STATUS_FILE" ]; then
    echo "${RED}✗ 服务尚未就绪${NC}：状态文件不存在（$STATUS_FILE）"
    echo "  请确认容器已启动： docker compose up -d"
    exit 1
  fi
  STATUS_FILE="$STATUS_FILE" node <<'NODE'
const fs = require('fs');
const G='\x1b[0;32m', R='\x1b[0;31m', Y='\x1b[0;33m', B='\x1b[1m', D='\x1b[2m', N='\x1b[0m';
let s;
try { s = JSON.parse(fs.readFileSync(process.env.STATUS_FILE, 'utf8')); }
catch (e) { console.log(R + '状态文件解析失败：' + N + e.message); process.exit(1); }

const dot = (b) => (b ? G + '✓' + N : R + '✗' + N);
const waMap = {
  connected:    [G, '已连接',   '正常双向同步中'],
  waiting_qr:   [Y, '等待扫码', '运行  docker compose logs -f whatslark  查看二维码'],
  connecting:   [Y, '连接中',   '正在建立连接，请稍候'],
  disconnected: [Y, '已断开',   '网络中断，正在自动重连'],
  logged_out:   [R, '未登录',   '运行  whatslark wa-login  扫码登录'],
};

const f = s.feishu || {}, w = s.whatsapp || {}, m = s.mappings || {};
const line = D + '  ' + '─'.repeat(42) + N;

console.log('');
console.log(B + '  WhatsLark 服务状态' + N);
console.log(line);

// 飞书
console.log('  ' + dot(f.configured) + '  飞书配置    ' +
  (f.configured ? G + '已配置' + N + D + '  (' + (f.appId || '') + ')' + N : R + '未配置' + N));
if (!f.configured)
  console.log(D + '         ↳ 运行  whatslark feishu-set <app_id> <secret> <my_open_id>' + N);
else if (!f.myOpenIdSet)
  console.log(Y + '         ⚠ 未设置 my_open_id：你不会被自动拉进新建的飞书群，将收不到消息！' + N);

// WhatsApp
const wm = waMap[w.state] || [Y, w.state || '未知', ''];
console.log('  ' + dot(w.connected) + '  WhatsApp    ' + wm[0] + wm[1] + N);
if (wm[2]) console.log(D + '         ↳ ' + wm[2] + N);
if (w.lastConnectedAt) console.log(D + '         最近连接 ' + w.lastConnectedAt + N);

// 映射
console.log('  ' + D + '•' + N + '  群映射      ' + B + (m.groups || 0) + N + ' 个');
console.log('  ' + D + '•' + N + '  私聊话题    ' + B + (m.privateThreads || 0) + N + ' 个');

console.log(line);
if (f.configured && w.connected) {
  console.log('  ' + G + '● 一切正常，消息正在双向同步' + N);
} else {
  console.log('  ' + Y + '● 服务待完善，请按上面 ↳ 提示完成配置' + N);
}
if (s.updatedAt) console.log(D + '  状态更新于 ' + s.updatedAt + N);
console.log('');
NODE
}

cmd_feishu_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "${RED}配置文件不存在: $CONFIG_FILE${NC}"
    exit 1
  fi
  echo "=== 当前飞书配置 ($CONFIG_FILE) ==="
  CONFIG_FILE="$CONFIG_FILE" node <<'NODE'
const fs = require('fs');
let c = {};
try { c = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE, 'utf8')); } catch {}
const mask = (v) => !v ? '(未设置)' : (v.length <= 6 ? '****' : v.slice(0, 3) + '****' + v.slice(-2));
console.log('  app_id      : ' + (c.app_id || '(未设置)'));
console.log('  app_secret  : ' + mask(c.app_secret));   // 脱敏，避免截图泄密
console.log('  my_open_id  : ' + (c.my_open_id || '(未设置)'));
console.log('  bot_open_id : ' + (c.bot_open_id || '(未设置)'));
NODE
}

cmd_feishu_set() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "${RED}用法: whatslark feishu-set <app_id> <app_secret> [my_open_id]${NC}"
    echo "${YELLOW}提示：省略 my_open_id 时会保留原有值，不会清空。${NC}"
    exit 1
  fi
  APP_ID="$1"
  APP_SECRET="$2"
  MY_OPEN_ID="${3:-}"
  mkdir -p "$DATA_DIR"
  APP_ID="$APP_ID" APP_SECRET="$APP_SECRET" MY_OPEN_ID="$MY_OPEN_ID" CONFIG_FILE="$CONFIG_FILE" node <<'NODE'
const fs = require('fs');

const configFile = process.env.CONFIG_FILE;
let prev = {};
try { prev = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}

const next = {
  app_id: process.env.APP_ID || '',
  app_secret: process.env.APP_SECRET || '',
  // 省略第三个参数时保留原有 my_open_id，避免误把已配置的 open_id 清空
  my_open_id: process.env.MY_OPEN_ID || (typeof prev.my_open_id === 'string' ? prev.my_open_id : ''),
  bot_open_id: typeof prev.bot_open_id === 'string' ? prev.bot_open_id : '',
};

fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + '\n', 'utf8');

const mask = (v) => !v ? '(未设置)' : (v.length <= 6 ? '****' : v.slice(0, 3) + '****' + v.slice(-2));
console.log('  app_id      : ' + (next.app_id || '(未设置)'));
console.log('  app_secret  : ' + mask(next.app_secret));
console.log('  my_open_id  : ' + (next.my_open_id || '(未设置)'));
if (!next.my_open_id) {
  console.log('\x1b[0;33m  ⚠ 未设置 my_open_id：你不会被自动拉进新建的飞书群，将收不到消息！\x1b[0m');
  console.log('\x1b[2m    补设：whatslark feishu-set ' + next.app_id + ' <secret> ou_xxxx\x1b[0m');
}
NODE
  echo "${GREEN}✓ 飞书配置已写入，服务将在约 1 秒内自动热加载${NC}"
}

cmd_wa_login() {
  mkdir -p "$CMD_DIR"
  touch "$CMD_DIR/wa-login"
  echo "${GREEN}✓ 已触发 WhatsApp 登录${NC}"
  echo ""
  echo "下一步：用下面命令查看并扫描二维码（手机 WhatsApp → 已关联的设备 → 关联新设备）："
  echo "  ${YELLOW}docker compose logs -f whatslark${NC}"
  echo ""
  echo "${YELLOW}提示：二维码每约 20 秒自动刷新，过期会自动重出；扫码成功后日志会显示「✅ WhatsApp 已连接」。${NC}"
  echo "若已登录，本命令不会重复弹码（日志会提示「已处于登录状态」）。"
}

cmd_wa_logout() {
  mkdir -p "$CMD_DIR"
  touch "$CMD_DIR/wa-logout"
  echo "${GREEN}已触发 WhatsApp 登出${NC}"
}

cmd_mappings() {
  if [ ! -f "$DB_PATH" ]; then
    echo "${RED}数据库不存在: $DB_PATH${NC}"
    exit 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "${RED}sqlite3 未安装${NC}"
    exit 1
  fi
  echo "=== 群映射 (GROUP_MAPPING) ==="
  sqlite3 -header -column "$DB_PATH" \
    "SELECT substr(wa_group_name, 1, 30) AS name, feishu_chat_id FROM GROUP_MAPPING ORDER BY created_at DESC;" 2>/dev/null || echo "(无)"
  echo ""
  echo "=== 私聊话题 (PRIVATE_THREAD_MAPPING) ==="
  sqlite3 -header -column "$DB_PATH" \
    "SELECT substr(contact_name, 1, 30) AS contact, thread_id FROM PRIVATE_THREAD_MAPPING ORDER BY created_at DESC;" 2>/dev/null || echo "(无)"
}

# 主入口
case "${1:-help}" in
  status)         cmd_status ;;
  feishu-config)  cmd_feishu_config ;;
  feishu-set)     shift; cmd_feishu_set "$@" ;;
  wa-login)       cmd_wa_login ;;
  wa-logout)      cmd_wa_logout ;;
  mappings)       cmd_mappings ;;
  help|--help|-h) print_help ;;
  *)
    echo "${RED}未知命令: $1${NC}"
    echo ""
    print_help
    exit 1
    ;;
esac
