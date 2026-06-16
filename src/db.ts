// SQLite 数据访问层：建库/建表/索引 + 映射、去重、配置、authState 存储
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { log } from './logger';
import type {
  AppConfig,
  GroupMapping,
  PrivateThreadMapping,
  SyncDirection,
} from './types';

let db: Database.Database;

export function initDb(dbPath: string = config.dbPath): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS GROUP_MAPPING (
      wa_jid          TEXT PRIMARY KEY,
      feishu_chat_id  TEXT NOT NULL,
      wa_group_name   TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_chat_id ON GROUP_MAPPING(feishu_chat_id);

    CREATE TABLE IF NOT EXISTS PRIVATE_THREAD_MAPPING (
      wa_jid            TEXT PRIMARY KEY,
      feishu_chat_id    TEXT NOT NULL,
      thread_id         TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      contact_name      TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_id ON PRIVATE_THREAD_MAPPING(thread_id);

    CREATE TABLE IF NOT EXISTS MESSAGE_DEDUP (
      msg_key    TEXT PRIMARY KEY,
      direction  TEXT NOT NULL,
      synced_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dedup_synced_at ON MESSAGE_DEDUP(synced_at);

    CREATE TABLE IF NOT EXISTS WA_AUTH_STATE (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS APP_CONFIG (
      id                  TEXT PRIMARY KEY,
      app_id              TEXT,
      app_secret          TEXT,
      my_open_id          TEXT,
      bot_open_id         TEXT,
      private_agg_chat_id TEXT,
      web_basic_auth      TEXT,
      updated_at          INTEGER
    );
  `);

  log.db.info({ dbPath }, 'SQLite 初始化完成');
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB 未初始化，请先调用 initDb()');
  return db;
}

// ---------------- 群映射 ----------------
export function getGroupMappingByJid(waJid: string): GroupMapping | undefined {
  return getDb()
    .prepare('SELECT * FROM GROUP_MAPPING WHERE wa_jid=?')
    .get(waJid) as GroupMapping | undefined;
}

export function getGroupMappingByChatId(chatId: string): GroupMapping | undefined {
  return getDb()
    .prepare('SELECT * FROM GROUP_MAPPING WHERE feishu_chat_id=?')
    .get(chatId) as GroupMapping | undefined;
}

export function upsertGroupMapping(m: GroupMapping): void {
  getDb()
    .prepare(
      `INSERT INTO GROUP_MAPPING (wa_jid, feishu_chat_id, wa_group_name, created_at)
       VALUES (@wa_jid, @feishu_chat_id, @wa_group_name, @created_at)
       ON CONFLICT(wa_jid) DO UPDATE SET
         feishu_chat_id=excluded.feishu_chat_id,
         wa_group_name=excluded.wa_group_name`
    )
    .run(m);
}

export function updateGroupName(waJid: string, name: string): void {
  getDb()
    .prepare('UPDATE GROUP_MAPPING SET wa_group_name=? WHERE wa_jid=?')
    .run(name, waJid);
}

export function listGroupMappings(): GroupMapping[] {
  return getDb()
    .prepare('SELECT * FROM GROUP_MAPPING ORDER BY created_at DESC')
    .all() as GroupMapping[];
}

export function countGroupMappings(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM GROUP_MAPPING').get() as { n: number }).n;
}

// ---------------- 私聊话题映射 ----------------
export function getPrivateThreadByJid(
  waJid: string
): PrivateThreadMapping | undefined {
  return getDb()
    .prepare('SELECT * FROM PRIVATE_THREAD_MAPPING WHERE wa_jid=?')
    .get(waJid) as PrivateThreadMapping | undefined;
}

export function getPrivateThreadByThreadId(
  threadId: string
): PrivateThreadMapping | undefined {
  return getDb()
    .prepare('SELECT * FROM PRIVATE_THREAD_MAPPING WHERE thread_id=?')
    .get(threadId) as PrivateThreadMapping | undefined;
}

export function upsertPrivateThread(m: PrivateThreadMapping): void {
  getDb()
    .prepare(
      `INSERT INTO PRIVATE_THREAD_MAPPING
         (wa_jid, feishu_chat_id, thread_id, anchor_message_id, contact_name, created_at)
       VALUES (@wa_jid, @feishu_chat_id, @thread_id, @anchor_message_id, @contact_name, @created_at)
       ON CONFLICT(wa_jid) DO UPDATE SET
         feishu_chat_id=excluded.feishu_chat_id,
         thread_id=excluded.thread_id,
         anchor_message_id=excluded.anchor_message_id,
         contact_name=excluded.contact_name`
    )
    .run(m);
}

export function listPrivateThreads(): PrivateThreadMapping[] {
  return getDb()
    .prepare('SELECT * FROM PRIVATE_THREAD_MAPPING ORDER BY created_at DESC')
    .all() as PrivateThreadMapping[];
}

export function countPrivateThreads(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM PRIVATE_THREAD_MAPPING').get() as { n: number }).n;
}

// ---------------- 去重 ----------------
export function isDuplicate(msgKey: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM MESSAGE_DEDUP WHERE msg_key=?')
    .get(msgKey);
  return !!row;
}

// 原子写入；返回 true 表示这是首次（未重复），false 表示已存在
export function markSynced(msgKey: string, direction: SyncDirection): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO MESSAGE_DEDUP (msg_key, direction, synced_at)
       VALUES (?, ?, ?)`
    )
    .run(msgKey, direction, Date.now());
  return res.changes > 0;
}

export function cleanupDedup(retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const res = getDb()
    .prepare('DELETE FROM MESSAGE_DEDUP WHERE synced_at < ?')
    .run(cutoff);
  return res.changes;
}

// ---------------- 应用配置 ----------------
export function getAppConfig(): AppConfig | undefined {
  return getDb()
    .prepare("SELECT * FROM APP_CONFIG WHERE id='default'")
    .get() as AppConfig | undefined;
}

export function saveAppConfig(partial: Partial<AppConfig>): AppConfig {
  const cur = getAppConfig();
  const merged: AppConfig = {
    id: 'default',
    app_id: partial.app_id ?? cur?.app_id ?? '',
    app_secret: partial.app_secret ?? cur?.app_secret ?? '',
    my_open_id: partial.my_open_id ?? cur?.my_open_id ?? '',
    bot_open_id: partial.bot_open_id ?? cur?.bot_open_id ?? '',
    private_agg_chat_id:
      partial.private_agg_chat_id ?? cur?.private_agg_chat_id ?? '',
    updated_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO APP_CONFIG
         (id, app_id, app_secret, my_open_id, bot_open_id, private_agg_chat_id, updated_at)
       VALUES (@id, @app_id, @app_secret, @my_open_id, @bot_open_id, @private_agg_chat_id, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         app_id=excluded.app_id,
         app_secret=excluded.app_secret,
         my_open_id=excluded.my_open_id,
         bot_open_id=excluded.bot_open_id,
         private_agg_chat_id=excluded.private_agg_chat_id,
         updated_at=excluded.updated_at`
    )
    .run(merged);
  return merged;
}
