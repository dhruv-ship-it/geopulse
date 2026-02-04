import { WindowBucket, ZoneWindow } from './types';

/**
 * Efficient time-based window management using bucketing by second
 * Provides O(1) operations for adding events and computing averages
 */
export class TimeWindowManager {
  static readonly WINDOW_1M_SECONDS = 60;
  static readonly WINDOW_5M_SECONDS = 300;

  /**
   * Create a new empty window
   */
  static createWindow(): ZoneWindow {
    return {
      buckets: new Map<number, WindowBucket>(),
      totalSum: 0,
      totalCount: 0
    };
  }

  /**
   * Add a load value to the window at given timestamp
   * Automatically evicts expired buckets
   */
  static addEvent(window: ZoneWindow, timestamp: number, load: number, windowSizeSeconds: number): void {
    const secondTimestamp = Math.floor(timestamp / 1000);
    
    // Evict expired buckets
    this.evictExpiredBuckets(window, secondTimestamp, windowSizeSeconds);
    
    // Add or update bucket
    let bucket = window.buckets.get(secondTimestamp);
    if (!bucket) {
      bucket = {
        timestamp: secondTimestamp,
        sum: 0,
        count: 0
      };
      window.buckets.set(secondTimestamp, bucket);
    }
    
    bucket.sum += load;
    bucket.count += 1;
    window.totalSum += load;
    window.totalCount += 1;
  }

  /**
   * Remove expired buckets from the window
   */
  private static evictExpiredBuckets(window: ZoneWindow, currentSecond: number, windowSizeSeconds: number): void {
    const expirationThreshold = currentSecond - windowSizeSeconds;
    
    for (const [timestamp, bucket] of window.buckets.entries()) {
      if (timestamp <= expirationThreshold) {
        window.totalSum -= bucket.sum;
        window.totalCount -= bucket.count;
        window.buckets.delete(timestamp);
      }
    }
  }

  /**
   * Calculate average value for the window
   */
  static calculateAverage(window: ZoneWindow): number {
    if (window.totalCount === 0) {
      return 0;
    }
    return window.totalSum / window.totalCount;
  }

  /**
   * Get current window size in seconds based on buckets
   */
  static getWindowDurationSeconds(window: ZoneWindow): number {
    if (window.buckets.size === 0) {
      return 0;
    }
    
    const timestamps = Array.from(window.buckets.keys());
    const minTimestamp = Math.min(...timestamps);
    const maxTimestamp = Math.max(...timestamps);
    return maxTimestamp - minTimestamp;
  }
}