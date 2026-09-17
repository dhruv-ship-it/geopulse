/**
 * `@geopulse/spatial` — the shared definition of *where* a zone is and *what counts as next to
 * it*.
 *
 * **Why a package rather than a module copied into each service.** Two processes have to agree
 * on this geometry. `stream-processor` computes a zone's H3 cells when it first sees the zone
 * and writes them to the registry; the correlation engine reads that registry and builds
 * adjacency out of those cells. If the two ever disagree — a different resolution, a different
 * ring size, a bug fixed on one side only — nothing fails. Res-5 and res-6 cell ids are both
 * valid; they are simply in different tilings. So every lookup returns empty, every connected
 * component becomes a singleton, and the system reports that nothing in the world is
 * correlated. That failure is invisible in the logs and looks exactly like a quiet day.
 *
 * A copied module makes avoiding that drift a matter of remembering to copy. One package makes
 * the drift impossible to express. The cost is a build step: consumers depend on the built
 * `dist` through `file:../../packages/spatial`, so this package has to be built before a
 * consumer compiles — `npm install` does it via `prepare`. That cost is paid once per change
 * here; the drift would be paid as a silent correctness bug at measurement time.
 *
 * It is a plain `file:` dependency rather than npm workspaces because each service already
 * installs, builds and runs independently, and converting the repo to a workspace would change
 * how every service is built for the sake of one shared module.
 */
export { EARTH_RADIUS_KM, LatLon, haversineKm } from './geo';
export { H3_COARSE_RESOLUTION, H3_RESOLUTION, ZoneCells, cellsFor } from './cells';
export {
  NEIGHBOUR_RING_SIZE,
  NeighbourGraph,
  NeighbourGraphOptions,
  NeighbourGraphStats,
  ZoneLocation
} from './neighbourGraph';
