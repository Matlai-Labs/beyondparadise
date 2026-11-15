// Single source of truth for the brand's public channels. Footer, YouTube section, Organization
// JSON-LD (BaseHead) and the article publisher JSON-LD (ArticleLayout) all read from here, and
// scripts/check-channels.mjs verifies the built pages against it. Change a URL here only.
//
// Each URL was fetched on 2026-10-08 (HTTP 200, right title); Facebook re-fetched 2026-11-15 and
// its own og:title is "Beyond Paradise Adventures", og:url is the spelling used below. Do not add a
// channel that has not been fetched, and do not add a vanity URL that has not been seen resolving.
// Facebook Page id 546924778515067 (social/config.json) is the Page these posts are published to.

export const SITE_URL = 'https://beyondparadiseadventures.com';

// The Wikidata item for the brand (label "Beyond Paradise Adventures"). Already held in the repo.
export const ORG_WIKIDATA = 'https://www.wikidata.org/wiki/Q140420385';

export const channels = [
  {
    id: 'facebook',
    label: 'Facebook',
    name: 'Beyond Paradise Adventures on Facebook',
    url: 'https://www.facebook.com/beyondparadiseadventures/',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    name: 'Beyond Paradise Adventures on Instagram',
    url: 'https://www.instagram.com/beyondparadiseadventures/',
  },
  {
    id: 'youtube-africa',
    label: 'YouTube (Africa)',
    name: 'Beyond Paradise Adventures Africa on YouTube (@BPA-Africa)',
    url: 'https://www.youtube.com/@BPA-Africa',
  },
  {
    id: 'youtube-asia',
    label: 'YouTube (Asia)',
    // The channel is titled "BPA - Asia" on YouTube; the handle is @beyondparadiseadventures.
    name: 'Beyond Paradise Adventures Asia on YouTube (@beyondparadiseadventures)',
    url: 'https://www.youtube.com/@beyondparadiseadventures',
  },
];

export const channelById = (id) => channels.find((c) => c.id === id);

// schema.org sameAs for the Organization: the Wikidata item plus every channel above.
export const organizationSameAs = () => [ORG_WIKIDATA, ...channels.map((c) => c.url)];
