import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { initializeDatabase } from './database.js';
import { paymentsRouter } from './routes/payments.js';
import { webhooksRouter } from './routes/webhooks.js';
import { healthRouter } from './routes/health.js';
import { appStoreRouter } from './routes/app-store.js';
import { accountRouter } from './routes/account.js';
import { oauthRouter } from './routes/oauth.js';
import { apiRateLimit, webhookRateLimit } from './middleware/rate-limit.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());

// Cookie parser for session management
app.use(cookieParser());

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS?.split(',') || [];
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Parse JSON bodies (except for webhooks which need raw body)
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For OAuth form submissions

// Initialize SQLite database
initializeDatabase();

// Routes with rate limiting
app.use('/api/health', healthRouter);
app.use('/api/account', apiRateLimit, accountRouter);
app.use('/oauth', apiRateLimit, oauthRouter);
app.use('/.well-known', oauthRouter); // OpenID Connect discovery
app.use('/api/payments', apiRateLimit, paymentsRouter);
app.use('/api/webhooks', webhookRateLimit, webhooksRouter);
app.use('/api/store', apiRateLimit, appStoreRouter);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Payment service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
