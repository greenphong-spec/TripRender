import type { StyleSpecification } from 'maplibre-gl';
import type { MapStyleId } from '../settings';

// Free online basemaps; none needs an API key (§6.1).
export const MAP_STYLES: Record<MapStyleId, string | StyleSpecification> = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  streets: 'https://tiles.openfreemap.org/styles/liberty',
  satellite: {
    version: 8,
    sources: {
      esri: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
  },
};

/** Used when the online style cannot be loaded: track and markers still render. */
export const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eceee8' } }],
};
