// 跨模块共享类型

export type SyncDirection = 'wa2fs' | 'fs2wa';

// 飞书业务配置（存 APP_CONFIG 单行）
export interface AppConfig {
  id: string; // 固定 'default'
  app_id: string;
  app_secret: string;
  my_open_id: string;
  bot_open_id: string;
  private_agg_chat_id: string; // 私聊归集话题群 chat_id（全局唯一）
  updated_at: number;
}

// 群映射（WA 群 <-> 飞书群，一对一）
export interface GroupMapping {
  wa_jid: string;
  feishu_chat_id: string;
  wa_group_name: string;
  created_at: number;
}

// 私聊话题映射（所有私聊归集到同一 chat_id，靠 thread_id 区分）
export interface PrivateThreadMapping {
  wa_jid: string;
  feishu_chat_id: string;
  thread_id: string;
  anchor_message_id: string;
  contact_name: string;
  created_at: number;
}

// 规范化后的入站消息（来自 WA 或飞书），交给 router
export interface NormalizedMessage {
  source: 'wa' | 'feishu';
  // WA: remoteJid；飞书: chat_id
  conversationId: string;
  isGroup: boolean;
  senderName: string;
  // 文本内容（媒体时为 caption）
  text: string;
  // 媒体类型
  mediaType?: 'image' | 'file' | 'audio';
  // 媒体二进制（出站方向用）
  mediaBuffer?: Buffer;
  mediaFileName?: string;
  mediaMime?: string;
  // 去重键（WA messageId / 飞书 message_id）
  dedupKey: string;
  // 飞书侧专用：事件携带的 thread_id
  threadId?: string;
}

export type MediaKind = 'image' | 'file' | 'audio';
