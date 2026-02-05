import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';

const router = Router();

/**
 * GET /alerts/:zoneId
 * Returns alerts for a specific zone (newest -> oldest)
 */
router.get('/:zoneId', async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const limit = parseInt((req.query.limit as string) || '100', 10);

    const redisClient = (req as any).redisClient as RedisClientType;
    const key = `alerts:zone:${zoneId}`;

    const items = await redisClient.lRange(key, 0, limit - 1);
    const alerts = items.map(item => JSON.parse(item));

    res.json(alerts);
  } catch (err) {
    console.error('Error fetching zone alerts:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /alerts/recent?limit=20
 * Returns recent global alerts (newest -> oldest)
 */
router.get('/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const redisClient = (req as any).redisClient as RedisClientType;

    const items = await redisClient.lRange('alerts:global', 0, limit - 1);
    const alerts = items.map(item => JSON.parse(item));

    res.json(alerts);
  } catch (err) {
    console.error('Error fetching recent alerts:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /alerts?state=CRITICAL&limit=50
 * Filter global alerts by currentState
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const stateFilter = req.query.state as string | undefined;
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const redisClient = (req as any).redisClient as RedisClientType;

    // Read a reasonable window from global alerts and filter in-app.
    const MAX_SCAN = 1000; // safety cap
    const items = await redisClient.lRange('alerts:global', 0, MAX_SCAN - 1);
    let alerts = items.map(item => JSON.parse(item));

    if (stateFilter) {
      alerts = alerts.filter((a: any) => a.currentState === stateFilter);
    }

    res.json(alerts.slice(0, limit));
  } catch (err) {
    console.error('Error fetching filtered alerts:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;