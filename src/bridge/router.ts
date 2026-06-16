// 双向桥接核心：WA<->飞书 路由、自动建群、私聊话题归集、去重、防回环
import type Database from 'better-sqlite3';
import { log } from '../logger';
import { config } from '../config';
import {
  getGroupMappingByJid,
  getGroupMappingByChatId,
  upsertGroupMapping,
  updateGroupName,
  getPrivateThreadByJid,
  getPrivateThreadByThreadId,
  upsertPrivateThread,
  markSynced,
  getAppConfig,
  saveAppConfig,
} from '../db';
import type { NormalizedMessage } from '../types';
import type { WhatsAppManager } from '../whatsapp/socket';
import type { FeishuClient } from '../feishu/client';
import { KeyedMutex } from './mutex';
import { sleep } from '../utils';

export class BridgeRouter {
  private mutex = new KeyedMutex();
  private privateAggChatId: string;

  constructor(
    private db: Database.Database,
    private wa: WhatsAppManager,
    private feishu: FeishuClient
  ) {
    this.privateAggChatId = getAppConfig()?.private_agg_chat_id || '';
  }

  // ============ WhatsApp -> 飞书 ============
  async onWaMessage(norm: NormalizedMessage, isHistory = false): Promise<void> {
    // 去重 + 防重推：首次写入返回 true
    if (!markSynced(norm.dedupKey, 'wa2fs')) {
      log.bridge.debug({ key: norm.dedupKey }, '重复消息(wa2fs)，跳过');
      return;
    }
    try {
      if (norm.isGroup) {
        await this.routeWaGroupToFeishu(norm);
      } else {
        await this.routeWaPrivateToFeishu(norm);
      }
    } catch (e) {
      log.bridge.error({ err: e, key: norm.dedupKey, isHistory }, 'WA→飞书 失败');
    }
  }

  private async routeWaGroupToFeishu(norm: NormalizedMessage): Promise<void> {
    const chatId = await this.ensureGroupChat(norm.conversationId);
    const prefix = `[WA] ${norm.senderName}`;
    // 群里有多人，媒体也必须带上发送人，否则飞书侧看不出是谁发的
    if (norm.mediaType === 'image' && norm.mediaBuffer) {
      await this.feishu.sendText(chatId, norm.text ? `${prefix}：${norm.text}` : `${prefix}：[图片]`);
      const key = await this.feishu.uploadImage(norm.mediaBuffer);
      await this.feishu.sendImage(chatId, key);
    } else if ((norm.mediaType === 'audio' || norm.mediaType === 'file') && norm.mediaBuffer) {
      const isAudio = norm.mediaType === 'audio';
      const label = isAudio ? '[语音]' : `[文件] ${norm.mediaFileName || ''}`.trim();
      await this.feishu.sendText(chatId, norm.text ? `${prefix}：${norm.text}` : `${prefix}：${label}`);
      const key = await this.feishu.uploadFile(
        norm.mediaBuffer,
        norm.mediaFileName || (isAudio ? 'voice.ogg' : 'file'),
        norm.mediaMime || (isAudio ? 'audio/ogg' : 'application/octet-stream')
      );
      await this.feishu.sendFile(chatId, key);
    } else {
      await this.feishu.sendText(chatId, `${prefix}：${norm.text}`);
    }
  }

  private async routeWaPrivateToFeishu(norm: NormalizedMessage): Promise<void> {
    const thread = await this.ensurePrivateThread(
      norm.conversationId,
      norm.senderName
    );
    const anchor = thread.anchor_message_id;
    const prefix = `[WA] ${norm.senderName}`;
    if (norm.mediaType === 'image' && norm.mediaBuffer) {
      await this.feishu.replyInThread(anchor, norm.text ? `${prefix}：${norm.text}` : `${prefix}：[图片]`);
      const key = await this.feishu.uploadImage(norm.mediaBuffer);
      await this.feishu.replyImageInThread(anchor, key);
    } else if ((norm.mediaType === 'audio' || norm.mediaType === 'file') && norm.mediaBuffer) {
      const isAudio = norm.mediaType === 'audio';
      const label = isAudio ? '[语音]' : `[文件] ${norm.mediaFileName || ''}`.trim();
      await this.feishu.replyInThread(anchor, norm.text ? `${prefix}：${norm.text}` : `${prefix}：${label}`);
      const key = await this.feishu.uploadFile(
        norm.mediaBuffer,
        norm.mediaFileName || (isAudio ? 'voice.ogg' : 'file'),
        norm.mediaMime || (isAudio ? 'audio/ogg' : 'application/octet-stream')
      );
      await this.feishu.replyFileInThread(anchor, key);
    } else {
      await this.feishu.replyInThread(anchor, `${prefix}：${norm.text}`);
    }
  }

