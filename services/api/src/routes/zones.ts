import { Router, Request, Response } from 'express';
import { RedisClientType } from 'redis';

const router = Router();
const GEO_INDEX_KEY = 'zones:geo';

/**
 * Zone API routes
 * Provides read-only access to zone state data stored in Redis
 */

/**
 * Get zones by state
 * GET /zones?state=CRITICAL
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { state } = req.query;
    const redisClient = (req as any).redisClient as RedisClientType;
    
    // Get all zone keys
    const zoneKeys = await redisClient.keys('zone:Z-*');
    
    const zones = [];
    for (const zoneKey of zoneKeys) {
      const zoneData = await redisClient.hGetAll(zoneKey);
      if (!state || zoneData.state === state) {
        zones.push({
          zoneId: zoneData.zoneId,
          state: zoneData.state,
          avg1m: zoneData.avg1m,
          avg5m: zoneData.avg5m,
          latitude: parseFloat(zoneData.latitude),
          longitude: parseFloat(zoneData.longitude),
          lastUpdated: zoneData.lastUpdated
        });
      }
    }
    
    // Sort by zone ID
    zones.sort((a, b) => a.zoneId.localeCompare(b.zoneId));
    
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
    
    // Get nearby zones using GEO radius
    const nearbyZones = await redisClient.geoRadius(
      GEO_INDEX_KEY,
      {
        longitude,
        latitude
      },
      radius,
      'km'
    );
    
    const zones = [];
    for (const zoneId of nearbyZones) {
      const zoneKey = `zone:${zoneId}`;
      const zoneData = await redisClient.hGetAll(zoneKey);
      
      if (Object.keys(zoneData).length > 0) {
        zones.push({
          zoneId: zoneData.zoneId,
          state: zoneData.state,
          avg1m: zoneData.avg1m,
          avg5m: zoneData.avg5m,
          latitude: parseFloat(zoneData.latitude),
          longitude: parseFloat(zoneData.longitude),
          lastUpdated: zoneData.lastUpdated,
          distanceKm: 0 // Would need separate calculation
        });
      }
    }
    
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
    const redisClient = (req as any).redisClient as RedisClientType;
    
    const zoneKey = `zone:${zoneId}`;
    const zoneData = await redisClient.hGetAll(zoneKey);
    
    if (Object.keys(zoneData).length === 0) {
      return res.status(404).json({
        error: 'Zone not found',
        zoneId
      });
    }
    
    res.json({
      zoneId: zoneData.zoneId,
      state: zoneData.state,
      avg1m: zoneData.avg1m,
      avg5m: zoneData.avg5m,
      latitude: parseFloat(zoneData.latitude),
      longitude: parseFloat(zoneData.longitude),
      lastUpdated: zoneData.lastUpdated
    });
    
  } catch (error) {
    console.error('Error fetching zone:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

export default router;