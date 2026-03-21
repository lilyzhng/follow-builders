#!/usr/bin/env node

// ============================================================================
// Merge upstream feed with local extras
// ============================================================================
// 1. Downloads Zara's upstream feed-x.json and feed-podcasts.json
// 2. Reads the locally-generated feed-x.json (extras only)
// 3. Merges them into the final feed-x.json
// 4. Uses upstream feed-podcasts.json as-is (same sources)
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const REPO_ROOT = join(SCRIPT_DIR, '..');
const UPSTREAM_OWNER = 'zarazhangrui';
const UPSTREAM_REPO = 'follow-builders';

async function fetchUpstreamFeed(filename) {
  const url = `https://raw.githubusercontent.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/main/${filename}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch upstream ${filename}: HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  console.error('Fetching upstream feeds from zarazhangrui/follow-builders...');

  // 1. Get upstream feeds
  const upstreamX = await fetchUpstreamFeed('feed-x.json');
  const upstreamPodcasts = await fetchUpstreamFeed('feed-podcasts.json');
  console.error(`  Upstream: ${upstreamX.x?.length || 0} builders, ${upstreamPodcasts.podcasts?.length || 0} podcast episodes`);

  // 2. Read locally-generated extras feed (if it exists)
  const localFeedPath = join(REPO_ROOT, 'feed-x-extras.json');
  let extrasX = { x: [] };
  if (existsSync(localFeedPath)) {
    extrasX = JSON.parse(await readFile(localFeedPath, 'utf-8'));
    console.error(`  Extras: ${extrasX.x?.length || 0} builders`);
  } else {
    console.error('  No extras feed found, using upstream only');
  }

  // 3. Merge: upstream accounts + extra accounts (no duplicates)
  const upstreamHandles = new Set((upstreamX.x || []).map(b => b.handle.toLowerCase()));
  const uniqueExtras = (extrasX.x || []).filter(b => !upstreamHandles.has(b.handle.toLowerCase()));

  const mergedX = [...(upstreamX.x || []), ...uniqueExtras];
  const totalTweets = mergedX.reduce((sum, b) => sum + (b.tweets?.length || 0), 0);

  const mergedFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: upstreamX.lookbackHours || 24,
    x: mergedX,
    stats: { xBuilders: mergedX.length, totalTweets }
  };

  // 4. Write merged feed-x.json
  await writeFile(join(REPO_ROOT, 'feed-x.json'), JSON.stringify(mergedFeed, null, 2));
  console.error(`  Merged: ${mergedX.length} builders, ${totalTweets} tweets`);

  // 5. Use upstream podcasts as-is
  await writeFile(join(REPO_ROOT, 'feed-podcasts.json'), JSON.stringify(upstreamPodcasts, null, 2));
  console.error(`  Podcasts: ${upstreamPodcasts.podcasts?.length || 0} episodes (from upstream)`);
}

main().catch(err => {
  console.error('Merge failed:', err.message);
  process.exit(1);
});
