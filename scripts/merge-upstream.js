#!/usr/bin/env node

// ============================================================================
// Merge upstream feed with local extras (with deduplication)
// ============================================================================
// 1. Downloads Zara's upstream feed-x.json and feed-podcasts.json
// 2. Reads the locally-generated feed-x.json (extras only)
// 3. Merges them into the final feed-x.json
// 4. Filters out tweets that were already shown (using state-feed.json)
// 5. Updates state-feed.json with new tweet IDs
// 6. Uses upstream feed-podcasts.json as-is (same sources)
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

  // 3. Read state to filter out already-seen tweets
  const statePath = join(REPO_ROOT, 'state-feed.json');
  let state = { seenTweets: {}, seenVideos: {} };
  if (existsSync(statePath)) {
    state = JSON.parse(await readFile(statePath, 'utf-8'));
  }
  const seenTweetIds = new Set(Object.keys(state.seenTweets || {}));
  console.error(`  State: ${seenTweetIds.size} seen tweets`);

  // 4. Merge: upstream accounts + extra accounts (no duplicates)
  const upstreamHandles = new Set((upstreamX.x || []).map(b => b.handle.toLowerCase()));
  const uniqueExtras = (extrasX.x || []).filter(b => !upstreamHandles.has(b.handle.toLowerCase()));

  const allBuilders = [...(upstreamX.x || []), ...uniqueExtras];

  // 5. Filter out already-seen tweets (only from PREVIOUS runs, not current window)
  const now = Date.now();
  const lookbackHours = upstreamX.lookbackHours || 24;
  const runCutoff = now - (lookbackHours * 60 * 60 * 1000); // Only filter tweets seen before this window
  
  let newTweetCount = 0;
  let filteredTweetCount = 0;

  for (const builder of allBuilders) {
    const originalCount = builder.tweets?.length || 0;
    builder.tweets = (builder.tweets || []).filter(tweet => {
      const seenAt = state.seenTweets[tweet.id];
      
      // Only filter if tweet was seen BEFORE the current lookback window
      if (seenAt && seenAt < runCutoff) {
        filteredTweetCount++;
        return false;
      }
      
      // Record this tweet as seen (or update timestamp if re-fetched)
      state.seenTweets[tweet.id] = now;
      newTweetCount++;
      return true;
    });
    
    if (builder.tweets.length === 0 && originalCount > 0) {
      console.error(`  [DEDUP] ${builder.name} (@${builder.handle}): filtered out ${originalCount} duplicate tweet(s)`);
    }
  }

  // Remove builders with no tweets
  const mergedX = allBuilders.filter(b => b.tweets && b.tweets.length > 0);
  const totalTweets = mergedX.reduce((sum, b) => sum + (b.tweets?.length || 0), 0);

  console.error(`  Dedup: ${newTweetCount} new, ${filteredTweetCount} filtered (duplicates)`);

  const mergedFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: upstreamX.lookbackHours || 24,
    x: mergedX,
    stats: { xBuilders: mergedX.length, totalTweets }
  };

  // 6. Write merged feed-x.json
  await writeFile(join(REPO_ROOT, 'feed-x.json'), JSON.stringify(mergedFeed, null, 2));
  console.error(`  Merged: ${mergedX.length} builders, ${totalTweets} tweets`);

  // 8. Deduplicate podcasts using state.seenVideos (only from PREVIOUS runs)
  const podcastLookbackHours = upstreamPodcasts.lookbackHours || 72;
  const podcastCutoff = now - (podcastLookbackHours * 60 * 60 * 1000);
  
  let newVideoCount = 0;
  let filteredVideoCount = 0;

  const filteredPodcasts = (upstreamPodcasts.podcasts || []).filter(episode => {
    const seenAt = state.seenVideos[episode.videoId];
    
    // Only filter if episode was seen BEFORE the current lookback window
    if (seenAt && seenAt < podcastCutoff) {
      filteredVideoCount++;
      return false;
    }
    
    // Record this episode as seen (or update timestamp if re-fetched)
    state.seenVideos[episode.videoId] = now;
    newVideoCount++;
    return true;
  });

  if (filteredVideoCount > 0) {
    console.error(`  [DEDUP] Podcasts: filtered out ${filteredVideoCount} duplicate episode(s)`);
  }

  const dedupedPodcasts = {
    ...upstreamPodcasts,
    podcasts: filteredPodcasts
  };

  await writeFile(join(REPO_ROOT, 'feed-podcasts.json'), JSON.stringify(dedupedPodcasts, null, 2));
  console.error(`  Podcasts: ${newVideoCount} new, ${filteredVideoCount} filtered (duplicates)`);

  // 9. Write updated state (including seenVideos now)
  await writeFile(statePath, JSON.stringify(state, null, 2));
  console.error(`  State updated: ${Object.keys(state.seenTweets).length} tweets, ${Object.keys(state.seenVideos).length} videos`);
}

main().catch(err => {
  console.error('Merge failed:', err.message);
  process.exit(1);
});