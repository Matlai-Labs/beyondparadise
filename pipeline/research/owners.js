'use strict';

// ============================================================
// owners.js — source independence by OWNER, not domain
//
// The core correctness rule: two sources only "independently confirm"
// a claim if they have DIFFERENT owners. Two pages on singita.com = 1
// owner. A study + its press release = 1 owner. An NGO + its donor's
// report = likely 2 owners but check.
//
// ownerOf(host) → resolves to registrable domain (conservative fallback)
// distinctOwners(sources) → count of unique owners across source list
// isAvoided(host) → true if host is on the Beyond Paradise avoid list
// tierFor(host) → tier integer from sources.json registry, or null
// ============================================================

const fs = require('fs');
const path = require('path');

const MULTI_TLD = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  'com.au', 'co.nz', 'co.za', 'com.br', 'co.jp', 'com.es', 'com.mx', 'co.in', 'com.tr',
]);

function normHost(host) {
  return String(host || '')
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

function registrable(host) {
  const h = normHost(host);
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_TLD.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

let _cache = null;
function loadSources(sourcesPath) {
  if (_cache && !sourcesPath) return _cache;
  const p = sourcesPath || path.join(__dirname, '..', '..', 'data', 'facts', 'sources.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* tolerate missing during bootstrap */ }
  if (!sourcesPath) _cache = data;
  return data;
}

// Resolves a hostname to its owner key (registrable domain for now).
// When Beyond Paradise grows, add ownerGroups to sources.json to
// explicitly group multi-domain publishers under one owner key.
function ownerOf(host) {
  const h = normHost(host);
  if (!h) return null;
  return registrable(h);
}

// Counts distinct owners across a list of source objects.
// Each source should have a `domain` property (bare hostname).
function distinctOwners(sources) {
  const owners = new Set();
  for (const s of (sources || [])) {
    const o = ownerOf(s.domain || s.host || s.owner || '');
    if (o) owners.add(o);
  }
  return owners.size;
}

// Returns true if this host is on the Beyond Paradise avoid list.
// Pre-fetch gate — never even count these as sources.
function isAvoided(host) {
  const data = loadSources();
  const avoidList = data.avoid_list || [];
  const h = normHost(host);
  return avoidList.some(entry => {
    const dn = normHost(entry.domain);
    // match exact domain or any subdomain (padi.com/blog → padi.com)
    return h === dn || h.endsWith('.' + dn) || h.startsWith(dn);
  });
}

// Looks up the trust tier (1–6) for a domain from the sources.json registry.
// Compares registrable domains so marinemegafauna.org matches the registry entry.
// Returns null for unknown domains (Tim decides tier during review).
function tierFor(host) {
  const data = loadSources();
  const h = normHost(host);
  const hReg = registrable(h);
  for (const entry of Object.values(data.sources || {})) {
    if (!entry.url) continue;
    const entryHost = normHost(entry.url);
    const entryReg = registrable(entryHost);
    if (entryReg === hReg || entryHost === h) return entry.tier || null;
  }
  return null;
}

module.exports = { ownerOf, distinctOwners, registrable, normHost, isAvoided, tierFor, loadSources };
