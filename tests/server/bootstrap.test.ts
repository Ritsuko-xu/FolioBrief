/** Integration test for shared server/bootstrap.ts startup, ephemeral port binding, static SPA serving, and clean shutdown. */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFolioBriefServer, type RunningFolioServer } from '../../server/bootstrap.ts';

describe('startFolioBriefServer', () => {
  let tmpDir: string | null = null;
  let running: RunningFolioServer | null = null;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = null;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('binds an ephemeral loopback port, serves static dist and API health, and closes cleanly', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foliobrief-boot-'));
    const dataDir = path.join(tmpDir, 'data');
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>FolioBrief</body></html>');

    running = await startFolioBriefServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      distDir,
      envPaths: [],
      useViteDevMiddleware: false,
    });

    expect(running.port).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dataDir, 'foliobrief.db'))).toBe(true);

    const healthRes = await fetch(`${running.url}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string };
    expect(healthJson.status).toBe('healthy');

    const spaRes = await fetch(`${running.url}/workspace`);
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain('FolioBrief');
  });
});
