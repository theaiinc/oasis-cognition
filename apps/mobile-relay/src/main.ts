import express from 'express';
import path from 'path';
import { SessionService } from './session/session.service';
import { PairingService } from './pairing/pairing.service';
import { RelayService } from './relay/relay.service';
import { createPairingRouter } from './pairing/pairing.controller';
import { createRelayRouter } from './relay/relay.controller';
import { setupVoiceBridge } from './relay/voice-bridge';

const PORT = parseInt(process.env.MOBILE_RELAY_PORT || '8015', 10);
const MOBILE_DIST_PATH = process.env.MOBILE_DIST_PATH
  || path.resolve(__dirname, '../../oasis-mobile/dist');

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// CORS — allow all origins since mobile accesses through tunnel
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pairing-Id');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Wire up services
const sessionService = new SessionService();
const pairingService = new PairingService(sessionService);
const relayService = new RelayService(sessionService);

// API routes
app.use('/pair', createPairingRouter(pairingService));
app.use('/relay', createRelayRouter(relayService));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    pairing: sessionService.getState(),
    uptime: process.uptime(),
  });
});

// SW and manifest must not be cached — they control updates
app.get(['/sw.js', '/workbox-*.js', '/registerSW.js', '/manifest.webmanifest'], (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Hashed assets (/assets/*) are immutable — cache forever
app.use('/assets', express.static(path.join(MOBILE_DIST_PATH, 'assets'), {
  maxAge: '1y',
  immutable: true,
}));

// All other static files (icons, favicon, etc.) — short cache
app.use(express.static(MOBILE_DIST_PATH, {
  maxAge: '5m',
  index: false, // Don't auto-serve index.html — SPA fallback handles it
}));

// SPA fallback — serve index.html with no-cache so updates are immediate
app.get('*', (_req, res) => {
  const indexPath = path.join(MOBILE_DIST_PATH, 'index.html');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Mobile PWA not built. Run: cd apps/oasis-mobile && npm run build' });
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`[MobileRelay] Running on port ${PORT}`);
  console.log(`[MobileRelay] Serving mobile PWA from ${MOBILE_DIST_PATH}`);
});

// Attach WebSocket voice bridge for mobile audio streaming
setupVoiceBridge(server, sessionService);

// Graceful shutdown
const shutdown = () => {
  console.log('[MobileRelay] Shutting down...');
  sessionService.destroy();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
