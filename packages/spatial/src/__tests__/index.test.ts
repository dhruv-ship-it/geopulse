import * as spatial from '../index';

/**
 * The package's public surface is what the services compile against, so a dropped export is a
 * broken build in another repo directory rather than a failure here. Cheap to pin.
 */
describe('@geopulse/spatial public API', () => {
  it('exports the geometry definition and the graph', () => {
    expect(Object.keys(spatial).sort()).toEqual(
      [
        'EARTH_RADIUS_KM',
        'H3_COARSE_RESOLUTION',
        'H3_RESOLUTION',
        'NEIGHBOUR_RING_SIZE',
        'NeighbourGraph',
        'cellsFor',
        'haversineKm'
      ].sort()
    );
  });

  it('builds a working graph through the entry point alone', () => {
    const graph = new spatial.NeighbourGraph({ resolution: spatial.H3_RESOLUTION, ringSize: 1 });
    graph.build([
      { zoneId: 'Z-1', latitude: 28.6, longitude: 77.2 },
      { zoneId: 'Z-2', latitude: 28.61, longitude: 77.21 }
    ]);

    expect(graph.neighboursOf('Z-1')).toEqual(['Z-2']);
  });
});
