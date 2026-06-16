// 分模块 pino logger
import pino from 'pino';
import { config } from './config';

const root = pino({
  level: config.logLevel,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino/file', // 开发期也走标准输出，避免额外依赖 pino-pretty
          options: { destination: 1 },
        },
});

export function createLogger(module: string) {
  return root.child({ module });
}

export const log = {
  root,
  wa: createLogger('wa'),
  feishu: createLogger('feishu'),
  bridge: createLogger('bridge'),
  db: createLogger('db'),
};
