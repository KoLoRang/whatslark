// 飞书长连接 WSClient：订阅 im.message.receive_v1，规范化后交给 router
import * as Lark from '@larksuiteoapi/node-sdk';
import { log } from '../logger';
import type { NormalizedMessage } from '../types';
import type { FeishuClient } from './client';

export type FeishuMessageHandler = (
  msg: NormalizedMessage
) => void | Promise<void>;

export class FeishuWsManager {
  private ws: Lark.WSClient | undefined;

  constructor(
    private appId: string,
    private appSecret: string,
    private feishuClient: FeishuClient,
    private handler: FeishuMessageHandler
  ) {}

  start(): void {
    this.ws = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Lark.Domain.Feishu,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: any) => {
        // 立即返回（3s 超时约束），异步处理避免重推
        this.onMessage(data).catch((e) => {
          log.feishu.error({ err: e }, '处理飞书事件异常');
        });
      },
    });

    this.ws.start({ eventDispatcher: dispatcher });
    log.feishu.info('飞书长连接 WSClient 已启动');
  }

  stop(): void {
    if (this.ws) {
      try {
        this.ws.close();
        log.feishu.info('飞书长连接 WSClient 已关闭');
      } catch (e) {
        log.feishu.warn({ err: e }, '关闭飞书长连接异常');
      }
      this.ws = undefined;
    }
  }

  private async onMessage(data: any): Promise<void> {
    const sender = data?.sender;
    const message = data?.message;
    if (!sender || !message) return;

    // 防回环②：只转真人(user)消息，机器人自己发的丢弃
    if (sender.sender_type !== 'user') return;

    const chatId: string = message.chat_id;
    const threadId: string | undefined = message.thread_id || undefined;
    const messageId: string = message.message_id;
    const msgType: string = message.message_type;
    log.feishu.info(
      { chatId, threadId, msgType, senderOpenId: sender.sender_id?.open_id },
      '收到飞书消息事件(im.message.receive_v1)'
    );
    const contentRaw: string = message.content || '{}';
    let content: any = {};
    try {
      content = JSON.parse(contentRaw);
    } catch {
      content = {};
    }

    const base: NormalizedMessage = {
      source: 'feishu',
      conversationId: chatId,
      isGroup: true,
      senderName: sender.sender_id?.open_id || 'me',
      text: '',
      dedupKey: `fs:${messageId}`,
      threadId,
    };

    if (msgType === 'text') {
      base.text = content.text || '';
      if (!base.text) return;
      await this.handler(base);
      return;
    }

    // 富文本（@人、加粗、链接、粘贴的格式化文字会变成 post）——提取纯文本，避免回复静默丢失
    if (msgType === 'post') {
      base.text = extractPostText(content);
      if (!base.text) return;
      await this.handler(base);
      return;
    }

    if (msgType === 'image') {
      const imageKey: string = content.image_key;
      if (!imageKey) return;
      const buf = await this.feishuClient.downloadMessageResource(
        messageId,
        imageKey,
        'image'
      );
      base.mediaType = 'image';
      base.mediaBuffer = buf;
      base.mediaMime = 'image/jpeg';
      base.mediaFileName = `feishu_${messageId}.jpg`;
      await this.handler(base);
      return;
    }

    if (msgType === 'file') {
      const fileKey: string = content.file_key;
      const fileName: string = content.file_name || `feishu_${messageId}`;
      if (!fileKey) return;
      const buf = await this.feishuClient.downloadMessageResource(
        messageId,
        fileKey,
        'file'
      );
      base.mediaType = 'file';
      base.mediaBuffer = buf;
      base.mediaFileName = fileName;
      base.mediaMime = 'application/octet-stream';
      await this.handler(base);
      return;
    }

    if (msgType === 'audio') {
      const fileKey: string = content.file_key;
      if (!fileKey) return;
      const buf = await this.feishuClient.downloadMessageResource(
        messageId,
        fileKey,
        'file'
      );
      base.mediaType = 'audio';
      base.mediaBuffer = buf;
      base.mediaFileName = `feishu_audio_${messageId}.ogg`;
      base.mediaMime = 'audio/ogg';
      await this.handler(base);
      return;
    }

    // 其它类型首版忽略
    log.feishu.debug({ msgType }, '忽略未支持的飞书消息类型');
  }
}

/**
 * 解析飞书富文本(post)为纯文本。
 * content 形如 { title, content: [[{tag,text|href|user_name}, ...], ...] }，
 * 按行拼接，链接保留可读文字/URL，@ 保留人名。
 */
function extractPostText(content: any): string {
  const lines: string[] = [];
  if (content?.title) lines.push(String(content.title));
  const body = Array.isArray(content?.content) ? content.content : [];
  for (const line of body) {
    if (!Array.isArray(line)) continue;
    let buf = '';
    for (const node of line) {
      switch (node?.tag) {
        case 'text':
          buf += node.text || '';
          break;
        case 'a':
          buf += node.text ? `${node.text}(${node.href || ''})` : node.href || '';
          break;
        case 'at':
          buf += `@${node.user_name || node.user_id || ''}`;
          break;
        default:
          if (typeof node?.text === 'string') buf += node.text;
      }
    }
    lines.push(buf);
  }
  return lines.join('\n').trim();
}
