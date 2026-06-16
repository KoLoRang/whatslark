// 简单的按键串行锁：同一 key 的异步操作排队执行，避免并发重复建群/建话题
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 记录“静默版”链尾用于排队；完成后若仍是自己则清理，避免 Map 无限增长
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(key, tail);
    tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }
}
