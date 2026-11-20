#!/bin/bash
# Deploy the Astro site to GitHub Pages (branch gh-pages of Matlai-Labs/beyondparadise).
# Custom domain beyondparadiseadventures.com is set on the Pages site; DNS must point at GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")"
npm run build
# sitemap.xml is the URL crawlers guess first; @astrojs/sitemap only writes sitemap-index.xml (404 on /sitemap.xml until 2026-11-20).
# An index file is a valid sitemap.xml, so serve the same index there. Generated each build so it never goes stale.
cp dist/sitemap-index.xml dist/sitemap.xml && test -s dist/sitemap.xml
node scripts/write-redirect-stubs.mjs   # retired URLs -> redirect stubs (GitHub Pages has no 301s); after the gates, not part of them
node scripts/post-build-gate.mjs --self-test && node scripts/post-build-gate.mjs   # fail closed: verification tags (from .env) + redirect stubs must be in dist/ before publishing
echo "beyondparadiseadventures.com" > dist/CNAME; touch dist/.nojekyll
cd dist && rm -rf .git && git init -q && git checkout -q -b gh-pages && git add -A \
  && git -c user.name="deploy" -c user.email="noreply@beyondparadiseadventures.com" commit -q -m "Deploy $(date -u +%FT%TZ)" \
  && git push -q --force https://github.com/Matlai-Labs/beyondparadise.git gh-pages && rm -rf .git
echo "deployed; check: gh api repos/Matlai-Labs/beyondparadise/pages --jq .status"
