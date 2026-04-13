// Property fuzzy matching against the cached master listing.
//
// Strategy order:
//   1. Exact match (case-insensitive)
//   2. Contains match (either direction)
//   3. Fuzzy match via Levenshtein ratio (>= 0.6)
//   4. Client name match (flagged as ambiguous)
//   5. Address fragment match

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        m[i][j] = m[i - 1][j - 1];
      } else {
        m[i][j] = Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
      }
    }
  }
  return m[b.length][a.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (!s1.length || !s2.length) return 0;
  const dist = levenshtein(s1, s2);
  const longer = Math.max(s1.length, s2.length);
  return (longer - dist) / longer;
}

function matchProperty(reference, properties) {
  if (!reference || !properties || properties.length === 0) {
    return { match: null, matchType: 'none', score: 0, alternatives: [] };
  }
  const ref = reference.toLowerCase().trim();

  // 1. Exact match
  for (const p of properties) {
    if (p.name.toLowerCase() === ref) {
      return { match: p, matchType: 'exact', score: 1.0, alternatives: [] };
    }
  }

  // 2. Contains match (score contains by length ratio)
  const containsMatches = [];
  for (const p of properties) {
    const pName = p.name.toLowerCase();
    if (pName.includes(ref) || ref.includes(pName)) {
      const score = Math.min(ref.length, pName.length) / Math.max(ref.length, pName.length);
      containsMatches.push({ property: p, score });
    }
  }
  if (containsMatches.length > 0) {
    containsMatches.sort((a, b) => b.score - a.score);
    const best = containsMatches[0];
    const alts = containsMatches.slice(1, 4).map((m) => m.property.name);
    return {
      match: best.property,
      matchType: 'contains',
      score: Number(best.score.toFixed(2)),
      alternatives: alts,
    };
  }

  // 3. Fuzzy match
  const fuzzyScores = properties.map((p) => ({
    property: p,
    score: similarity(ref, p.name),
  }));
  fuzzyScores.sort((a, b) => b.score - a.score);
  if (fuzzyScores[0] && fuzzyScores[0].score >= 0.6) {
    const best = fuzzyScores[0];
    const alts = fuzzyScores.slice(1, 4).filter((m) => m.score >= 0.5).map((m) => m.property.name);
    return {
      match: best.property,
      matchType: 'fuzzy',
      score: Number(best.score.toFixed(2)),
      alternatives: alts,
    };
  }

  // 4. Client name match
  const clientMatches = properties.filter(
    (p) => p.client_name && p.client_name.toLowerCase().includes(ref)
  );
  if (clientMatches.length > 0) {
    return {
      match: clientMatches[0],
      matchType: 'client',
      score: 0.5,
      alternatives: clientMatches.slice(1, 4).map((m) => m.name),
      ambiguous: true,
    };
  }

  // 5. Address fragment match
  const addrMatches = properties.filter(
    (p) => p.address && p.address.toLowerCase().includes(ref)
  );
  if (addrMatches.length > 0) {
    return {
      match: addrMatches[0],
      matchType: 'address',
      score: 0.7,
      alternatives: addrMatches.slice(1, 4).map((m) => m.name),
    };
  }

  return { match: null, matchType: 'none', score: 0, alternatives: [] };
}

// Async matcher with a live-Monday fallback. Use this from the pipeline
// so that a property added to Monday between cache refreshes can still be
// found without the user having to click "Refresh cache".
//
// Behavior:
//   1. Try the in-memory cache first (fast path; 99% of traffic).
//   2. If the cache miss is total (matchType === 'none'), do *one* live
//      query to Monday, merge the result with the existing cache, and
//      re-run the matcher. Flagged as matchType: 'live' on success so the
//      dashboard can show "Matched via live lookup" in the trace.
//   3. If the live query also misses, return the original miss.
//
// The caller (pipeline) is responsible for invoking cache.upsertProperty()
// on live hits so subsequent messages don't pay the API cost.
async function matchPropertyWithFallback(reference, properties, deps = {}) {
  const { monday, cache } = deps;
  const cacheResult = matchProperty(reference, properties);
  if (cacheResult.match) return cacheResult;
  if (!monday || !monday.isConfigured || !monday.isConfigured()) return cacheResult;

  try {
    const liveProperties = await monday.findPropertyLive(reference);
    if (!liveProperties || liveProperties.length === 0) return cacheResult;

    const liveResult = matchProperty(reference, liveProperties);
    if (!liveResult.match) return cacheResult;

    // Write-through: add the hit to the cache so next time it's found without
    // a round-trip. We only upsert the one that matched to avoid flattening
    // partial data over the existing cache.
    if (cache && cache.upsertProperty) {
      cache.upsertProperty(liveResult.match);
    }

    return {
      ...liveResult,
      matchType: `${liveResult.matchType}+live`,
      liveFallback: true,
    };
  } catch (err) {
    // Don't let live-lookup failures poison the pipeline — fall back to the
    // cached miss and let the ticket get flagged for human review as normal.
    return { ...cacheResult, liveFallbackError: err.message };
  }
}

module.exports = { matchProperty, matchPropertyWithFallback, similarity };
