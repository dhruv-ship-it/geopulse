# GeoPulse API Service

Read-only API service that serves current zone state data from Redis.

## Architecture

This service provides a clean separation between computation (stream processor) and serving (API). It reads materialized state from Redis without any recomputation.

## Endpoints

### 1. Get Zone by ID
```
GET /zones/:zoneId
```

Returns detailed information for a specific zone.

**Response:**
```json
{
  "zoneId": "Z-1",
  "state": "STRESSED",
  "avg1m": "0.56",
  "avg5m": "0.84",
  "latitude": 28.61,
  "longitude": 77.20,
  "lastUpdated": "1770201942414"
}
```

### 2. Get Zones by State
```
GET /zones?state=CRITICAL
```

Returns all zones in a specific state. Omit the `state` parameter to get all zones.

**Response:**
```json
[
  {
    "zoneId": "Z-1",
    "state": "CRITICAL",
    "avg1m": "0.92",
    "avg5m": "0.85",
    "latitude": 28.61,
    "longitude": 77.20,
    "lastUpdated": "1770201942414"
  }
]
```

### 3. Get Zones Near Location
```
GET /zones/near?lat=<latitude>&lon=<longitude>&radiusKm=<radius>
```

Returns zones within a specified radius using Redis GEO indexing.

**Response:**
```json
[
  {
    "zoneId": "Z-1",
    "state": "STRESSED",
    "avg1m": "0.56",
    "avg5m": "0.84",
    "latitude": 28.61,
    "longitude": 77.20,
    "lastUpdated": "1770201942414",
    "distanceKm": 0
  }
]
```

### 4. Health Check
```
GET /health
```

Returns service status information.

## Running the Service

### Prerequisites
- Redis running on localhost:6380
- Node.js 18+

### Installation
```bash
cd services/api
npm install
```

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

## Configuration

Environment variables:
- `PORT`: API server port (default: 3000)
- `REDIS_HOST`: Redis host (default: localhost)
- `REDIS_PORT`: Redis port (default: 6380)

## Redis Data Model

The API reads from the following Redis structure:

### Zone Data (HASH)
Key: `zone:Z-1`
Fields:
- `zoneId`: Zone identifier
- `state`: Current state (NORMAL/STRESSED/CRITICAL)
- `avg1m`: 1-minute average load
- `avg5m`: 5-minute average load
- `latitude`: Zone latitude
- `longitude`: Zone longitude
- `lastUpdated`: Last update timestamp

### GEO Index
Key: `zones:geo`
Used for geographic queries with Redis GEO commands.

## Verification

### Check Service Health
```bash
curl http://localhost:3000/health
```

### Get Specific Zone
```bash
curl http://localhost:3000/zones/Z-1
```

### Get All Critical Zones
```bash
curl "http://localhost:3000/zones?state=CRITICAL"
```

### Get Nearby Zones
```bash
curl "http://localhost:3000/zones/near?lat=28.61&lon=77.20&radiusKm=50"
```

## Error Handling

The API returns appropriate HTTP status codes:
- 200: Success
- 400: Bad request (invalid parameters)
- 404: Zone not found
- 500: Internal server error

All errors include a JSON response with error details.