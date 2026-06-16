// WhatsApp 接入：makeWASocket 封装，连接/重连/QR/消息监听/群信息/媒体
import makeWASocket, {
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type GroupMetadata,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { execFile } from 'child_process';
import NodeCache from 'node-cache';
import type Database from 'better-sqlite3';
import { log } from '../logger';
import { config } from '../config';
import { useSqliteAuthState, type SqliteAuthState } from './auth-sqlite';
import type { NormalizedMessage } from '../types';
import { sleep } from '../utils';

export interface WaCallbacks {
  // 实时新消息（已过滤 fromMe）
  onMessage?: (msg: NormalizedMessage, raw: WAMessage) => void | Promise<void>;
  // 历史消息（A2），按时间正序逐条
  onHistoryMessage?: (
    msg: NormalizedMessage,
    raw: WAMessage
  ) => void | Promise<void>;
  // 群改名（C7）
  onGroupRename?: (jid: string, newName: string) => void | Promise<void>;
  // 连接成功（用于 A3 全量建群）
  onConnected?: () => void | Promise<void>;
}

export interface WhatsAppManagerOptions {
  makeSocket?: typeof makeWASocket;
}

// 指数退避重连参数
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MULTIPLIER = 2;

// WhatsApp 连接状态机（用于状态展示，给人看的）
export type WaState =
  | 'logged_out'   // 无登录态，需扫码
  | 'connecting'   // 正在建立连接
  | 'waiting_qr'   // 已生成二维码，等待扫描
  | 'connected'    // 已连接，正常收发
  | 'disconnected'; // 连接中断，等待自动重连

export class WhatsAppManager {
  private sock: WASocket | undefined;
  private auth: SqliteAuthState;
  private groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });
  private cb: WaCallbacks = {};
  private starting = false;
  private reconnectDelay = RECONNECT_BASE_MS;

  connected = false;
  /** 最近一次成功连接的时间戳（ms），未连接过为 undefined */
  lastConnectedAt?: number;
  private _state: WaState;

  private makeSocket: typeof makeWASocket;

  constructor(
    private db: Database.Database,
    options: WhatsAppManagerOptions = {}
  ) {
    this.auth = useSqliteAuthState(db);
    this.makeSocket = options.makeSocket || makeWASocket;
    // 启动初值：有凭证则视为待重连，无凭证则未登录
    this._state = this.hasStoredSession() ? 'connecting' : 'logged_out';
  }

  /** 当前连接状态（给状态展示用） */
  get state(): WaState {
    return this._state;
  }

  setCallbacks(cb: WaCallbacks) {
    this.cb = { ...this.cb, ...cb };
  }

  getSocket(): WASocket | undefined {
    return this.sock;
  }

  hasStoredSession(): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM WA_AUTH_STATE WHERE key='creds'")
      .get();
    return !!row;
  }

  async start(): Promise<void> {
    if (this.sock) return;
    if (this.starting) return;
    this.starting = true;
    if (!this.connected) this._state = 'connecting';
    try {
      // 动态获取最新 WA Web 版本号，避免内置版本过期被服务器拒绝（405 Connection Failure）
      let version: [number, number, number] | undefined;
      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
        log.wa.info({ version, isLatest: fetched.isLatest }, '已获取 WhatsApp Web 版本号');
      } catch (e) {
        log.wa.warn({ err: e }, '获取最新 WA 版本失败，使用 Baileys 内置版本');
      }
      this.sock = this.makeSocket({
        auth: this.auth.state,
        ...(version ? { version } : {}),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: config.syncFullHistory,
        markOnlineOnConnect: false,
        cachedGroupMetadata: async (jid) => this.groupCache.get<GroupMetadata>(jid),
      });
      this.registerHandlers();
    } finally {
      this.starting = false;
    }
  }

  private registerHandlers() {
    const sock = this.sock!;
    sock.ev.on('creds.update', this.auth.saveCreds);

    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        // 在终端打印二维码（docker logs 可见）
        this._state = 'waiting_qr';
        log.wa.info('📱 请用手机 WhatsApp 扫描下方二维码登录（约 20 秒刷新一次，过期会自动重出）：');
        qrcode.generate(u.qr, { small: true }, (code) => {
          console.log('\n' + code + '\n');
        });
      }
      if (u.connection === 'open') {
        this.connected = true;
        this._state = 'connected';
        this.lastConnectedAt = Date.now();
        this.reconnectDelay = RECONNECT_BASE_MS; // 连接成功，重置退避
        log.wa.info('✅ WhatsApp 已连接，开始双向同步');
        Promise.resolve(this.cb.onConnected?.()).catch((e) =>
          log.wa.error({ err: e }, 'onConnected 回调异常')
        );
      }
      if (u.connection === 'close') {
        this.connected = false;
        if (this.sock === sock) this.sock = undefined;
        const code = (u.lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this._state = loggedOut ? 'logged_out' : 'disconnected';
        log.wa.warn({ code, loggedOut, nextRetry: this.reconnectDelay }, 'WhatsApp 连接关闭');
        if (loggedOut) {
          log.wa.warn('⚠️ WhatsApp 已登出（可能在手机上移除了本设备），运行 whatslark wa-login 重新扫码');
        }
        if (!loggedOut) {
          // 非登出一律新建 socket 重连（不可复用旧实例），指数退避
          const delay = this.reconnectDelay;
          this.reconnectDelay = Math.min(this.reconnectDelay * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
          setTimeout(() => this.start().catch((e) => log.wa.error({ err: e }, '重连失败')), delay);
        }
      }
    });

    // 群改名（C7）
    sock.ev.on('groups.update', async (updates) => {
      for (const g of updates) {
        if (g.id && g.subject) {
          this.groupCache.del(g.id);
          await Promise.resolve(this.cb.onGroupRename?.(g.id, g.subject)).catch(
            (e) => log.wa.error({ err: e }, 'onGroupRename 回调异常')
          );
        }
      }
    });

    sock.ev.on('group-participants.update', (ev) => {
      this.groupCache.del(ev.id); // 成员变动使群缓存失效
    });

    // 实时消息
    sock.ev.on('messages.upsert', async ({ type, messages }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const norm = await this.normalize(m);
        if (norm) await Promise.resolve(this.cb.onMessage?.(norm, m)).catch((e) =>
          log.wa.error({ err: e }, 'onMessage 回调异常')
        );
      }
    });

    // 历史消息回灌（A2）
    sock.ev.on('messaging-history.set', async ({ messages }) => {
      if (!config.syncFullHistory) return;
      // 按时间正序，逐条限速交给 router
      const ordered = [...messages].sort(
        (a, b) => Number(a.messageTimestamp ?? 0) - Number(b.messageTimestamp ?? 0)
      );
      for (const m of ordered) {
        const norm = await this.normalize(m);
        if (norm) {
          await Promise.resolve(this.cb.onHistoryMessage?.(norm, m)).catch((e) =>
            log.wa.error({ err: e }, 'onHistoryMessage 回调异常')
          );
          await sleep(config.historyIntervalMs);
        }
      }
    });
  }

  // 把 Baileys 原始消息规范化；返回 undefined 表示应忽略（fromMe / 无内容 / 状态广播）
  private async normalize(m: WAMessage): Promise<NormalizedMessage | undefined> {
    if (m.key.fromMe) return undefined; // 防回环①
    if (!m.message) return undefined;
    const jid = m.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return undefined;

    const isGroup = jid.endsWith('@g.us');
    const senderName =
      m.pushName ||
      (isGroup ? m.key.participant || '群成员' : '对方');

    const content = m.message;
    const msg: NormalizedMessage = {
      source: 'wa',
      conversationId: jid,
      isGroup,
      senderName,
      text: '',
      dedupKey: `wa:${m.key.id}`,
    };

    // 文本
    const text =
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      '';
    msg.text = text;

    // 图片
    if (content.imageMessage) {
      const buf = await this.tryDownload(m);
      if (buf) {
        msg.mediaType = 'image';
        msg.mediaBuffer = buf;
        msg.mediaMime = content.imageMessage.mimetype || 'image/jpeg';
        msg.mediaFileName = `image_${m.key.id}.jpg`;
      } else {
        // 下载失败/超限：给出明确占位，绝不静默丢弃
        msg.text = text || '🖼️ [图片：下载失败或超出大小限制]';
      }
      return msg;
    }
    // 视频 — 作为文件同步到飞书（保留原始内容，不再静默丢弃）
    if (content.videoMessage) {
      const buf = await this.tryDownload(m);
      if (buf) {
        msg.mediaType = 'file';
        msg.mediaBuffer = buf;
        msg.mediaMime = content.videoMessage.mimetype || 'video/mp4';
        msg.mediaFileName = `video_${m.key.id}.mp4`;
      } else {
        msg.text = text || '🎬 [视频：下载失败或超出大小限制]';
      }
      return msg;
    }
    // 文件/文档
    if (content.documentMessage) {
      const buf = await this.tryDownload(m);
      const name = content.documentMessage.fileName || `file_${m.key.id}`;
      if (buf) {
        msg.mediaType = 'file';
        msg.mediaBuffer = buf;
        msg.mediaMime =
          content.documentMessage.mimetype || 'application/octet-stream';
        msg.mediaFileName = name;
      } else {
        msg.text = text || `📎 [文件「${name}」：下载失败或超出大小限制]`;
      }
      return msg;
    }
    // 语音/音频 — 转码为 opus/ogg 供飞书播放
    if (content.audioMessage) {
      const buf = await this.tryDownload(m);
      if (buf) {
        try {
          const opusBuf = await transcodeToOpus(buf);
          msg.mediaType = 'audio';
          msg.mediaBuffer = opusBuf;
          msg.mediaMime = 'audio/ogg';
          msg.mediaFileName = `voice_${m.key.id}.ogg`;
        } catch (e) {
          log.wa.error({ err: e }, '语音转码失败，降级为文件');
          msg.mediaType = 'file';
          msg.mediaBuffer = buf;
          msg.mediaMime = content.audioMessage.mimetype || 'audio/mp4';
          msg.mediaFileName = `voice_${m.key.id}.${content.audioMessage.mimetype?.split('/')[1] || 'mp4'}`;
        }
      } else {
        msg.text = text || '🎤 [语音：下载失败或超出大小限制]';
      }
      return msg;
    }

    // 贴纸 / 位置 / 名片：转为清晰的文本占位，让飞书侧知道"对方发了什么"，而非凭空消失
    if (content.stickerMessage) {
      msg.text = '🩷 [贴纸]';
      return msg;
    }
    if (content.locationMessage) {
      const { degreesLatitude: lat, degreesLongitude: lng, name, address } =
        content.locationMessage;
      const where = [name, address].filter(Boolean).join(' ');
      const link =
        lat != null && lng != null
          ? ` https://maps.google.com/?q=${lat},${lng}`
          : '';
      msg.text = `📍 [位置]${where ? ' ' + where : ''}${link}`;
      return msg;
    }
    if (content.liveLocationMessage) {
      msg.text = '📍 [实时位置共享]';
      return msg;
    }
    if (content.contactMessage || content.contactsArrayMessage) {
      const name =
        content.contactMessage?.displayName ||
        content.contactsArrayMessage?.displayName ||
        '';
      msg.text = `👤 [名片]${name ? ' ' + name : ''}`;
      return msg;
    }

    if (!text) return undefined; // 协议/回执/反应等无展示内容的消息，静默忽略
    return msg;
  }

  private async tryDownload(m: WAMessage): Promise<Buffer | undefined> {
    try {
      const buf = (await downloadMediaMessage(
        m,
        'buffer',
        {},
        {
          logger: log.wa as any,
          reuploadRequest: this.sock!.updateMediaMessage,
        }
      )) as Buffer;
      if (buf.length > config.maxMediaBytes) {
        log.wa.warn({ size: buf.length }, '媒体超过大小限制，降级为文本');
        return undefined;
      }
      return buf;
    } catch (e) {
      log.wa.error({ err: e }, '媒体下载失败');
      return undefined;
    }
  }

  // ---------------- 发送 ----------------
  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WA socket 未就绪');
    await this.sock.sendMessage(jid, { text });
  }

  async sendImage(jid: string, buffer: Buffer, caption?: string): Promise<void> {
    if (!this.sock) throw new Error('WA socket 未就绪');
    await this.sock.sendMessage(jid, { image: buffer, caption });
  }

  async sendAudio(jid: string, buffer: Buffer, mimetype?: string): Promise<void> {
    if (!this.sock) throw new Error('WA socket 未就绪');
    await this.sock.sendMessage(jid, { audio: buffer, mimetype: mimetype || 'audio/mp4' });
  }

  async sendFile(
    jid: string,
    buffer: Buffer,
    fileName: string,
    mimetype: string
  ): Promise<void> {
    if (!this.sock) throw new Error('WA socket 未就绪');
    await this.sock.sendMessage(jid, {
      document: buffer,
      fileName,
      mimetype,
    });
  }

  // ---------------- 群信息 ----------------
  async getGroupSubject(jid: string): Promise<string> {
    try {
      const meta = await this.groupMetadata(jid);
      return meta?.subject || jid;
    } catch {
      return jid;
    }
  }

  async groupMetadata(jid: string): Promise<GroupMetadata | undefined> {
    const cached = this.groupCache.get<GroupMetadata>(jid);
    if (cached) return cached;
    if (!this.sock) return undefined;
    const meta = await this.sock.groupMetadata(jid);
    if (meta) this.groupCache.set(jid, meta);
    return meta;
  }

  async fetchAllGroups(): Promise<GroupMetadata[]> {
    if (!this.sock) return [];
    const map = await this.sock.groupFetchAllParticipating();
    const list = Object.values(map);
    for (const g of list) this.groupCache.set(g.id, g);
    return list;
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch (e) {
      log.wa.warn({ err: e }, 'logout 调用异常（忽略）');
    }
    this.auth.clear();
    this.connected = false;
    this._state = 'logged_out';
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.sock = undefined;
    log.wa.info('已登出 WhatsApp 并清除本地登录态');
  }
}

/** 用 ffmpeg 将音频 Buffer 转码为 opus/ogg（单声道，适合 WhatsApp 语音格式） */
function transcodeToOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', 'pipe:0',       // 从 stdin 读
      '-c:a', 'libopus',    // opus 编码
      '-b:a', '64k',        // 比特率
      '-ac', '1',            // 单声道
      '-f', 'ogg',           // ogg 容器
      'pipe:1',              // 输出到 stdout
    ];
    const child = execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err) return reject(err);
      if (!stdout || stdout.length === 0) return reject(new Error('ffmpeg 输出为空'));
      resolve(stdout as unknown as Buffer);
    });
    child.stdin!.write(input);
    child.stdin!.end();
  });
}

export type { WAMessage, proto };
