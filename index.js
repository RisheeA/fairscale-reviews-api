import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_SERVICE_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  FAIRSCALE_API: process.env.FAIRSCALE_API || 'https://fairscale-reputation-api-production.up.railway.app',
  MAX_REVIEWS_PER_DAY: 3,
  MIN_FAIRSCORE_TO_REVIEW: 10,
  PORT: process.env.PORT || 8081
};

// =============================================================================
// CLIENTS
// =============================================================================

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// =============================================================================
// FAIRSCALE INTEGRATION
// =============================================================================

async function getFairScore(wallet) {
  try {
    const response = await fetch(`${CONFIG.FAIRSCALE_API}/score?wallet=${encodeURIComponent(wallet)}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.agent_fairscore || 10;
  } catch (e) {
    console.error('FairScale error:', e.message);
    return null;
  }
}

// =============================================================================
// CLAUDE AI - SENTIMENT & SPAM DETECTION
// =============================================================================

async function analyzeReview(comment, targetHandle) {
  if (!comment || comment.trim().length < 3) {
    return { sentiment: 0, themes: [], isSpam: false, spamReason: null };
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Analyze this review of @${targetHandle}:

"${comment}"

Respond in JSON only:
{
  "sentiment": <number from -1.0 (very negative) to 1.0 (very positive)>,
  "themes": [<up to 3 key themes as short strings, e.g. "fast response", "poor quality">],
  "isSpam": <true if spam, gibberish, self-promotion, or irrelevant>,
  "spamReason": <if isSpam, brief reason, else null>
}

JSON only, no explanation:`
      }]
    });

    const text = response.content[0].text.trim();
    const json = JSON.parse(text);
    
    return {
      sentiment: Math.max(-1, Math.min(1, json.sentiment || 0)),
      themes: Array.isArray(json.themes) ? json.themes.slice(0, 3) : [],
      isSpam: !!json.isSpam,
      spamReason: json.spamReason || null
    };
  } catch (e) {
    console.error('Claude analysis error:', e.message);
    return { sentiment: 0, themes: [], isSpam: false, spamReason: null };
  }
}

// =============================================================================
// REVIEWER MANAGEMENT
// =============================================================================

async function getOrCreateReviewer(wallet) {
  // Check if exists
  const { data: existing } = await supabase
    .from('reviewers')
    .select('*')
    .eq('wallet_address', wallet)
    .single();

  if (existing) {
    // Check if we need to reset daily count
    const today = new Date().toISOString().split('T')[0];
    if (existing.last_review_date !== today) {
      await supabase
        .from('reviewers')
        .update({ reviews_today: 0 })
        .eq('wallet_address', wallet);
      existing.reviews_today = 0;
    }
    return existing;
  }

  // Get FairScore and create new reviewer
  const fairscore = await getFairScore(wallet);
  
  const { data: newReviewer, error } = await supabase
    .from('reviewers')
    .insert({
      wallet_address: wallet,
      fairscore_at_signup: fairscore || 10
    })
    .select()
    .single();

  if (error) throw error;
  return newReviewer;
}

async function canReview(wallet) {
  const reviewer = await getOrCreateReviewer(wallet);
  
  if (reviewer.reviews_today >= CONFIG.MAX_REVIEWS_PER_DAY) {
    return { allowed: false, reason: `Daily limit reached (${CONFIG.MAX_REVIEWS_PER_DAY}/day)`, remaining: 0 };
  }

  const fairscore = await getFairScore(wallet);
  if (!fairscore || fairscore < CONFIG.MIN_FAIRSCORE_TO_REVIEW) {
    return { allowed: false, reason: 'FairScore too low to submit reviews', remaining: 0 };
  }

  return { 
    allowed: true, 
    remaining: CONFIG.MAX_REVIEWS_PER_DAY - reviewer.reviews_today,
    fairscore
  };
}

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Reviews API',
    version: '1.0.0',
    endpoints: {
      'GET /can-review?wallet=': 'Check if wallet can submit review',
      'POST /review': 'Submit a review',
      'GET /reviews/:handle': 'Get reviews for a handle',
      'GET /target/:handle': 'Get aggregated score for handle',
      'GET /top': 'Get top rated handles',
      'GET /reviewer/:wallet': 'Get reviewer stats'
    }
  });
});

