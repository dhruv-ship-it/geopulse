import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { ZoneRepository } from '../zoneRepository';

const router = Router();
const GEO_INDEX_KEY = 'zones:geo';

/**
 * Zone API routes
 * Provides read-only access to zone state data stored in Redis
 */

function repo(req: Request): ZoneRepository {
  return new ZoneRepository((req as any).redisClient as RedisClientType);
}

/**
 * Get zones by state
 * GET /zones?state=CRITICAL
 *
 * Reads zone ids from the zones:registry SET and fetches the hashes in one pipeline. The
 * previous implementation used `KEYS zone:Z-*`, which blocks the Redis event loop for an
 * O(keyspace) walk on every request.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { state } = req.query;
    const { zones } = await repo(req).listZones(state as string | undefined);
    res.json(zones);
  } catch (error) {
    console.error('Error fetching zones:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * Get zones near a location
 * GET /zones/near?lat=<lat>&lon=<lon>&radiusKm=<km>
 */
router.get('/near', async (req: Request, res: Response) => {
  try {
    const { lat, lon, radiusKm } = req.query;

    if (!lat || !lon || !radiusKm) {
      return res.status(400).json({
        error: 'Missing required parameters: lat, lon, radiusKm'
      });
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lon as string);
    const radius = parseFloat(radiusKm as string);

    if (isNaN(latitude) || isNaN(longitude) || isNaN(radius)) {
      return res.status(400).json({
        error: 'Invalid parameter values'
      });
    }

    const redisClient = (req as any).redisClient as RedisClientType;

    // GEORADIUS gives us the candidate ids; the hashes then come back in one pipeline
    // instead of one round trip per zone.
    const nearbyZones = await redisClient.geoRadius(
      GEO_INDEX_KEY,
      { longitude, latitude },
      radius,
      'km'
    );

    const zones = await repo(req).getZonesByIds(nearbyZones as unknown as string[]);
    res.json(zones);
  } catch (error) {
    console.error('Error fetching nearby zones:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * Get zone by ID
 * GET /zones/:zoneId
 */
router.get('/:zoneId', async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const zone = await repo(req).getZone(zoneId);

    if (!zone) {
      return res.status(404).json({
        error: 'Zone not found',
        zoneId
      });
    }

    res.json(zone);
  } catch (error) {
    console.error('Error fetching zone:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

export default router;
