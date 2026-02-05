import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'sensor-simulator',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
