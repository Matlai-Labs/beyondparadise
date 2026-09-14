#!/bin/bash
# Deploy the Astro site to GitHub Pages (branch gh-pages of Matlai-Labs/beyondparadise).
# Custom domain beyondparadiseadventures.com is set on the Pages site; DNS must point at GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")"
npm run build
echo "beyondparadiseadventures.com" > dist/CNAME; touch dist/.nojekyll
cd dist && rm -rf .git && git init -q && git checkout -q -b gh-pages && git add -A \
  && git -c user.name="deploy" -c user.email="noreply@beyondparadiseadventures.com" commit -q -m "Deploy $(date -u +%FT%TZ)" \
  && git push -q --force https://github.com/Matlai-Labs/beyondparadise.git gh-pages && rm -rf .git
echo "deployed; check: gh api repos/Matlai-Labs/beyondparadise/pages --jq .status"
