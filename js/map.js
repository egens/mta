// Активная карта: процедурный город (procmap.js) или Москва из OpenStreetMap (osm.js).
// Физика, полиция и HUD обращаются к карте только через MAP.impl.
export const MAP = { kind: 'proc', impl: null };
export function useMap(kind, impl) { MAP.kind = kind; MAP.impl = impl; }
