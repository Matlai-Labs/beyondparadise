import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGenerativeAiCsv, parseGscPages } from '../lib/gsc.mjs';

test('generative AI CSV: BOM, thousands separators, optional clicks, totals row dropped, bad row skipped', () => {
  const r = parseGenerativeAiCsv('﻿Top pages,Clicks,Impressions\nhttps://x.test/a,"1,234","12.345"\nhttps://x.test/b,,7\nTotal,9,9\nhttps://x.test/c,1,N/A\n');
  assert.equal(r.dimension, 'page');
  assert.deepEqual(r.rows, [
    { key: 'https://x.test/a', impressions: 12345, clicks: 1234 },
    { key: 'https://x.test/b', impressions: 7, clicks: null },
  ]);
  assert.equal(r.skippedRows, 1);
});

test('generative AI CSV: no clicks column, query dimension; missing impressions throws', () => {
  const r = parseGenerativeAiCsv('Query,Impressions\nzanzibar hotel,5\n');
  assert.equal(r.dimension, 'query');
  assert.equal(r.rows[0].clicks, null);
  assert.throws(() => parseGenerativeAiCsv('Page,Foo\na,1\n'), /Search Console/);
  assert.deepEqual(parseGenerativeAiCsv('Page,Impressions\n').rows, []);
  assert.throws(() => parseGenerativeAiCsv('Page,Impressions\na,N/A\n'), /Search Console/);
});

test('GSC page export: CSV, API-shaped JSON and plain JSON all normalise', () => {
  const csv = parseGscPages('Top pages,Clicks,Impressions,CTR,Position\nhttps://x.test/a/,10,200,5%,3.2\n');
  assert.deepEqual(csv[0], { path: '/a', clicks: 10, impressions: 200, ctr: 0.05, position: 3.2 });
  const api = parseGscPages(JSON.stringify({ rows: [{ keys: ['https://x.test/b'], clicks: 1, impressions: 10, ctr: 0.1, position: 8 }] }));
  assert.equal(api[0].path, '/b');
  const plain = parseGscPages(JSON.stringify([{ page: '/c?x=1', clicks: 2, impressions: 4, position: 1 }]));
  assert.equal(plain[0].path, '/c');
  assert.equal(plain[0].ctr, 0.5);
});
