import './test-env.js';
// B: which animal a fact is about, whether a clip fits it, and the alt text built from what the clip shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANIMALS, subjectOf, clipFits, altTextFor } from './auto-pairing.js';
import { ANIMAL_TAGS, SHOW_TAGS } from './clip-library.js';

const idea = (title, ...claims) => ({ id: 'i', title, claims: claims.map((text) => ({ text })) });
const clip = (...tags) => ({ id: 'c', shows: { tags, by: 'x', at: '2026-11-17T00:00:00Z', notes: '' } });
const key = (i) => subjectOf(i)?.key ?? null;

test('every animal the brief names is in the table, with word forms (singular, plural, variants)', () => {
  const cases = { lion: 'lions', elephant: 'elephants', buffalo: 'buffaloes', zebra: 'zebras', hippo: 'hippopotamus', wildebeest: 'gnu', crocodile: 'crocs', giraffe: 'giraffes', cheetah: 'cheetahs', leopard: 'leopards', hyena: 'hyaenas', rhino: 'rhinoceros',
    'wild dog': 'painted dogs', baboon: 'baboons', monkey: 'colobus', antelope: 'impala', warthog: 'warthogs', jackal: 'jackals', serval: 'servals', caracal: 'caracals', pangolin: 'pangolins', aardvark: 'aardvarks', 'honey badger': 'honey badgers', mongoose: 'mongooses',
    chimpanzee: 'chimps', bird: 'birds', flamingo: 'flamingos', eagle: 'eagles', vulture: 'vultures', ostrich: 'ostriches', stork: 'storks', heron: 'herons', kingfisher: 'kingfishers', hornbill: 'hornbills', whale: 'whales', 'whale shark': 'whale sharks', dolphin: 'dolphins', turtle: 'turtles', shark: 'sharks', ray: 'manta rays', dugong: 'dugongs', octopus: 'octopuses', coral: 'corals', fish: 'fish' };
  for (const [k, word] of Object.entries(cases)) assert.equal(key(idea(`About ${word} here`, 'x')), k, `${k} / ${word}`);
  for (const w of ['gazelle', 'eland', 'kudu', 'oryx', 'topi', 'hartebeest', 'dik-dik']) assert.equal(key(idea(`The ${w} lives`, 'x')), 'antelope', w);
  assert.equal(key(idea('A lioness hunts', 'x')), 'lion'); assert.equal(key(idea('WILDEBEESTS cross', 'x')), 'wildebeest'); assert.equal(key(idea('Lion', 'x')), 'lion');
  assert.ok(ANIMALS.length >= 35);
});
test('every animal tag of the clip vocabulary is reachable from some animal, and no animal points at a tag outside the vocabulary', () => {
  const tags = new Set(ANIMALS.map((a) => a.tag).filter(Boolean));
  for (const t of ANIMAL_TAGS) assert.ok(tags.has(t), `tag ${t} has an animal`);
  for (const t of tags) assert.ok(SHOW_TAGS.includes(t), `${t} is a real tag`);
});
test('whole words only: lionfish is not a lion; "big five" is not an animal; a place name like Buffalo Springs is the accepted limit', () => {
  assert.equal(key(idea('The lionfish is invasive', 'x')), null);
  assert.equal(key(idea('Seeing the big five in Tanzania', 'The big five are a list.')), null);
  assert.equal(key(idea('Elephantine task', 'Zebrafish study')), null);
  assert.equal(key(idea('Buffalo Springs reserve', 'x')), 'buffalo', 'accepted limit: a place name that contains an animal word counts as that animal');
});
test('whale shark beats whale and shark at the same place; the earliest animal in the text wins, not the table order', () => {
  assert.equal(key(idea('Whale sharks visit', 'x')), 'whale shark');
  assert.equal(key(idea('Zebras and lions share the plain', 'x')), 'zebra'); assert.equal(key(idea('Lions and zebras share the plain', 'x')), 'lion');
});
test('subjectOf: the title first, then the claim texts in order; no animal named = no subject', () => {
  assert.equal(key(idea('Elephants in the park', 'A lion was seen.')), 'elephant');
  assert.equal(key(idea('Tanzania tourist visa fee', 'The fee is 50 US dollars.', 'Zebras are not required to pay.', 'A hippo.')), 'zebra');
  assert.equal(subjectOf(idea('Tanzania tourist visa fee', 'The fee is 50 US dollars.')), null);
  assert.equal(subjectOf({ id: 'x' }), null); assert.equal(subjectOf(null), null); assert.equal(subjectOf({ title: 42, claims: [null, { text: 7 }] }), null);
});
test('clipFits: needs a subject, reviewer tags, and the subject tag among them; scene tags never match alone; a clip without shows fits nothing', () => {
  const lion = idea('Lions of the Serengeti', 'x');
  assert.equal(clipFits(lion, clip('lion', 'elephant')), true); assert.equal(clipFits(lion, clip('elephant')), false);
  assert.equal(clipFits(lion, clip('savanna', 'landscape')), false, 'scene tags never match by themselves');
  assert.equal(clipFits(lion, { id: 'c' }), false); assert.equal(clipFits(lion, { id: 'c', shows: { tags: [] } }), false); assert.equal(clipFits(lion, { id: 'c', shows: null }), false);
  assert.equal(clipFits(lion, { id: 'c', shows: { tags: ['lion'] } }), false, 'a record without "by" is not a reviewer record');
  assert.equal(clipFits(lion, { id: 'c', subject: 'lion' }), false, 'the unreliable subject field is never used');
  assert.equal(clipFits(idea('Tanzania visa fee', 'x'), clip('lion')), false, 'no subject');
  assert.equal(clipFits(idea('Baboons raid', 'x'), clip('lion', 'bird', 'zebra')), false, 'an animal no tag covers never fits');
  assert.equal(clipFits(idea('Flamingos at the lake', 'x'), clip('bird')), false, 'a named bird kind is not the generic bird tag');
  assert.equal(clipFits(idea('Birds of the wetland', 'x'), clip('zebra', 'bird', 'wetland')), true);
  assert.equal(clipFits(idea('Wild dogs hunt', 'x'), clip('wild-dog')), true);
  assert.equal(clipFits(null, clip('lion')), false); assert.equal(clipFits(lion, null), false);
});
test('altTextFor: from the clip tags, animals first then scenes, truthful to the footage and silent', () => {
  assert.equal(altTextFor(clip('lion', 'elephant'), 'Lion rules'), 'Short silent video of a lion and elephants with the text: Lion rules');
  assert.equal(altTextFor(clip('zebra', 'bird', 'wetland'), 'H'), 'Short silent video of zebras, birds and a wetland with the text: H');
  assert.equal(altTextFor(clip('savanna', 'lion'), 'H'), 'Short silent video of a lion and the savanna with the text: H');
  assert.equal(altTextFor(clip('wildebeest', 'crocodile', 'river-crossing'), 'H'), 'Short silent video of wildebeest, a crocodile and a river crossing with the text: H');
  for (const t of SHOW_TAGS) assert.match(altTextFor(clip(t), 'H'), /^Short silent video of .+ with the text: H$/, t);
  assert.equal(altTextFor({ id: 'c' }, 'H'), null, 'no tags, no phrase: the caller keeps its fallback');
});
