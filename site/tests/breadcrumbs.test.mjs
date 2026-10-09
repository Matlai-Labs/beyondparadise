import test from 'node:test';
import assert from 'node:assert/strict';
import { breadcrumbList, cleanTitle } from '../src/lib/breadcrumbs.mjs';

const SITE = 'https://beyondparadiseadventures.com';

test('home page gets no BreadcrumbList', () => {
  assert.equal(breadcrumbList('/', 'Home', SITE), null);
});
test('leaf under an existing index page: Home > Section > Page, last item has no trailing url requirement', () => {
  const b = breadcrumbList('/excursions/stone-town-tour/', 'Stone Town Tour | Beyond Paradise Adventures', SITE);
  assert.equal(b['@type'], 'BreadcrumbList');
  assert.deepEqual(b.itemListElement.map((i) => [i.position, i.name, i.item]), [
    [1, 'Home', SITE + '/'],
    [2, 'Excursions', SITE + '/excursions/'],
    [3, 'Stone Town Tour', SITE + '/excursions/stone-town-tour/'],
  ]);
});
test('sections with no index page are skipped (no breadcrumb link to a 404)', () => {
  const b = breadcrumbList('/wildlife/humpback-whale/', 'Humpback whale', SITE);
  assert.deepEqual(b.itemListElement.map((i) => i.name), ['Home', 'Humpback whale']);
});
test('cleanTitle strips brand suffix', () => {
  assert.equal(cleanTitle('A | Beyond Paradise Adventures'), 'A');
  assert.equal(cleanTitle('A - Beyond Paradise Adventures'), 'A');
});
