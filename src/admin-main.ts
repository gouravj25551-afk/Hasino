/**
 * Entry point for the private admin panel.
 *
 *   npm run admin
 *
 * Separate from src/main.ts on purpose: the public app and the admin panel are
 * two processes that share a database and nothing else. Starting one never
 * starts the other, so there is no configuration under which deploying the
 * public app also deploys the admin panel.
 */
import { startAdmin } from './http/admin-server.ts';

startAdmin();
