import { Router, Request, Response } from 'express';
import { PostgresClient } from '../postgresClient';

const router = Router();

// Middleware to attach Postgres client
router.use((req, res, next) => {
  next();
});

/**
 * GET /analytics/zones/:zoneId/alerts?from=&to=
 * Returns alert history for a specific zone within time range
 */
router.get('/zones/:zoneId/alerts', async (req: Request, res: Response) => {
  try {
    const zoneId = req.params.zoneId as string;
    const from = parseInt((req.query.from as string) || '0', 10);
    const to = parseInt((req.query.to as string) || Date.now().toString(), 10);
    
    const postgresClient = (req as any).postgresClient as PostgresClient;
    
    const alerts = await postgresClient.getZoneAlerts(zoneId, from, to);
    
    // Transform to API response format
    const response = alerts.map(alert => ({
      previousState: alert.previous_state,
      currentState: alert.current_state,
      avg1m: alert.avg1m,
      avg5m: alert.avg5m,
      timestamp: alert.timestamp
    }));
    
    res.json(response);
  } catch (err) {
    console.error('Error fetching zone analytics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /analytics/alerts/recent?limit=50
 * Returns recent global alerts (newest first)
 */
router.get('/alerts/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string || '50', 10);
    const postgresClient = (req as any).postgresClient as PostgresClient;
    
    const alerts = await postgresClient.getRecentAlerts(limit);
    
    // Transform to API response format
    const response = alerts.map(alert => ({
      zoneId: alert.zone_id,
      previousState: alert.previous_state,
      currentState: alert.current_state,
      avg1m: alert.avg1m,
      avg5m: alert.avg5m,
      timestamp: alert.timestamp
    }));
    
    res.json(response);
  } catch (err) {
    console.error('Error fetching recent alerts:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /analytics/zones/top-critical?days=7
 * Returns zones sorted by number of CRITICAL alerts
 */
router.get('/zones/top-critical', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string || '7', 10);
    const postgresClient = (req as any).postgresClient as PostgresClient;
    
    const results = await postgresClient.getTopCriticalZones(days);
    
    res.json(results);
  } catch (err) {
    console.error('Error fetching top critical zones:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