  // ============ 飞书 -> WhatsApp ============
  async onFeishuMessage(norm: NormalizedMessage): Promise<void> {
    if (!markSynced(norm.dedupKey, 'fs2wa')) {
      log.bridge.debug({ key: norm.dedupKey }, '重复消息(fs2wa)，跳过');
      return;
    }
    try {
      const waJid = this.resolveWaTarget(norm);
      if (!waJid) {
        log.bridge.warn(
          { chatId: norm.conversationId, threadId: norm.threadId },
          '飞书→WA 找不到映射，忽略'
        );
        return;
      }
      if (norm.mediaType === 'image' && norm.mediaBuffer) {
        await this.wa.sendImage(waJid, norm.mediaBuffer, norm.text || undefined);
      } else if (norm.mediaType === 'audio' && norm.mediaBuffer) {
        await this.wa.sendAudio(waJid, norm.mediaBuffer, norm.mediaMime || 'audio/ogg');
      } else if (norm.mediaType === 'file' && norm.mediaBuffer) {
        await this.wa.sendFile(
          waJid,
          norm.mediaBuffer,
          norm.mediaFileName || 'file',
          norm.mediaMime || 'application/octet-stream'
        );
      } else if (norm.text) {
        await this.wa.sendText(waJid, norm.text);
      }
      log.bridge.info(
        { waJid, chatId: norm.conversationId, threadId: norm.threadId, mediaType: norm.mediaType || 'text' },
        '飞书→WA 已发送'
      );
    } catch (e) {
      log.bridge.error({ err: e, key: norm.dedupKey }, '飞书→WA 失败');
    }
  }

  // 反查：私聊话题(thread_id) 优先，其次普通群(chat_id)
  private resolveWaTarget(norm: NormalizedMessage): string | undefined {
    if (
      norm.threadId &&
      this.privateAggChatId &&
      norm.conversationId === this.privateAggChatId
    ) {
      const t = getPrivateThreadByThreadId(norm.threadId);
      if (t) return t.wa_jid;
    }
    const g = getGroupMappingByChatId(norm.conversationId);
    return g?.wa_jid;
  }

  // ============ 建群 / 建话题 ============
  private async ensureGroupChat(waJid: string): Promise<string> {
    const existing = getGroupMappingByJid(waJid);
    if (existing) return existing.feishu_chat_id;
    // 串行化，防并发重复建群
    return this.mutex.run(`group:${waJid}`, async () => {
      const again = getGroupMappingByJid(waJid);
      if (again) return again.feishu_chat_id;
      const name = await this.wa.getGroupSubject(waJid);
      const chatId = await this.feishu.createGroupChat(`WA · ${name}`);
      upsertGroupMapping({
        wa_jid: waJid,
        feishu_chat_id: chatId,
        wa_group_name: name,
        created_at: Date.now(),
      });
      log.bridge.info({ waJid, chatId, name }, '已建飞书群并写映射');
      return chatId;
    });
  }

  private async ensurePrivateAggChat(): Promise<string> {
    if (this.privateAggChatId) return this.privateAggChatId;
    return this.mutex.run('private-agg', async () => {
      const fromCfg = getAppConfig()?.private_agg_chat_id;
      if (fromCfg) {
        this.privateAggChatId = fromCfg;
        return fromCfg;
      }
      const chatId = await this.feishu.createTopicChat('WA · 私聊归集');
      saveAppConfig({ private_agg_chat_id: chatId });
      this.privateAggChatId = chatId;
      log.bridge.info({ chatId }, '已创建私聊归集话题群');
      return chatId;
    });
  }

  private async ensurePrivateThread(
    waJid: string,
    contactName: string
  ): Promise<{ anchor_message_id: string; thread_id: string }> {
    const existing = getPrivateThreadByJid(waJid);
    if (existing)
      return {
        anchor_message_id: existing.anchor_message_id,
        thread_id: existing.thread_id,
      };
    return this.mutex.run(`private:${waJid}`, async () => {
      const again = getPrivateThreadByJid(waJid);
      if (again)
        return {
          anchor_message_id: again.anchor_message_id,
          thread_id: again.thread_id,
        };
      const aggChatId = await this.ensurePrivateAggChat();
      const root = await this.feishu.sendThreadRoot(
        aggChatId,
        `👤 ${contactName}（WhatsApp 私聊）`
      );
      upsertPrivateThread({
        wa_jid: waJid,
        feishu_chat_id: aggChatId,
        thread_id: root.threadId,
        anchor_message_id: root.messageId,
        contact_name: contactName,
        created_at: Date.now(),
      });
      log.bridge.info({ waJid, threadId: root.threadId }, '已为私聊联系人建话题');
      return { anchor_message_id: root.messageId, thread_id: root.threadId };
    });
  }

  // ============ A3 登录后全量建群 ============
  async syncAllGroups(): Promise<void> {
    if (!config.syncAllGroupsOnLogin) return;
    try {
      const groups = await this.wa.fetchAllGroups();
      log.bridge.info({ count: groups.length }, '开始全量同步所有群');
      for (const g of groups) {
        try {
          await this.ensureGroupChat(g.id);
        } catch (e) {
          log.bridge.error({ err: e, jid: g.id }, '全量建群单项失败');
        }
        await sleep(config.groupSyncIntervalMs); // 限速防封号
      }
      log.bridge.info('全量同步群完成');
    } catch (e) {
      log.bridge.error({ err: e }, '全量同步群失败');
    }
  }

  // ============ C7 群改名同步 ============
  async onGroupRename(waJid: string, newName: string): Promise<void> {
    const m = getGroupMappingByJid(waJid);
    if (!m) return; // 还没建群，忽略（建群时会用新名）
    try {
      await this.feishu.updateChatName(m.feishu_chat_id, `WA · ${newName}`);
      updateGroupName(waJid, newName);
      log.bridge.info({ waJid, newName }, '已同步群改名到飞书');
    } catch (e) {
      log.bridge.error({ err: e, waJid }, '同步群改名失败');
    }
  }
}
