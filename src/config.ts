// 全局运行时配置（仅来自环境变量；飞书业务配置存 SQLite APP_CONFIG）
import path from 'path';

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'bridge.db');

export const config = {
  // SQLite 数据文件路径（Docker 中挂载到宿主机 /data）
  dbPath,
  // 控制文件目录（config.json / status.json / cmd/）；默认与 DB 同目录，可用 DATA_DIR 覆盖
  dataDir: process.env.DATA_DIR || path.dirname(dbPath),
  // 日志级别
  logLevel: process.env.LOG_LEVEL || 'info',
  // WA→飞书 发送的限速间隔(ms)，防风控
  sendIntervalMs: envInt('SEND_INTERVAL_MS', 600),
  // 历史消息回灌时的逐条间隔(ms)
  historyIntervalMs: envInt('HISTORY_INTERVAL_MS', 400),
  // 登录后全量建群时每个群之间的间隔(ms)
  groupSyncIntervalMs: envInt('GROUP_SYNC_INTERVAL_MS', 1500),
  // 去重记录保留天数，超过清理
  dedupRetentionDays: envInt('DEDUP_RETENTION_DAYS', 7),
  // 是否启动时全量同步所有群（A3）
  syncAllGroupsOnLogin: (process.env.SYNC_ALL_GROUPS ?? 'true') !== 'false',
  // 是否拉取历史消息（A2）
  syncFullHistory: (process.env.SYNC_FULL_HISTORY ?? 'true') !== 'false',
  // 媒体最大字节数（超出降级为文本提示）
  maxMediaBytes: envInt('MAX_MEDIA_BYTES', 50 * 1024 * 1024),
};

export type AppRuntimeConfig = typeof config;
