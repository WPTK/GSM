import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger, morganLoggerStream } from './services/logger.js';
import { mountStaticFrontend } from './services/staticFrontend.js';
import { getDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import healthRouter from './routes/health.js';
import sessionRouter from './routes/session.js';
import repositoriesRouter from './routes/repositories.js';
import releasesRouter from './routes/releases.js';
import categoriesRouter from './routes/categories.js';
import configsRouter from './routes/configs.js';
import syncRouter from './routes/sync.js';
import proxyRouter from './routes/proxy.js';
import imgRouter from './routes/img.js';
import egressRouter from './routes/egress.js';
import logsRouter from './routes/logs.js';
import mcpAdminRouter from './routes/mcp.js';
import aiRouter from './routes/ai.js';
import { mountMcpRoutes } from './mcp/http.js';
import { validateModelsOrExit } from './ai/startup.js';
import { startBatchPoller } from './ai/batchPoller.js';
import { resumeCreditProbeSchedule } from './ai/creditState.js';
import { resumeJobsOnBoot } from './ai/jobs.js';

/**
 * Helmet's default `upgrade-insecure-requests` rewrites the SPA's own http://
 * assets to https://, so plain HTTP deployments (e.g. `http://<lan-ip>:3000`)
 * fail every script with ERR_SSL_PROTOCOL_ERROR and stay blank. Browsers ignore
 * HSTS received over HTTP, so only this directive needs an opt-out.
 */
function shouldUpgradeInsecureRequests(): boolean {
  return !/^(0|false|no)$/i.test(process.env.CSP_UPGRADE_INSECURE_REQUESTS?.trim() ?? '');
}

/**
 * Creates and configures the Express application instance with security headers,
 * proxy trust settings, rate limiting, and all backend API and static routes.
 *
 * @returns Configured Express application.
 */
morgan.token('safe-path', (req) => ((req as { originalUrl?: string }).originalUrl ?? req.url ?? '').split('?')[0]);
morgan.token('safe-referrer', (req) => {
  const ref = req.headers.referer ?? req.headers.referrer;
  return typeof ref === 'string' ? ref.split('?')[0].split('#')[0] : '-';
});
export const ACCESS_LOG_FORMAT =
  ':remote-addr - :remote-user [:date[clf]] ":method :safe-path HTTP/:http-version" :status :res[content-length] ":safe-referrer" ":user-agent"';

export function createApp(): express.Express {
  const app = express();
  const upgradeInsecureRequests = shouldUpgradeInsecureRequests();

  // The browser talks only to this origin: connect-src is 'self'. Images may come
  // from any https host because the UI shows non-GitHub README images only after
  // the user clicks "Load images"; GitHub-hosted images go through /api/img.
  // style-src keeps 'unsafe-inline' (and nothing else) because the app injects
  // <style> elements at runtime (theme presets, bilingual README view, mermaid
  // SVG output). Scripts stay strictly 'self'.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'connect-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'", 'data:'],
          ...(upgradeInsecureRequests ? {} : { 'upgrade-insecure-requests': null }),
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  // Access log: path only. Query strings can carry secrets (signed image URLs, search terms),
  // and Referer headers can carry them too, so neither is ever logged.
  app.use(morgan(ACCESS_LOG_FORMAT, { stream: morganLoggerStream }));

  // TRUST_PROXY (default: off). Set it only when a reverse proxy you control sits in front, so
  // req.ip and the https/Secure-cookie detection come from its X-Forwarded-* headers. Accepts
  // 'true', 'false', a hop count ('1'), or an Express trust-proxy value such as 'loopback' or a
  // CIDR list. The front proxy must also preserve the Host header: the CSRF check compares
  // Origin with Host. Revisit in Phase 4 (deployment).
  if (process.env.TRUST_PROXY) {
    const rawTrustProxy = process.env.TRUST_PROXY.trim();
    if (rawTrustProxy === 'true') {
      app.set('trust proxy', true);
    } else if (rawTrustProxy === 'false') {
      app.set('trust proxy', false);
    } else if (/^\d+$/.test(rawTrustProxy)) {
      app.set('trust proxy', parseInt(rawTrustProxy, 10));
    } else {
      app.set('trust proxy', rawTrustProxy);
    }
  } else {
    app.set('trust proxy', false);
  }

  // Global rate limiter to protect database and endpoints from DoS before body parsing
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
  });
  app.use(limiter);

  // Auth runs before any body is parsed, so unauthenticated callers cannot make
  // the server buffer large payloads. Public paths: /api/health, /api/auth/*.
  app.use('/api', authMiddleware);

  // The translate relay reads its own small raw body (see routes/egress.ts).
  const jsonParser = express.json({ limit: '50mb' });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/translate/')) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });

  // Routes
  app.use(healthRouter);
  app.use(sessionRouter);

  // Wave 2: Data CRUD routes
  app.use(repositoriesRouter);
  app.use(releasesRouter);
  app.use(categoriesRouter);
  app.use(configsRouter);
  app.use(syncRouter);

  // Wave 3: Proxy routes
  app.use(proxyRouter);
  app.use(aiRouter);
  app.use(imgRouter);
  app.use(egressRouter);

  // Wave 4: Logs route
  app.use(logsRouter);

  // MCP admin API (protected by API_SECRET via /api middleware above)
  app.use(mcpAdminRouter);

  // MCP Streamable HTTP + legacy SSE (own token auth; not under /api)
  // Mount always; each request is gated on live SQLite settings (no write on mount).
  mountMcpRoutes(app);

  // Full-stack images opt in through STATIC_DIR. Standalone backend deployments
  // leave it unset, preserving the previous API-only behavior.
  mountStaticFrontend(app);

  // Global error handler
  app.use(errorHandler);

  return app;
}

async function startServer(): Promise<void> {
  // Initialize database
  const db = getDb();
  runMigrations(db);
  logger.info('server.init', 'Database initialized');

  // Fail closed: no key or an unknown model ID means the server does not listen.
  await validateModelsOrExit();

  const app = createApp();

  const server = app.listen(config.port, () => {
    logger.info('server.start', `Server running on port ${config.port}`);
    startBatchPoller();
    resumeCreditProbeSchedule();
    resumeJobsOnBoot();
    if (!config.apiSecret) {
      logger.warn('server.auth', 'Running without API_SECRET — auth is disabled');
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('server.shutdown', 'Shutting down...');
    server.close(() => {
      closeDb();
      logger.info('server.shutdown', 'Server stopped');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only start server when run directly (not imported for tests)
const isMainModule =
  process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMainModule) {
  void startServer();
}
