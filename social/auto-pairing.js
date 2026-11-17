// Pairing of the automatic lane (C2): a fact may only go over footage that fits it. No model, no guessing: the animal a fact is about is the FIRST animal
// its title or claims name (a word table), and a clip fits only when a reviewer recorded that animal among what the clip shows (`shows.tags`, clip-library.js --shows).
//
//   subjectOf(idea)         -> { key, tag } | null     the first animal named: title first, then the claim texts in order
//   clipFits(idea, clip)    -> boolean                 subject exists, clip has reviewer tags, the subject's tag is among them; a clip without `shows` fits nothing
//   altTextFor(clip, hook)  -> string | null           the alt text, built from the tags of the clip
// The manifest field `subject` is unreliable and is never read here. Scene tags (savanna, river ...) never make a match by themselves.
// Known limits, accepted: whole-word matching cannot tell an animal from a place or a name that contains the word ("Buffalo Springs", "Hippo Pools"
// count as that animal); a fact that names two animals is paired on the first one only; "big five" is not an animal and names none.
// `tag` is the clip tag an animal can be paired on, or null when no clip tag covers it (then nothing fits it and it BLOCKS a wrong pairing). Named bird
// kinds (flamingo, eagle ...) are tag null on purpose: the generic `bird` tag does not say which bird the clip shows.

const A = (key, tag, words) => Object.freeze({ key, tag, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, 'giu') });

export const ANIMALS = Object.freeze([
  A('lion', 'lion', 'lions?|lioness(?:es)?'), A('elephant', 'elephant', 'elephants?'), A('buffalo', 'buffalo', 'buffalo(?:es|s)?'), A('zebra', 'zebra', 'zebras?'),
  A('hippo', 'hippo', 'hippos?|hippopotam(?:us|uses|i)'), A('wildebeest', 'wildebeest', 'wildebeests?|gnus?'), A('crocodile', 'crocodile', 'crocodiles?|crocs?'),
  A('giraffe', 'giraffe', 'giraffes?'), A('cheetah', 'cheetah', 'cheetahs?'), A('leopard', 'leopard', 'leopards?'), A('hyena', 'hyena', 'hy(?:a)?enas?'),
  A('rhino', 'rhino', 'rhinos?|rhinoceros(?:es)?|rhinoceri'), A('wild dog', 'wild-dog', 'wild[ -]dogs?|painted (?:dogs?|wolf|wolves)'), A('bird', 'bird', 'birds?'),
  A('baboon', null, 'baboons?'), A('monkey', null, 'monkeys?|colobus(?:es)?|vervets?|galagos?|bushbab(?:y|ies)'), A('chimpanzee', null, 'chimpanzees?|chimps?'),
  A('antelope', null, 'antelopes?|impalas?|gazelles?|elands?|kudus?|oryx(?:es)?|topis?|hartebeests?|dik[- ]diks?|duikers?'), A('warthog', null, 'warthogs?'),
  A('jackal', null, 'jackals?'), A('serval', null, 'servals?'), A('caracal', null, 'caracals?'), A('pangolin', null, 'pangolins?'), A('aardvark', null, 'aardvarks?'),
  A('honey badger', null, 'honey[ -]badgers?|ratels?'), A('mongoose', null, 'mongoose(?:s)?|mongeese'),
  A('flamingo', null, 'flamingos?|flamingoes'), A('eagle', null, 'eagles?'), A('vulture', null, 'vultures?'), A('ostrich', null, 'ostrich(?:es)?'), A('stork', null, 'storks?'),
  A('heron', null, 'herons?'), A('kingfisher', null, 'kingfishers?'), A('hornbill', null, 'hornbills?'),
  A('whale shark', null, 'whale[ -]sharks?'), A('whale', null, 'whales?'), A('dolphin', null, 'dolphins?'), A('turtle', null, 'turtles?'), A('shark', null, 'sharks?'),
  A('ray', null, '(?:manta |eagle |sting)?rays?'), A('dugong', null, 'dugongs?'), A('octopus', null, 'octopus(?:es)?|octopi'), A('coral', null, 'corals?'), A('fish', null, 'fish(?:es)?'),
]);

const first = (text) => {
  let best = null;
  for (const a of ANIMALS) { a.re.lastIndex = 0; const m = a.re.exec(text); if (m && (!best || m.index < best.at || (m.index === best.at && m[0].length > best.len))) best = { a, at: m.index, len: m[0].length }; }
  return best && best.a;
};

export function subjectOf(idea) {
  if (!idea || typeof idea !== 'object') return null;
  const texts = [idea.title, ...(Array.isArray(idea.claims) ? idea.claims.map((c) => c && c.text) : [])];
  for (const t of texts) { if (typeof t !== 'string') continue; const a = first(t); if (a) return { key: a.key, tag: a.tag }; }
  return null;
}

/** The reviewer's tags of a clip, or null: a record without tags or without `by` is not a reviewer record (fail closed). */
const tagsOf = (clip) => { const s = clip && clip.shows; return s && Array.isArray(s.tags) && s.tags.length && typeof s.by === 'string' && s.by.trim() ? s.tags : null; };

export function clipFits(idea, clip) {
  const s = subjectOf(idea); const tags = tagsOf(clip);
  return Boolean(s && s.tag && tags && tags.includes(s.tag));
}

// How each tag reads in the alt text. The reviewer records WHAT is there, not how many: the singular or plural below is the plain default for that animal.
const PHRASE = Object.freeze({ lion: 'a lion', elephant: 'elephants', buffalo: 'buffalo', zebra: 'zebras', hippo: 'hippos', wildebeest: 'wildebeest', crocodile: 'a crocodile', bird: 'birds', giraffe: 'giraffes', cheetah: 'a cheetah', leopard: 'a leopard',
  hyena: 'a hyena', rhino: 'a rhino', 'wild-dog': 'wild dogs', savanna: 'the savanna', wetland: 'a wetland', river: 'a river', 'river-crossing': 'a river crossing', volcano: 'a volcano', landscape: 'a landscape' });
const ANIMAL_FIRST = Object.freeze(Object.keys(PHRASE).filter((t) => !['savanna', 'wetland', 'river', 'river-crossing', 'volcano', 'landscape'].includes(t)));

export function altTextFor(clip, hook) {
  const tags = tagsOf(clip); if (!tags) return null;
  const known = tags.filter((t) => PHRASE[t]); if (!known.length) return null;
  const ordered = [...known.filter((t) => ANIMAL_FIRST.includes(t)), ...known.filter((t) => !ANIMAL_FIRST.includes(t))].map((t) => PHRASE[t]);
  const list = ordered.length > 1 ? `${ordered.slice(0, -1).join(', ')} and ${ordered.at(-1)}` : ordered[0];
  return `Short silent video of ${list} with the text: ${hook}`;
}
