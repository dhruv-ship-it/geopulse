import { TimeWindowManager } from '../timeWindowManager';
import { ZoneWindow } from '../types';

describe('TimeWindowManager', () => {
  let window: ZoneWindow;

  beforeEach(() => {
    window = TimeWindowManager.createWindow();
  });

  describe('createWindow', () => {
    test('should create empty window with correct defaults', () => {
      const newWindow = TimeWindowManager.createWindow();
      
      expect(newWindow.buckets.size).toBe(0);
      expect(newWindow.totalSum).toBe(0);
      expect(newWindow.totalCount).toBe(0);
    });
  });

  describe('addEvent', () => {
    test('should create bucket for new timestamp', () => {
      const timestamp = 1000000;
      const load = 0.5;
      
      TimeWindowManager.addEvent(window, timestamp, load, 60);
      
      expect(window.buckets.size).toBe(1);
      expect(window.totalSum).toBe(0.5);
      expect(window.totalCount).toBe(1);
      
      const bucket = window.buckets.get(Math.floor(timestamp / 1000));
      expect(bucket).toBeDefined();
      expect(bucket!.sum).toBe(0.5);
      expect(bucket!.count).toBe(1);
    });

    test('should update existing bucket for same timestamp', () => {
      const timestamp = 1000000;
      
      TimeWindowManager.addEvent(window, timestamp, 0.3, 60);
      TimeWindowManager.addEvent(window, timestamp, 0.7, 60);
      
      expect(window.buckets.size).toBe(1);
      expect(window.totalSum).toBe(1.0);
      expect(window.totalCount).toBe(2);
      
      const bucket = window.buckets.get(Math.floor(timestamp / 1000));
      expect(bucket!.sum).toBe(1.0);
      expect(bucket!.count).toBe(2);
    });

    test('should handle out-of-order timestamps correctly', () => {
      const timestamp1 = 1000000;
      const timestamp2 = 999500; // 0.5 seconds earlier
      
      TimeWindowManager.addEvent(window, timestamp1, 0.5, 60);
      TimeWindowManager.addEvent(window, timestamp2, 0.3, 60);
      
      expect(window.buckets.size).toBe(2);
      expect(window.totalSum).toBe(0.8);
      expect(window.totalCount).toBe(2);
    });

    test('should evict expired buckets when window exceeds duration', () => {
      const currentTimestamp = 1000000;
      const expiredTimestamp = 930000; // 70 seconds ago (> 60s window)
      
      // Add expired event
      TimeWindowManager.addEvent(window, expiredTimestamp, 0.5, 60);
      expect(window.buckets.size).toBe(1);
      
      // Add current event (should trigger eviction)
      TimeWindowManager.addEvent(window, currentTimestamp, 0.3, 60);
      
      // Expired bucket should be removed
      expect(window.buckets.size).toBe(1);
      expect(window.buckets.has(Math.floor(expiredTimestamp / 1000))).toBe(false);
      expect(window.totalSum).toBe(0.3);
      expect(window.totalCount).toBe(1);
    });

    test('should update totalSum and totalCount correctly', () => {
      TimeWindowManager.addEvent(window, 1000000, 0.5, 60);
      TimeWindowManager.addEvent(window, 1001000, 0.3, 60);
      TimeWindowManager.addEvent(window, 1002000, 0.2, 60);
      
      expect(window.totalSum).toBe(1.0);
      expect(window.totalCount).toBe(3);
    });
  });

  describe('calculateAverage', () => {
    test('should return 0 for empty window', () => {
      const average = TimeWindowManager.calculateAverage(window);
      expect(average).toBe(0);
    });

    test('should calculate correct average', () => {
      TimeWindowManager.addEvent(window, 1000000, 0.5, 60);
      TimeWindowManager.addEvent(window, 1001000, 0.3, 60);
      TimeWindowManager.addEvent(window, 1002000, 0.2, 60);
      
      const average = TimeWindowManager.calculateAverage(window);
      expect(average).toBeCloseTo(0.333, 3);
    });

    test('should handle decimal values correctly', () => {
      TimeWindowManager.addEvent(window, 1000000, 0.1, 60);
      TimeWindowManager.addEvent(window, 1001000, 0.2, 60);
      
      const average = TimeWindowManager.calculateAverage(window);
      expect(average).toBeCloseTo(0.15, 3);
    });
  });

  describe('getWindowDurationSeconds', () => {
    test('should return 0 for empty window', () => {
      const duration = TimeWindowManager.getWindowDurationSeconds(window);
      expect(duration).toBe(0);
    });

    test('should calculate correct duration for single bucket', () => {
      TimeWindowManager.addEvent(window, 1000000, 0.5, 60);
      
      const duration = TimeWindowManager.getWindowDurationSeconds(window);
      expect(duration).toBe(0);
    });

    test('should calculate correct duration for multiple buckets', () => {
      TimeWindowManager.addEvent(window, 1000000, 0.5, 60);
      TimeWindowManager.addEvent(window, 1005000, 0.3, 60);
      
      const duration = TimeWindowManager.getWindowDurationSeconds(window);
      expect(duration).toBe(5);
    });

    test('should handle buckets in reverse order', () => {
      TimeWindowManager.addEvent(window, 1005000, 0.5, 60);
      TimeWindowManager.addEvent(window, 1000000, 0.3, 60);
      
      const duration = TimeWindowManager.getWindowDurationSeconds(window);
      expect(duration).toBe(5);
    });
  });

  describe('window reset after inactivity', () => {
    test('should handle window reset when all buckets expire', () => {
      const oldTimestamp = 600000; // 400 seconds ago (> 300s window)
      const currentTimestamp = 1000000;
      
      // Add old event
      TimeWindowManager.addEvent(window, oldTimestamp, 0.5, 60);
      expect(window.buckets.size).toBe(1);
      
      // Add current event that evicts old one
      TimeWindowManager.addEvent(window, currentTimestamp, 0.3, 300);
      
      // Window should only have current event
      expect(window.buckets.size).toBe(1);
      expect(window.totalSum).toBe(0.3);
      expect(window.totalCount).toBe(1);
    });
  });

  describe('edge cases', () => {
    test('should handle boundary timestamp values', () => {
      const boundaryTimestamp = 1000999;
      
      TimeWindowManager.addEvent(window, boundaryTimestamp, 0.5, 60);
      
      expect(window.buckets.has(Math.floor(boundaryTimestamp / 1000))).toBe(true);
      expect(window.totalSum).toBe(0.5);
      expect(window.totalCount).toBe(1);
    });

    test('should handle zero load values', () => {
      TimeWindowManager.addEvent(window, 1000000, 0, 60);
      
      expect(window.totalSum).toBe(0);
      expect(window.totalCount).toBe(1);
      
      const average = TimeWindowManager.calculateAverage(window);
      expect(average).toBe(0);
    });

    test('should handle negative load values', () => {
      TimeWindowManager.addEvent(window, 1000000, -0.5, 60);
      
      expect(window.totalSum).toBe(-0.5);
      expect(window.totalCount).toBe(1);
      
      const average = TimeWindowManager.calculateAverage(window);
      expect(average).toBe(-0.5);
    });
  });
});
