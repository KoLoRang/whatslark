// 应用协调层：按配置装配 WA / 飞书 / 路由，支持配置热加载与生命周期管理
import type Database from 'better-sqlite3';
import { log } from './logger';
import { config } from './config';
import {
  getAppConfig,
  saveAppConfig,
  cleanupDedup,
  listGroupMappings,
  countGroupMappings,
  listPrivateThreads,
  countPrivateThreads,
} from './db';
import { WhatsAppManager } from './whatsapp/socket';
import { FeishuClient } from './feishu/client';
import { FeishuWsManager } from './feishu/ws';
import { BridgeRouter } from './bridge/router';
import type { AppConfig } from './types';

export class App {
  wa: WhatsAppManager;
  feishu?: FeishuClient;
  ws?: FeishuWsManager;
  router?: BridgeRouter;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private db: Database.Database) {
    this.wa = new WhatsAppManager(db);
    // WA 侧回调统一委派给“当前” router（可能尚未就绪）
    this.wa.setCallbacks({
      onMessage: (norm) => this.router?.onWaMessage(norm, false),
      onHistoryMessage: (norm) => this.router?.onWaMessage(norm, true),
      onGroupRename: (jid, name) => this.router?.onGroupRename(jid, name),
      onConnected: () => this.router?.syncAllGroups(),
    });
  }

  // 启动：读已有配置 → 装配飞书 → 若已有 WA 凭证则自动连接
  async start(): Promise<void> {
    const cfg = getAppConfig();
    if (cfg && cfg.app_id && cfg.app_secret) {
      this.initFeishu(cfg);
    } else {
      log.root.warn('尚未配置飞书，请写入 config.json 或使用 whatslark feishu-set');
    }
    // 若已有凭证，自动启动 WA；无凭证时等待用户执行 wa-login 生成 QR
    if (this.wa.hasStoredSession()) {
      await this.wa.start();
    } else {
      log.wa.info('未检测到 WhatsApp 登录态，等待 whatslark wa-login 触发扫码');
    }

    // 周期清理去重表
    this.cleanupTimer = setInterval(() => {
      try {
        const n = cleanupDedup(config.dedupRetentionDays);
        if (n > 0) log.bridge.info({ removed: n }, '清理过期去重记录');
      } catch (e) {
        log.bridge.error({ err: e }, '清理去重失败');
      }
    }, 6 * 60 * 60 * 1000);
  }

  // 保存飞书配置并(重)装配飞书侧；凭证未变化时跳过重连，避免 WS 抖动
  applyFeishuConfig(input: {
    app_id: string;
    app_secret: string;
    my_open_id: string;
    bot_open_id?: string;
  }): AppConfig {
    const prev = getAppConfig();
    const saved = saveAppConfig(input);
    const unchanged =
      this.ws &&
      prev &&
      prev.app_id === saved.app_id &&
      prev.app_secret === saved.app_secret &&
      prev.my_open_id === saved.my_open_id;
    if (unchanged) {
      log.feishu.debug('飞书配置未变化，跳过重装配');
      return saved;
    }
    this.initFeishu(saved);
    return saved;
  }

  private initFeishu(cfg: AppConfig): void {
    // 先关闭旧长连接，避免重复订阅/连接抖动
    this.ws?.stop();
    this.feishu = new FeishuClient(cfg.app_id, cfg.app_secret, cfg.my_open_id);
    this.router = new BridgeRouter(this.db, this.wa, this.feishu);
    // 长连接收飞书回复
    this.ws = new FeishuWsManager(
      cfg.app_id,
      cfg.app_secret,
      this.feishu,
      (norm) => this.router!.onFeishuMessage(norm)
    );
    try {
      this.ws.start();
    } catch (e) {
      log.feishu.error({ err: e }, '启动飞书长连接失败');
    }
    log.feishu.info('飞书侧已装配（Client + WSClient + Router）');
  }

  // 结构化健康状态（供 status.json / CLI 展示，字段对人友好）
  status() {
    const cfg = getAppConfig();
    return {
      feishu: {
        configured: !!(cfg && cfg.app_id && cfg.app_secret),
        appId: cfg?.app_id || '',
        // my_open_id 为空时你不会被拉进自动建的飞书群 → 收不到消息，单列出来提醒
        myOpenIdSet: !!cfg?.my_open_id,
        privateThreadReady: !!cfg?.private_agg_chat_id,
      },
      whatsapp: {
        state: this.wa.state,
        connected: this.wa.connected,
        lastConnectedAt: this.wa.lastConnectedAt
          ? new Date(this.wa.lastConnectedAt).toISOString()
          : null,
      },
      mappings: {
        groups: countGroupMappings(),
        privateThreads: countPrivateThreads(),
      },
    };
  }

  mappings() {
    return {
      groups: listGroupMappings(),
      privateThreads: listPrivateThreads(),
    };
  }

  async loginWa(): Promise<void> {
    if (this.wa.connected) {
      log.wa.info('WhatsApp 已处于登录状态，无需重复扫码');
      return;
    }
    log.wa.info('正在启动 WhatsApp 登录，请稍候，二维码将打印到日志…');
    await this.wa.start();
  }

  async logoutWa(): Promise<void> {
    await this.wa.logout();
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.ws?.stop();
  }
}