// Check if wallet can review
app.get('/can-review', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

  try {
    const result = await canReview(wallet);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit review
app.post('/review', async (req, res) => {
  const { 
    wallet, 
    targetHandle, 
    starRating, 
    reliability, 
    communication, 
    quality, 
    comment,
    source = 'web'
  } = req.body;

  // Validation
  if (!wallet || !targetHandle || !starRating) {
    return res.status(400).json({ error: 'Missing required fields: wallet, targetHandle, starRating' });
  }

  if (starRating < 1 || starRating > 5) {
    return res.status(400).json({ error: 'starRating must be 1-5' });
  }

  // Clean handle
  const handle = targetHandle.replace('@', '').toLowerCase().trim();

  try {
    // Check rate limit and eligibility
    const eligibility = await canReview(wallet);
    if (!eligibility.allowed) {
      return res.status(429).json({ error: eligibility.reason });
    }

    // Analyze comment with Claude
    const analysis = await analyzeReview(comment, handle);

    // Reject spam
    if (analysis.isSpam) {
      return res.status(400).json({ 
        error: 'Review flagged as spam', 
        reason: analysis.spamReason 
      });
    }

    // Calculate weight based on FairScore
    const weight = eligibility.fairscore / 100;

    // Insert review
    const { data: review, error } = await supabase
      .from('reviews')
      .insert({
        reviewer_wallet: wallet,
        reviewer_fairscore: eligibility.fairscore,
        target_handle: handle,
        platform: 'twitter',
        star_rating: starRating,
        reliability: reliability || null,
        communication: communication || null,
        quality: quality || null,
        comment: comment || null,
        ai_sentiment_score: analysis.sentiment,
        ai_themes: analysis.themes,
        ai_spam_flag: false,
        weight,
        source
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      review: {
        id: review.id,
        targetHandle: handle,
        starRating,
        weight: weight.toFixed(2),
        sentiment: analysis.sentiment,
        themes: analysis.themes
      },
      remaining: eligibility.remaining - 1
    });

  } catch (e) {
    console.error('Review error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get reviews for a handle
app.get('/reviews/:handle', async (req, res) => {
  const handle = req.params.handle.replace('@', '').toLowerCase();
  const { limit = 20, offset = 0 } = req.query;

  try {
    const { data: reviews, error, count } = await supabase
      .from('reviews')
      .select('*', { count: 'exact' })
      .eq('target_handle', handle)
      .eq('ai_spam_flag', false)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw error;

    res.json({
      handle,
      total: count,
      reviews: reviews.map(r => ({
        id: r.id,
        reviewerWallet: r.reviewer_wallet.slice(0, 6) + '...' + r.reviewer_wallet.slice(-4),
        reviewerFairscore: r.reviewer_fairscore,
        starRating: r.star_rating,
        reliability: r.reliability,
        communication: r.communication,
        quality: r.quality,
        comment: r.comment,
        sentiment: r.ai_sentiment_score,
        themes: r.ai_themes,
        weight: r.weight,
        createdAt: r.created_at
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get target aggregate score
app.get('/target/:handle', async (req, res) => {
  const handle = req.params.handle.replace('@', '').toLowerCase();

  try {
    const { data: target, error } = await supabase
      .from('targets')
      .select('*')
      .eq('handle', handle)
      .eq('platform', 'twitter')
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!target) {
      return res.json({
        handle,
        found: false,
        message: 'No reviews yet for this handle'
      });
    }

    res.json({
      handle,
      found: true,
      weightedRating: Number(target.weighted_rating).toFixed(2),
      totalReviews: target.total_reviews,
      avgReliability: Number(target.avg_reliability).toFixed(2),
      avgCommunication: Number(target.avg_communication).toFixed(2),
      avgQuality: Number(target.avg_quality).toFixed(2),
      avgSentiment: Number(target.avg_sentiment).toFixed(2),
      topThemes: target.top_themes || [],
      updatedAt: target.updated_at
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get top rated handles
app.get('/top', async (req, res) => {
  const { limit = 20, minReviews = 1 } = req.query;

  try {
    const { data: targets, error } = await supabase
      .from('targets')
      .select('*')
      .gte('total_reviews', Number(minReviews))
      .order('weighted_rating', { ascending: false })
      .limit(Number(limit));

    if (error) throw error;

    res.json({
      total: targets.length,
      targets: targets.map(t => ({
        handle: t.handle,
        platform: t.platform,
        weightedRating: Number(t.weighted_rating).toFixed(2),
        totalReviews: t.total_reviews,
        avgSentiment: Number(t.avg_sentiment).toFixed(2)
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get reviewer stats
app.get('/reviewer/:wallet', async (req, res) => {
  const { wallet } = req.params;

  try {
    const { data: reviewer, error } = await supabase
      .from('reviewers')
      .select('*')
      .eq('wallet_address', wallet)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!reviewer) {
      return res.json({ found: false });
    }

    const fairscore = await getFairScore(wallet);

    res.json({
      found: true,
      wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4),
      currentFairscore: fairscore,
      fairscoreAtSignup: reviewer.fairscore_at_signup,
      totalReviews: reviewer.total_reviews_given,
      reviewsToday: reviewer.reviews_today,
      remainingToday: Math.max(0, CONFIG.MAX_REVIEWS_PER_DAY - reviewer.reviews_today),
      avgSentiment: Number(reviewer.avg_sentiment_given || 0).toFixed(2),
      memberSince: reviewer.created_at
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search handles
app.get('/search', async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  try {
    const { data: targets, error } = await supabase
      .from('targets')
      .select('*')
      .ilike('handle', `%${q}%`)
      .order('total_reviews', { ascending: false })
      .limit(Number(limit));

    if (error) throw error;

    res.json({
      query: q,
      results: targets.map(t => ({
        handle: t.handle,
        weightedRating: Number(t.weighted_rating).toFixed(2),
        totalReviews: t.total_reviews
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, () => {
  console.log(`FairScale Reviews API v1.0 on port ${CONFIG.PORT}`);
});
