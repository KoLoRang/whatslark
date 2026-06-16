// 飞书 Lark.Client 封装：建群/建话题群/发文本/话题回复/媒体上传/改群名
import * as Lark from '@larksuiteoapi/node-sdk';
import { Readable } from 'stream';
import { log } from '../logger';

export interface CreateChatResult {
  chatId: string;
}
export interface RootMessageResult {
  messageId: string;
  threadId: string;
}

export class FeishuClient {
  private client: Lark.Client;

  constructor(
    public readonly appId: string,
    private readonly appSecret: string,
    private readonly myOpenId: string
  ) {
    this.client = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
  }

  // 普通群（每个 WA 群一个）
  async createGroupChat(name: string): Promise<string> {
    const res = await this.client.im.v1.chat.create({
      params: { user_id_type: 'open_id' },
      data: {
        name,
        chat_mode: 'group',
        user_id_list: this.myOpenId ? [this.myOpenId] : [],
      },
    });
    const chatId = res.data?.chat_id;
    if (!chatId) throw new Error('createGroupChat 未返回 chat_id');
    return chatId;
  }

  // 私聊归集话题群（全局建一次）
  async createTopicChat(name: string): Promise<string> {
    const res = await this.client.im.v1.chat.create({
      params: { user_id_type: 'open_id' },
      data: {
        name,
        chat_mode: 'topic',
        user_id_list: this.myOpenId ? [this.myOpenId] : [],
      },
    });
    const chatId = res.data?.chat_id;
    if (!chatId) throw new Error('createTopicChat 未返回 chat_id');
    return chatId;
  }

  async updateChatName(chatId: string, name: string): Promise<void> {
    await this.client.im.v1.chat.update({
      path: { chat_id: chatId },
      data: { name },
    });
  }

  // 发文本到群，返回 message_id
  async sendText(chatId: string, text: string): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return res.data?.message_id || '';
  }

  // 发话题根消息，返回 {message_id, thread_id}
  async sendThreadRoot(chatId: string, text: string): Promise<RootMessageResult> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return {
      messageId: res.data?.message_id || '',
      threadId: res.data?.thread_id || '',
    };
  }

  // 在话题内回复（reply_in_thread），返回 message_id
  async replyInThread(
    anchorMessageId: string,
    text: string
  ): Promise<string> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: anchorMessageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
        reply_in_thread: true,
      },
    });
    return res.data?.message_id || '';
  }

  // ---------------- 媒体 ----------------
  async uploadImage(buffer: Buffer): Promise<string> {
    const res = await this.client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: buffer,
      },
    });
    const key = res?.image_key;
    if (!key) throw new Error('uploadImage 未返回 image_key');
    return key;
  }

  async uploadFile(
    buffer: Buffer,
    fileName: string,
    mime: string
  ): Promise<string> {
    const res = await this.client.im.v1.file.create({
      data: {
        file_type: pickFileType(mime, fileName),
        file_name: fileName,
        file: buffer,
      },
    });
    const key = res?.file_key;
    if (!key) throw new Error('uploadFile 未返回 file_key');
    return key;
  }

  async sendImage(chatId: string, imageKey: string): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
    return res.data?.message_id || '';
  }

  async sendFile(chatId: string, fileKey: string): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    return res.data?.message_id || '';
  }

  // 注意：音频在飞书侧也是 file 消息类型；sendFile 即可

  async replyImageInThread(
    anchorMessageId: string,
    imageKey: string
  ): Promise<string> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: anchorMessageId },
      data: {
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
        reply_in_thread: true,
      },
    });
    return res.data?.message_id || '';
  }

  async replyFileInThread(
    anchorMessageId: string,
    fileKey: string
  ): Promise<string> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: anchorMessageId },
      data: {
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
        reply_in_thread: true,
      },
    });
    return res.data?.message_id || '';
  }

  // 注意：音频在飞书侧也是 file 消息类型；replyFileInThread 即可

  // 下载飞书消息资源（飞书→WA 媒体用）
  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file'
  ): Promise<Buffer> {
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    // SDK 返回带 getReadableStream / writeFile 的对象
    const stream = (res as any).getReadableStream?.() as Readable | undefined;
    if (!stream) throw new Error('downloadMessageResource 无可读流');
    return streamToBuffer(stream);
  }

  getRawClient(): Lark.Client {
    return this.client;
  }
}

type LarkFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

function pickFileType(mime: string, fileName: string): LarkFileType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'doc';
  if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) return 'xls';
  if (lower.endsWith('.ppt') || lower.endsWith('.pptx')) return 'ppt';
  if (mime.startsWith('audio/opus')) return 'opus';
  if (mime.startsWith('video/mp4')) return 'mp4';
  return 'stream';
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export { Lark };
