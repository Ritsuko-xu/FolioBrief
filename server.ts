/** Express HTTP/SSE entrypoint for web dev/production mode on port 3000. */
import 'dotenv/config';
import path from 'node:path';
import { startFolioBriefServer } from './server/bootstrap.ts';

async function main() {
  const running = await startFolioBriefServer({
    port: Number(process.env.PORT ?? 3000),
    host: '0.0.0.0',
    dataDir: path.resolve(process.cwd(), 'data'),
    distDir: path.resolve(process.cwd(), 'dist'),
    useViteDevMiddleware: process.env.NODE_ENV !== 'production',
  });

  console.log(`FolioBrief running at ${running.url}`);

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('Failed to start FolioBrief server:', err);
  process.exit(1);
});
