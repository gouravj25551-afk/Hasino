import { start } from './http/server.ts';
import { migrateOnBoot } from './db/migrate-on-boot.ts';

// Before the server listens, not after: a container that is already taking
// requests while its schema catches up is the window this closes. A no-op
// unless RUN_MIGRATIONS_ON_BOOT is set, and it exits rather than serving if a
// migration fails — see the module for why that is the safe direction.
await migrateOnBoot();

start();
