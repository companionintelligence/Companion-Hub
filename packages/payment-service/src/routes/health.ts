import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'payment-service',
    timestamp: new Date().toISOString(),
  });
});
