import app from './app.js';
import { env } from './config/env.js';

const port = env.PORT;

app.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   LITERACY TREE CANTEEN - PRODUCTION BACKEND         ║
╠═══════════════════════════════════════════════════════╣
║   🚀 Server running on: http://localhost:${port}      ║
║   💳 Payment provider: ZynlePay                     ║
║   🔐 Authentication: JWT enabled                     ║
╚═══════════════════════════════════════════════════════╝
  `);
});
