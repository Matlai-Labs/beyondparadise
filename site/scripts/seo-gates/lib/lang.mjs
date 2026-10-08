// Multilingual trigger lists (en/de/fr/it/es/pl). Patterns are fragments for wordRe(); keep them lower-case, accents allowed.
export const STARTS_VERBS = [
  'starts?', 'begins?', 'opens?', 'launch(?:es)?', 'commences?', 'will (?:start|begin|open|launch)', 'beginning', 'starting',
  'startet', 'beginnt', 'démarre', 'commence', 'ouvre', 'débute', 'inizia', 'apre',
  'comienza', 'empieza', 'abre', 'rozpoczyna', 'startuje', 'otwiera',
];
export const FUTURE_TENSE = [
  'will', 'upcoming', 'coming (?:soon|up)', 'next year', 'soon', 'planned', 'planning', 'plans? to', 'expected', 'set to', 'scheduled',
  'bald', 'geplant', 'demnächst', 'sera', 'seront', 'bientôt', 'prévu', 'sarà', 'saranno', 'presto', 'previsto',
  'próximamente', 'będzie', 'będą', 'wkrótce', 'planowany',
];
export const RATE_WORDS = [
  'rates?', 'rate card', 'prices?', 'pricing', 'tariffs?', 'fees?', 'costs?', 'tickets?', 'park fees?',
  'preise?', 'gebühren', 'tarife?', 'prix', 'tarifs?', 'frais', 'prezzi', 'tariffe', 'precios', 'tarifas', 'ceny', 'opłaty', 'cennik',
];
export const UPDATED_LABELS = [
  'last updated', 'updated', 'last modified', 'last reviewed', 'updated on', 'zuletzt aktualisiert', 'aktualisiert', 'stand',
  'mis à jour', 'dernière mise à jour', 'mise à jour', 'aggiornato', 'ultimo aggiornamento', 'actualizado', 'última actualización',
  'zaktualizowano', 'ostatnia aktualizacja',
];
