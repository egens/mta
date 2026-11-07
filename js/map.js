// Карта города (procmap.js): через неё ходят физика, полиция, трафик и HUD.
// Физика, полиция и HUD обращаются к карте только через MAP.impl.
export const MAP = { kind: 'proc', impl: null };
export function useMap(kind, impl) { MAP.kind = kind; MAP.impl = impl; }
