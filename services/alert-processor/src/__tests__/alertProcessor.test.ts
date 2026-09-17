import { AlertProcessor } from '../alertProcessor';
import { PostgresClient, ZoneAlertRow } from '../postgresClient';
import { ZoneAlert } from '../types';

/**
 * Tests the real AlertProcessor. The previous version of this suite declared its own
 * one-method AlertProcessor inside the test file and asserted against that, which is why
 * the alert-processor lcov report read LH:0 for every source file (D4).
 *
 * Redis and Postgres are substituted at their client boundaries, not at the class boundary,
 * so every line of AlertProcessor under test is the shipped one.
 */

/** In-memory stand-in for the Redis list commands AlertProcessor uses. */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const client = {
    lPush: jest.fn(async (key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    }),
    lTrim: jest.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) ?? [];
      lists.set(key, list.slice(start, stop + 1));
      return 'OK';
    })
  };
  return { lists, client: client as any, raw: client };
}

class CapturingPostgresClient extends PostgresClient {
  public rows: ZoneAlertRow[] = [];
  public failWith: Error | null = null;

  async insertAlert(row: ZoneAlertRow): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.rows.push(row);
  }
}

const alert = (overrides: Partial<ZoneAlert> = {}): ZoneAlert => ({
  zoneId: 'Z-0007',
  previousState: 'STRESSED',
  currentState: 'CRITICAL',
  avg1m: 0.93,
  avg5m: 0.84,
  timestamp: 1_700_000_000_000,
  ...overrides
});

describe('AlertProcessor', () => {
  it('writes the alert to Postgres with the column mapping the schema expects', async () => {
    const postgres = new CapturingPostgresClient();
    const redis = fakeRedis();
    await new AlertProcessor(redis.client, postgres).persistAlert(alert());

    expect(postgres.rows).toEqual([
      {
        zone_id: 'Z-0007',
        previous_state: 'STRESSED',
        current_state: 'CRITICAL',
        avg1m: 0.93,
        avg5m: 0.84,
        timestamp: 1_700_000_000_000
      }
    ]);
  });

  it('pushes to both the per-zone list and the global list', async () => {
    const postgres = new CapturingPostgresClient();
    const redis = fakeRedis();
    await new AlertProcessor(redis.client, postgres).persistAlert(alert());

    expect([...redis.lists.keys()].sort()).toEqual(['alerts:global', 'alerts:zone:Z-0007']);

    const global: ZoneAlert = JSON.parse(redis.lists.get('alerts:global')![0]);
    expect(global.zoneId).toBe('Z-0007');

    // The per-zone entry omits zoneId — the key already carries it.
    const perZone = JSON.parse(redis.lists.get('alerts:zone:Z-0007')![0]);
    expect(perZone).toEqual({
      previousState: 'STRESSED',
      currentState: 'CRITICAL',
      avg1m: 0.93,
      avg5m: 0.84,
      timestamp: 1_700_000_000_000
    });
    expect(perZone.zoneId).toBeUndefined();
  });

  it('keeps the newest alert at the head of each list', async () => {
    const postgres = new CapturingPostgresClient();
    const redis = fakeRedis();
    const processor = new AlertProcessor(redis.client, postgres);

    await processor.persistAlert(alert({ timestamp: 1 }));
    await processor.persistAlert(alert({ timestamp: 2 }));

    const head: ZoneAlert = JSON.parse(redis.lists.get('alerts:global')![0]);
    expect(head.timestamp).toBe(2);
  });

  it('trims both lists to their configured caps', async () => {
    const postgres = new CapturingPostgresClient();
    const redis = fakeRedis();
    await new AlertProcessor(redis.client, postgres).persistAlert(alert());

    expect(redis.raw.lTrim).toHaveBeenCalledWith('alerts:zone:Z-0007', 0, 99);
    expect(redis.raw.lTrim).toHaveBeenCalledWith('alerts:global', 0, 999);
  });

  it('rejects when the Postgres write fails, and does not touch Redis', async () => {
    const postgres = new CapturingPostgresClient();
    postgres.failWith = new Error('relation "zone_alerts" does not exist');
    const redis = fakeRedis();

    await expect(
      new AlertProcessor(redis.client, postgres).persistAlert(alert())
    ).rejects.toThrow('relation "zone_alerts" does not exist');

    expect(redis.raw.lPush).not.toHaveBeenCalled();
  });

  it('treats Redis as best-effort: a Redis failure does not fail the message', async () => {
    const postgres = new CapturingPostgresClient();
    const client = {
      lPush: jest.fn().mockRejectedValue(new Error('READONLY replica')),
      lTrim: jest.fn()
    } as any;

    // Postgres already has the durable copy, so losing the recent-alerts cache entry is
    // acceptable; failing the message here would replay a Postgres insert that succeeded.
    await expect(new AlertProcessor(client, postgres).persistAlert(alert())).resolves.toBeUndefined();
    expect(postgres.rows).toHaveLength(1);
  });
});
