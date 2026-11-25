/** Shared Express/SQLite server bootstrapper used by both standalone web CLI and the Electron macOS desktop shell. */
import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { AppLogger } from './logger.ts';
import { FileStorageManager } from './storage.ts';
import { FolioDatabase } from './db.ts';
import { createApp } from './app.ts';

export interface FolioServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  distDir?: string;
  envPaths?: string[];
  useViteDevMiddleware?: boolean;
}

export interface RunningFolioServer {
  port: number;
  url: string;
  dataDir: string;
  db: FolioDatabase;
  storage: FileStorageManager;
  logger: AppLogger;
  close: () => Promise<void>;
}

/** Boots storage, SQLite WAL database, job recovery, Express API, and Vite/static frontend serving. */
export async function startFolioBriefServer(
  options: FolioServerOptions = {}
): Promise<RunningFolioServer> {
  const envPaths = options.envPaths ?? [path.resolve(process.cwd(), '.env')];
  for (const envPath of envPaths) {
    if (envPath && fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
    }
  }

  const requestedPort = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? '0.0.0.0';
  const dataDir = options.dataDir ?? path.resolve(process.cwd(), 'data');
  const distDir = options.distDir ?? path.resolve(process.cwd(), 'dist');
  const useViteDev = options.useViteDevMiddleware ?? process.env.NODE_ENV !== 'production';

  const storage = new FileStorageManager(dataDir);
  const logger = new AppLogger(storage.logsDir);
  const db = new FolioDatabase(path.join(dataDir, 'foliobrief.db'), logger);

  const recoveredCount = db.recoverInterruptedJobs();
  if (recoveredCount > 0) {
    logger.warn('startup', `Recovered ${recoveredCount} interrupted analysis job(s) from prior session`, {
      recoveredCount,
    });
  }

  const app = createApp({ db, storage, logger });

  if (useViteDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = await new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(requestedPort, host, () => resolve(srv));
    srv.on('error', reject);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${displayHost}:${actualPort}`;

  logger.info('startup', `FolioBrief server listening on ${url}`, { dataDir });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    db.close();
  };

  return {
    port: actualPort,
    url,
    dataDir,
    db,
    storage,
    logger,
    close,
  };
}
