// BreadcrumbList JSON-LD derived from the URL path. Only ancestors that are real pages are
// listed (a breadcrumb item must resolve); keep INDEX_PAGES in step with src/pages/**/index.astro.
export const INDEX_PAGES = {
  '/about/': 'About',
  '/excursions/': 'Excursions',
  '/reviews/': 'Lodge reviews',
};

export function cleanTitle(title) {
  return String(title).replace(/\s*[|–—-]\s*Beyond Paradise Adventures\s*$/i, '').trim();
}

export function breadcrumbList(pathname, title, site) {
  const path = pathname.endsWith('/') ? pathname : pathname + '/';
  if (path === '/') return null;
  const segs = path.split('/').filter(Boolean);
  const items = [{ name: 'Home', url: '/' }];
  for (let i = 1; i < segs.length; i++) {
    const p = '/' + segs.slice(0, i).join('/') + '/';
    if (INDEX_PAGES[p]) items.push({ name: INDEX_PAGES[p], url: p });
  }
  items.push({ name: cleanTitle(title), url: path });
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: site.replace(/\/$/, '') + it.url,
    })),
  };
}
