// SQLite 版 Baileys authState，替代 useMultiFileAuthState（solution §13）
import type Database from 'better-sqlite3';
import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

export interface SqliteAuthState {
  state: AuthenticationState;
  saveCreds: () => void;
  clear: () => void;
}

export function useSqliteAuthState(db: Database.Database): SqliteAuthState {
  db.exec(
    `CREATE TABLE IF NOT EXISTS WA_AUTH_STATE (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  );

  const getRaw = (k: string): any => {
    const row = db
      .prepare('SELECT value FROM WA_AUTH_STATE WHERE key=?')
      .get(k) as { value: string } | undefined;
    return row ? JSON.parse(row.value, BufferJSON.reviver) : undefined;
  };
  const setRaw = (k: string, v: any): void => {
    db.prepare(
      `INSERT INTO WA_AUTH_STATE(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(k, JSON.stringify(v, BufferJSON.replacer));
  };
  const delRaw = (k: string): void => {
    db.prepare('DELETE FROM WA_AUTH_STATE WHERE key=?').run(k);
  };

  const creds = getRaw('creds') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = getRaw(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value !== undefined) data[id] = value;
          }
          return data;
        },
        set: (data) => {
          for (const type in data) {
            const typed = type as keyof SignalDataTypeMap;
            const entries = (data as any)[type];
            for (const id in entries) {
              const value = entries[id];
              const key = `${typed}-${id}`;
              if (value) setRaw(key, value);
              else delRaw(key);
            }
          }
        },
      },
    },
    saveCreds: () => setRaw('creds', creds),
    clear: () => {
      db.prepare('DELETE FROM WA_AUTH_STATE').run();
    },
  };
}
