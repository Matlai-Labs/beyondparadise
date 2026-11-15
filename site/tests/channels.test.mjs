// The channel data file is the single source of truth (src/lib/channels.mjs). Guard its shape so
// a bad edit fails `npm run build` before astro runs. The built pages are checked by
// scripts/check-channels.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { channels, organizationSameAs, ORG_WIKIDATA, channelById } from '../src/lib/channels.mjs';

test('exactly the four channels exist, with unique ids and https URLs', () => {
  assert.deepEqual(channels.map((c) => c.id).sort(), ['facebook', 'instagram', 'youtube-africa', 'youtube-asia']);
  assert.equal(new Set(channels.map((c) => c.url)).size, channels.length);
  for (const c of channels) {
    assert.match(c.url, /^https:\/\/www\.(facebook\.com|instagram\.com|youtube\.com)\//, c.id);
    assert.ok(c.label && c.name, c.id);
    assert.ok(c.name.includes('Beyond Paradise Adventures'), `${c.id} name uses the full brand name`);
  }
});

test('sameAs is the Wikidata item followed by every channel URL', () => {
  assert.deepEqual(organizationSameAs(), [ORG_WIKIDATA, ...channels.map((c) => c.url)]);
  assert.ok(channelById('youtube-asia'));
});
