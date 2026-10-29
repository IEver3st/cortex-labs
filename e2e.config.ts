import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{
    engine: web(),
    app: {
      url: process.env.APP_URL ?? 'http://localhost:1420',
      command: { executable: 'bun', args: ['run', 'dev'], log: '.e2e/logs/app.log', reuseExisting: true },
    },
  }],
} satisfies E2EConfig;
