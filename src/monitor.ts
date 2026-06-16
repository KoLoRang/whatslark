// 配置文件监听 + 命令文件监听 + 状态文件写入
import fs from 'fs';
import path from 'path';
import { log } from './logger';
import { config } from './config';
import type { App } from './app';
import type { AppConfig } from './types';
import { debounce } from './utils';

const DATA_DIR = config.dataDir;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const CMD_DIR = path.join(DATA_DIR, 'cmd');

type AppJsonConfig = Partial<Pick<AppConfig, 'app_id' | 'app_secret' | 'my_open_id' | 'bot_open_id'>>;

/** 确保 /data/config.json 存在（空模板） */
function ensureConfigFile(): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    const template: AppJsonConfig = { app_id: '', app_secret: '', my_open_id: '', bot_open_id: '' };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2) + '\n', 'utf8');
    log.root.info({ path: CONFIG_PATH }, '已创建空配置文件模板');
  }
}

/** 确保 /data/cmd/ 目录存在 */
function ensureCmdDir(): void {
  if (!fs.existsSync(CMD_DIR)) {
    fs.mkdirSync(CMD_DIR, { recursive: true });
    log.root.info({ path: CMD_DIR }, '已创建命令目录');
  }
}

/** 从 config.json 读取配置并应用到 App */
function loadAndApplyConfig(app: App): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg: AppJsonConfig = JSON.parse(raw);

    if (cfg.app_id && cfg.app_secret) {
      app.applyFeishuConfig({
        app_id: cfg.app_id,
        app_secret: cfg.app_secret,
        my_open_id: cfg.my_open_id || '',
        bot_open_id: cfg.bot_open_id || '',
      });
      log.root.info('从 config.json 热加载配置');
    } else {
      log.root.warn('config.json 中飞书配置不完整（缺 app_id 或 app_secret）');
    }
  } catch (e) {
    log.root.error({ err: e }, '读取 config.json 失败');
  }
}

/** 处理 /data/cmd/ 下的单个命令文件 */
function processCommandFile(app: App, file: string): void {
  const filePath = path.join(CMD_DIR, file);
  if (!fs.existsSync(filePath)) return;

  try {
    switch (file) {
      case 'wa-login':
        log.root.info('收到命令：WA 登录');
        app.loginWa().catch((e: any) => log.root.error({ err: e }, 'WA 登录失败'));
        break;
      case 'wa-logout':
        log.root.info('收到命令：WA 登出');
        app.logoutWa().catch((e: any) => log.root.error({ err: e }, 'WA 登出失败'));
        break;
      default:
        log.root.warn({ file }, '未知命令文件，忽略');
    }
  } catch (e) {
    log.root.error({ err: e, file }, '处理命令文件失败');
  } finally {
    // 执行完删除命令文件
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/** 处理启动前残留的命令文件 */
function processPendingCommands(app: App): void {
  if (!fs.existsSync(CMD_DIR)) return;
  for (const file of fs.readdirSync(CMD_DIR)) {
    processCommandFile(app, file);
  }
}

/** 状态仅变更时写入（减少冗余 SQLite 查询与文件写） */
let prevStatus: string | undefined;
function writeStatusIfChanged(app: App): void {
  try {
    const status = app.status();
    // 用不含时间戳的快照判断是否有实质变化，避免每次心跳都重写文件
    const snapshot = JSON.stringify(status);
    if (snapshot !== prevStatus) {
      prevStatus = snapshot;
      // updatedAt 反映“最近一次状态变化”的时间，对排障更有意义
      const json =
        JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2) + '\n';
      fs.writeFileSync(STATUS_PATH, json, 'utf8');
    }
  } catch (e) {
    log.root.error({ err: e }, '写入 status.json 失败');
  }
}

/** 启动所有监听，返回关闭函数 */
export function startMonitor(app: App): () => void {
  // 初始化文件和目录
  ensureConfigFile();
  ensureCmdDir();

  // 首次从 config.json 加载配置
  loadAndApplyConfig(app);

  // 处理启动前残留的命令文件
  processPendingCommands(app);

  // 写一次初始状态（后续定时仅写变更）
  writeStatusIfChanged(app);

  const watchers: fs.FSWatcher[] = [];

  // 监听 config.json 变化（防抖）
  const onConfigChange = debounce(() => loadAndApplyConfig(app), 500);
  try {
    watchers.push(fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') onConfigChange();
    }));
    log.root.info({ path: CONFIG_PATH }, '开始监听配置文件变化');
  } catch (e) {
    log.root.error({ err: e }, '监听配置文件失败');
  }

  // 监听命令目录变化（处理单个文件，防抖）
  const onCmdFile = debounce((file: string) => processCommandFile(app, file), 200);
  try {
    watchers.push(fs.watch(CMD_DIR, (eventType, filename) => {
      if (eventType === 'rename' && filename) onCmdFile(filename);
    }));
    log.root.info({ path: CMD_DIR }, '开始监听命令目录');
  } catch (e) {
    log.root.error({ err: e }, '监听命令目录失败');
  }

  // 定期写入状态文件（每 10 秒，仅变更时写）
  const timer = setInterval(() => writeStatusIfChanged(app), 10_000);

  return () => {
    watchers.forEach(w => {
      try { w.close(); } catch {}
    });
    clearInterval(timer);
  };
}
