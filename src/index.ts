// 服务入口：初始化 DB → 装配 App → 启动配置监听
import { config } from './config';
import { log } from './logger';
import { initDb } from './db';
import { App } from './app';
import { startMonitor } from './monitor';

async function main(): Promise<void> {
  log.root.info({ dbPath: config.dbPath }, 'WhatsLark 启动中…');
  const db = initDb(config.dbPath);
  const app = new App(db);
  await app.start();
  const stopMonitor = startMonitor(app);

  const shutdown = (sig: string) => {
    log.root.info({ sig }, '收到退出信号，正在关闭…');
    stopMonitor();
    app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) =>
    log.root.error({ err: e }, 'unhandledRejection')
  );
  process.on('uncaughtException', (e) =>
    log.root.error({ err: e }, 'uncaughtException')
  );
}

main().catch((e) => {
  log.root.error({ err: e }, '启动失败');
  process.exit(1);
});
