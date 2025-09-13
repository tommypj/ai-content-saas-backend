'use strict';

/**
 * AI provider (Gemini).
 *
 * Goals (swap-in):
 * - Read Gemini env vars (GOOGLE_API_KEY, GEMINI_MODEL).
 * - Preserve retries, timeouts, and tokensUsed semantics for downstream callers.
 * - Keep a small, stable surface: generateText({ prompt, system, temperature, maxTokens, stop }).
 *
 * Implementation notes:
 * - Uses @google/generative-ai official SDK.
 * - usageMetadata.totalTokenCount (if present) is reported as tokensUsed; otherwise we default to 0.
 * - Simple exponential backoff on retriable errors (429/5xx/ETIMEDOUT/ECONNRESET/aborted).
 * - Per-call timeout enforced via AbortController.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---- Env & defaults --------------------------------------------------------
const {
  GEMINI_MODEL = 'gemini-2.0-flash-exp',  // Latest Gemini model - update to gemini-2.5-pro if available
  AI_TIMEOUT_MS,
  AI_RETRY_ATTEMPTS,
  AI_RETRY_BASE_MS,
} = process.env;

// Conservative defaults if not provided via env
const DEFAULT_TIMEOUT_MS = Number(AI_TIMEOUT_MS || 30000);       // 30s
const DEFAULT_RETRY_ATTEMPTS = Number(AI_RETRY_ATTEMPTS || 3);   // 3 tries
const DEFAULT_RETRY_BASE_MS = Number(AI_RETRY_BASE_MS || 400);   // 400ms backoff base

// Lazy client; avoid crashing process at require-time.
let genAI = null;
function getClient() {
  if (!genAI) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) {
      // Defer error until first use so the API can boot and log useful context.
      const hint = 'Set GOOGLE_API_KEY in .env (see 11-ops-runbook.md).';
      const where = 'backend/.env (same folder as index.js)';
      throw new Error(`GOOGLE_API_KEY is not set. ${hint} Expected in ${where}.`);
    }
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

// ---- Helpers ---------------------------------------------------------------
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function isRetriableError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  // Network-ish
  if (msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('abort')) return true;
  // SDK/HTTP-ish codes if present
  const code = err.status || err.code || err.statusCode;
  if (code === 429) return true;
  if (typeof code === 'number' && code >= 500) return true;
  return false;
}

async function withRetry(fn, { attempts = DEFAULT_RETRY_ATTEMPTS, baseMs = DEFAULT_RETRY_BASE_MS } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetriableError(err)) break;
      const delay = baseMs * Math.pow(2, i); // expo backoff
      await sleep(delay);
    }
  }
  throw lastErr;
}

// JSON parsing helper with better error handling
function parseJSONResponse(text, context = 'unknown') {
  let data;
  try {
    // First try to clean and parse the text
    let cleanText = text.trim();
    
    // Remove code block markers if present
    cleanText = cleanText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    
    // Try to parse directly
    data = JSON.parse(cleanText);
  } catch (parseError) {
    try {
      // Try to find JSON in the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        // Log the error for debugging
        console.error(`JSON_PARSE_FAILED for ${context}:`, text.slice(0, 500));
        const err = new Error('JSON_PARSE_FAILED');
        err.rawText = text;
        err.parseError = parseError.message;
        throw err;
      }
    } catch (secondError) {
      console.error(`JSON_PARSE_FAILED for ${context} (second attempt):`, text.slice(0, 500));
      const err = new Error('JSON_PARSE_FAILED');
      err.rawText = text;
      err.parseError = parseError.message;
      throw err;
    }
  }
  return data;
}

// ---- Public API ------------------------------------------------------------
/**
 * Generate text from Gemini.
 * @param {Object} params
 * @param {string} params.prompt - user prompt
 * @param {string} [params.system] - optional system instruction
 * @param {number} [params.temperature] - 0..2 typical
 * @param {number} [params.maxTokens] - max output tokens
 * @param {string[]} [params.stop] - stop sequences
 * @returns {Promise<{ text: string, tokensUsed: number, model: string, raw?: any }>}
 */
async function generateText(params) {
  const {
    prompt,
    system,
    temperature,
    maxTokens,
    stop,
  } = params || {};

  if (!prompt || typeof prompt !== 'string') {
    throw new Error('generateText: `prompt` (string) is required.');
  }

  const model = getClient().getGenerativeModel({
    model: GEMINI_MODEL,
    ...(system ? { systemInstruction: system } : {}),
  });

  const generationConfig = {};
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (typeof maxTokens === 'number') generationConfig.maxOutputTokens = maxTokens;
  if (Array.isArray(stop) && stop.length > 0) generationConfig.stopSequences = stop;

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const exec = async () => {
      const res = await model.generateContent(
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        },
        // The SDK currently attaches abort via options on underlying fetch.
        // Some versions accept { signal } as second arg; if unsupported, abort will surface anyway.
        { signal: controller.signal }
      );

      // SDK response shape:
      // res.response.text() -> string
      // res.response.usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount }
      const text = res?.response?.text?.() ?? '';
      const tokensUsed = Number(res?.response?.usageMetadata?.totalTokenCount || 0);
      return {
        text,
        tokensUsed,
        model: GEMINI_MODEL,
        raw: res,
      };
    };

    return await withRetry(exec);
  } finally {
    clearTimeout(to);
  }
}

module.exports = {
  generateText,
  
  /**
   * Generate SEO keywords for a topic/seed.
   * @param {{ seed: string, locale?: string }} params
   * @returns {Promise<{ result: { topic: string, keywords: Array }, tokensUsed: number, model: string }>}
   */
  async generateKeywords({ seed, locale = 'en' } = {}) {
    if (!seed || typeof seed !== 'string') {
      throw new Error('generateKeywords: `seed` (string) is required.');
    }

    const languageInstruction = locale === 'ro' ? 
      'Răspunde în română pentru toate câmpurile de text.' : 
      'Respond in English for all text fields.';

    const prompt = `${languageInstruction}

Generate SEO keywords for the topic: "${seed}"

Return ONLY valid JSON in this exact format:
{
  "topic": "${seed}",
  "keywords": [
    {"keyword": "example keyword", "volume": 1000, "difficulty": 25, "source": "research"},
    {"keyword": "another keyword", "volume": 2500, "difficulty": 45, "source": "analysis"}
  ]
}

Generate 8-12 relevant keywords with estimated search volume and difficulty scores.`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    
    try {
      const { text, tokensUsed } = await module.exports.generateText({
        prompt,
        system: 'You are an SEO strategist. Return only valid JSON, no explanations.',
        temperature: 0.2,
        maxTokens: 1000,
      });

      // Parse the response using our helper
      const data = parseJSONResponse(text, 'keywords');

      const topic = data?.topic || seed;
      const keywordsArray = Array.isArray(data?.keywords) ? data.keywords : [];
      
      const keywords = keywordsArray.map((k, index) => {
        if (typeof k === 'string') {
          return { keyword: k, volume: null, difficulty: null, source: 'generated' };
        }
        return {
          keyword: k?.keyword || k?.term || `keyword-${index + 1}`,
          volume: k?.volume || null,
          difficulty: k?.difficulty || null,
          source: k?.source || 'generated'
        };
      });

      return {
        result: { topic, keywords },
        tokensUsed: Number(tokensUsed || 0),
        model: GEMINI_MODEL
      };

    } finally {
      clearTimeout(to);
    }
  },

  /**
   * Generate article content based on keywords.
   * @param {{ keywords: Array, topic: string, locale?: string, settings?: Object }} params
   * @returns {Promise<{ result: { title: string, content: string, wordCount: number }, tokensUsed: number, model: string }>}
   */
  async generateArticle({ keywords = [], topic, locale = 'en', settings = {} } = {}) {
    if (!topic || typeof topic !== 'string') {
      throw new Error('generateArticle: `topic` (string) is required.');
    }

    const keywordStrings = keywords.map(k => {
      if (typeof k === 'string') return k;
      return k?.keyword || k?.term || '';
    }).filter(Boolean);

    const languageInstruction = locale === 'ro' ? 
      'Scrie articolul în română.' : 
      'Write the article in English.';

    const keywordsList = keywordStrings.length > 0 ? 
      keywordStrings.slice(0, 10).join(', ') : 
      topic;

    const wordCount = settings?.length === 'short' ? '500-800' :
                     settings?.length === 'long' ? '1500-2500' :
                     '1000-1500';

    const tone = settings?.tone || 'professional';

    const prompt = `${languageInstruction}

Write a comprehensive SEO-optimized article about: "${topic}"

Target keywords to include naturally: ${keywordsList}

Requirements:
- Word count: ${wordCount} words
- Tone: ${tone}
- Include a compelling title
- Structure with clear headings and subheadings
- Write engaging, informative content
- Naturally incorporate the target keywords
- Include actionable insights

Return ONLY valid JSON in this exact format:
{
  "title": "Compelling Article Title",
  "content": "<h1>Article Title</h1>\\n\\n<p>Introduction paragraph...</p>\\n\\n<h2>Section Heading</h2>\\n\\n<p>Content with natural keyword integration...</p>",
  "wordCount": 1200
}

The content should be formatted as HTML with proper heading tags (h1, h2, h3) and paragraph tags.`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    
    try {
      const { text, tokensUsed } = await module.exports.generateText({
        prompt,
        system: 'You are a professional content writer and SEO specialist. Return only valid JSON with HTML-formatted content.',
        temperature: 0.3,
        maxTokens: 4000,
      });

      // Parse the response using our helper
      const data = parseJSONResponse(text, 'article');

      const title = data?.title || `Article: ${topic}`;
      const content = data?.content || `<h1>${title}</h1>\\n\\n<p>Content generation failed. Please try again.</p>`;
      const estimatedWordCount = data?.wordCount || Math.floor(content.replace(/<[^>]*>/g, '').split(/\s+/).length);

      return {
        result: { 
          title, 
          content,
          wordCount: estimatedWordCount,
          topic,
          keywords: keywordStrings
        },
        tokensUsed: Number(tokensUsed || 0),
        model: GEMINI_MODEL
      };

    } finally {
      clearTimeout(to);
    }
  },

  /**
   * Generate SEO review and recommendations for an article.
   * @param {{ article: Object, keywords: Array, topic: string, locale?: string }} params
   * @returns {Promise<{ result: { score: number, recommendations: Array, analysis: Object }, tokensUsed: number, model: string }>}
   */
  async generateSEOReview({ article, keywords = [], topic, locale = 'en' } = {}) {
    if (!article || !article.content || !topic) {
      throw new Error('generateSEOReview: `article` with content and `topic` are required.');
    }

    const keywordStrings = keywords.map(k => {
      if (typeof k === 'string') return k;
      return k?.keyword || k?.term || '';
    }).filter(Boolean);

    const languageInstruction = locale === 'ro' ? 
      'Răspunde în română pentru toate câmpurile de text.' : 
      'Respond in English for all text fields.';

    const keywordsList = keywordStrings.length > 0 ? 
      keywordStrings.slice(0, 10).join(', ') : 
      topic;

    const textContent = article.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = textContent.split(/\s+/).length;

    const prompt = `${languageInstruction}

Analyze the following article for SEO optimization:

Title: ${article.title}
Target Topic: ${topic}
Target Keywords: ${keywordsList}
Word Count: ${wordCount}
Content Preview: ${textContent.slice(0, 1500)}

Provide a comprehensive SEO analysis and return ONLY valid JSON in this exact format:
{
  "score": 85,
  "analysis": {
    "titleOptimization": "Good title with primary keyword",
    "keywordDensity": "Optimal keyword usage throughout content",
    "contentStructure": "Well-structured with proper headings",
    "readability": "Clear and easy to read"
  },
  "recommendations": [
    "Add meta description with primary keyword",
    "Include more internal links",
    "Add FAQ section for featured snippets"
  ],
  "strengths": [
    "Good keyword placement in title",
    "Comprehensive topic coverage",
    "Clear content structure"
  ],
  "issues": [
    "Missing alt text for images",
    "Could use more subheadings"
  ]
}

Return only the JSON, no explanations.`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    
    try {
      const { text, tokensUsed } = await module.exports.generateText({
        prompt,
        system: 'You are an SEO expert and content analyst. Return only valid JSON with detailed SEO analysis.',
        temperature: 0.2,
        maxTokens: 2000,
      });

      // Parse the response using our helper
      const data = parseJSONResponse(text, 'seo');

      const score = typeof data?.score === 'number' ? Math.max(0, Math.min(100, data.score)) : 75;
      const analysis = data?.analysis || {};
      const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
      const strengths = Array.isArray(data?.strengths) ? data.strengths : [];
      const issues = Array.isArray(data?.issues) ? data.issues : [];

      return {
        result: { 
          score,
          analysis: {
            ...analysis,
            strengths,
            improvements: issues  // Map issues to improvements for frontend compatibility
          },
          recommendations,
          article: {
            title: article.title,
            wordCount: wordCount
          },
          keywords: keywordStrings,
          topic
        },
        tokensUsed: Number(tokensUsed || 0),
        model: GEMINI_MODEL
      };

    } finally {
      clearTimeout(to);
    }
  },

  /**
   * Generate meta tags and descriptions for an article.
   * @param {{ article: Object, keywords: Array, topic: string, locale?: string }} params
   * @returns {Promise<{ result: { metaTitle: string, metaDescription: string, metaKeywords: string, ogTitle: string, ogDescription: string }, tokensUsed: number, model: string }>}
   */
  async generateMeta({ article, keywords = [], topic, locale = 'en' } = {}) {
    if (!article || !article.title || !topic) {
      throw new Error('generateMeta: `article` with title and `topic` are required.');
    }

    const keywordStrings = keywords.map(k => {
      if (typeof k === 'string') return k;
      return k?.keyword || k?.term || '';
    }).filter(Boolean);

    const languageInstruction = locale === 'ro' ? 
      'Răspunde în română pentru toate câmpurile de text.' : 
      'Respond in English for all text fields.';

    const keywordsList = keywordStrings.length > 0 ? 
      keywordStrings.slice(0, 8).join(', ') : 
      topic;

    const textContent = article.content ? article.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const contentPreview = textContent.slice(0, 800);

    const prompt = `${languageInstruction}

Generate SEO meta tags for the following article:

Title: ${article.title}
Topic: ${topic}
Keywords: ${keywordsList}
Content Preview: ${contentPreview}

Generate optimized meta tags and return ONLY valid JSON in this exact format:
{
  "metaTitle": "SEO-optimized title (50-60 characters)",
  "metaDescription": "Compelling meta description with primary keyword (150-160 characters)",
  "metaKeywords": "keyword1, keyword2, keyword3, keyword4, keyword5",
  "ogTitle": "Social media optimized title (60 characters max)",
  "ogDescription": "Social media description (120-140 characters)",
  "twitterTitle": "Twitter optimized title (70 characters max)",
  "twitterDescription": "Twitter description (200 characters max)"
}

Requirements:
- Meta title should include primary keyword and be 50-60 characters
- Meta description should be compelling, include keywords, and be 150-160 characters
- Meta keywords should be relevant comma-separated keywords
- OG tags optimized for Facebook/LinkedIn sharing
- Twitter tags optimized for Twitter sharing

Return only the JSON, no explanations.`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    
    try {
      const { text, tokensUsed } = await module.exports.generateText({
        prompt,
        system: 'You are an SEO specialist focused on meta tag optimization. Return only valid JSON with optimized meta tags.',
        temperature: 0.2,
        maxTokens: 1500,
      });

      // Parse the response using our helper
      const data = parseJSONResponse(text, 'meta');

      const metaTitle = data?.metaTitle || article.title.slice(0, 60);
      const metaDescription = data?.metaDescription || `Learn about ${topic}. ${contentPreview.slice(0, 120)}...`;
      const metaKeywords = data?.metaKeywords || keywordsList;
      const ogTitle = data?.ogTitle || metaTitle;
      const ogDescription = data?.ogDescription || metaDescription.slice(0, 140);
      const twitterTitle = data?.twitterTitle || metaTitle;
      const twitterDescription = data?.twitterDescription || metaDescription;

      return {
        result: { 
          title: metaTitle,
          description: metaDescription,
          keywords: metaKeywords,
          openGraph: {
            title: ogTitle,
            description: ogDescription,
            type: 'article'
          },
          twitter: {
            title: twitterTitle,
            description: twitterDescription,
            card: 'summary_large_image'
          },
          article: {
            title: article.title,
            topic: topic
          },
          keywordsList: keywordStrings
        },
        tokensUsed: Number(tokensUsed || 0),
        model: GEMINI_MODEL
      };

    } finally {
      clearTimeout(to);
    }
  },

  /**
   * Generate image prompts and descriptions for an article.
   * @param {{ article: Object, keywords: Array, topic: string, locale?: string }} params
   * @returns {Promise<{ result: { imagePrompt: string, altText: string, caption: string, style: string }, tokensUsed: number, model: string }>}
   */
  async generateImage({ article, keywords = [], topic, locale = 'en' } = {}) {
    if (!article || !article.title || !topic) {
      throw new Error('generateImage: `article` with title and `topic` are required.');
    }

    const keywordStrings = keywords.map(k => {
      if (typeof k === 'string') return k;
      return k?.keyword || k?.term || '';
    }).filter(Boolean);

    const languageInstruction = locale === 'ro' ? 
      'Răspunde în română pentru toate câmpurile de text.' : 
      'Respond in English for all text fields.';

    const keywordsList = keywordStrings.length > 0 ? 
      keywordStrings.slice(0, 5).join(', ') : 
      topic;

    const textContent = article.content ? article.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const contentPreview = textContent.slice(0, 600);

    const prompt = `${languageInstruction}

Generate image specifications for the following article:

Title: ${article.title}
Topic: ${topic}
Keywords: ${keywordsList}
Content Preview: ${contentPreview}

Generate image specifications and return ONLY valid JSON in this exact format:
{
  "imagePrompt": "Detailed prompt for AI image generation describing the perfect hero image for this article",
  "altText": "SEO-optimized alt text for the image (80-125 characters)",
  "caption": "Engaging caption for the image (100-150 characters)",
  "style": "professional",
  "suggestions": [
    "Alternative image idea 1",
    "Alternative image idea 2",
    "Alternative image idea 3"
  ]
}

Requirements:
- Image prompt should be detailed and descriptive for AI image generation
- Alt text should include keywords and be 80-125 characters
- Caption should be engaging and include relevant keywords
- Style should be appropriate for the content (professional, modern, illustration, etc.)
- Suggestions should provide 3 alternative image concepts

Return only the JSON, no explanations.`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    
    try {
      const { text, tokensUsed } = await module.exports.generateText({
        prompt,
        system: 'You are a visual content specialist and image prompt engineer. Return only valid JSON with detailed image specifications.',
        temperature: 0.3,
        maxTokens: 1500,
      });

      // Parse the response using our helper
      const data = parseJSONResponse(text, 'image');

      const imagePrompt = data?.imagePrompt || `Professional image related to ${topic}, high quality, modern style`;
      const altText = data?.altText || `${topic} - ${article.title.slice(0, 60)}`;
      const caption = data?.caption || `Image related to ${topic}`;
      const style = data?.style || 'professional';
      const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];

      return {
        result: { 
          imageUrl: `https://picsum.photos/1200/630?random=${Date.now()}`,
          prompt: imagePrompt,
          altText,
          caption,
          style,
          dimensions: '1200x630',
          suggestions,
          article: {
            title: article.title,
            topic: topic
          },
          keywords: keywordStrings
        },
        tokensUsed: Number(tokensUsed || 0),
        model: GEMINI_MODEL
      };

    } finally {
      clearTimeout(to);
    }
  },

  /**
   * Generate hashtags for social media promotion of an article.
   * @param {{ article: Object, keywords: Array, topic: string, locale?: string }} params
   * @returns {Promise<{ result: { hashtags: Array, platforms: Object }, tokensUsed: number, model: string }>}
   */
  async generateHashtags({ article, keywords = [], topic, locale = 'en' } = {}) {
    if (!article || !article.title || !topic) {
      throw new Error('generateHashtags: `article` with title and `topic` are required.');
    }

    const keywordStrings = keywords.map(k => {
      if (typeof k === 'string') return k;
      return k?.keyword || k?.term || '';
    }).filter(Boolean);

    const languageInstruction = locale === 'ro' ? 
      'Răspunde în română pentru toate câmpurile de text.' : 
      'Respond in English for all text fields.';

    const keywordsList = keywordStrings.length > 0 ? 
      keywordStrings.slice(0, 8).join(', ') : 
      topic;

    const textContent = article.content ? article.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const contentPreview = textContent.slice(0, 500);

    const prompt = `${languageInstruction}

Generate social media hashtags for the following article:

Title: ${article.title}
Topic: ${topic}
Keywords: ${keywordsList}
Content Preview: ${contentPreview}

Generate hashtags and return ONLY valid JSON in this exact format:
{
  "hashtags": [
    {"tag": "#ExampleHashtag", "popularity": "high", "relevance": "primary"},
    {"tag": "#AnotherTag", "popularity": "medium", "relevance": "secondary"}
  ],
  "platforms": {
    "twitter": "#hashtag1 #hashtag2 #hashtag3",
    "instagram": "#hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5",
    "linkedin": "#hashtag1 #hashtag2 #hashtag3"
  },
  "trending": [
    "#TrendingTag1",
    "#TrendingTag2"
  ]
}

Requirements:
- Generate 15-20 relevant hashtags total
- Include popularity levels: high, medium, low
- Include relevance: primary, secondary, niche
- Platform-specific recommendations (Twitter: 3-5, Instagram: 5-10, LinkedIn: 3-5)
- Include 2-3 trending/popular hashtags if relevant
- Focus on keywords and topic relevance

Return only the JSON, no explanations.`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    
    try {
      const { text, tokensUsed } = await module.exports.generateText({
        prompt,
        system: 'You are a social media specialist and hashtag expert. Return only valid JSON with strategic hashtag recommendations.',
        temperature: 0.3,
        maxTokens: 2000,
      });

      // Parse the response using our helper
      const data = parseJSONResponse(text, 'hashtags');

      const hashtags = Array.isArray(data?.hashtags) ? data.hashtags : [];
      const platforms = data?.platforms || {};
      const trending = Array.isArray(data?.trending) ? data.trending : [];

      // Ensure we have fallback hashtags
      if (hashtags.length === 0) {
        const fallbackTags = keywordStrings.slice(0, 5).map(keyword => ({
          tag: `#${keyword.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '')}`,
          popularity: 'medium',
          relevance: 'primary'
        }));
        hashtags.push(...fallbackTags);
      }

      // Ensure we have primary, secondary, and trending arrays in the expected format
      let primaryTags = hashtags.filter(h => h.relevance === 'primary').map(h => h.tag.replace('#', ''));
      let secondaryTags = hashtags.filter(h => h.relevance === 'secondary').map(h => h.tag.replace('#', ''));
      const trendingTags = trending.map(t => t.replace('#', ''));

      // If we don't have enough tags in categories, redistribute
      if (primaryTags.length === 0 && hashtags.length > 0) {
        primaryTags = hashtags.slice(0, 5).map(h => h.tag.replace('#', ''));
      }
      if (secondaryTags.length === 0 && hashtags.length > 5) {
        secondaryTags = hashtags.slice(5, 10).map(h => h.tag.replace('#', ''));
      }

      return {
        result: { 
          primary: primaryTags.slice(0, 8),
          secondary: secondaryTags.slice(0, 10),
          trending: trendingTags.slice(0, 5),
          platforms: {
            twitter: platforms?.twitter || primaryTags.slice(0, 3).map(tag => `#${tag}`).join(' '),
            instagram: platforms?.instagram || [...primaryTags.slice(0, 5), ...secondaryTags.slice(0, 3)].map(tag => `#${tag}`).join(' '),
            linkedin: platforms?.linkedin || primaryTags.slice(0, 4).map(tag => `#${tag}`).join(' ')
          },
          all: hashtags,
          article: {
            title: article.title,
            topic: topic
          },
          keywords: keywordStrings
        },
        tokensUsed: Number(tokensUsed || 0),
        model: GEMINI_MODEL
      };

    } finally {
      clearTimeout(to);
    }
  },

  // expose for diagnostics/testing
  __internals: {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_RETRY_ATTEMPTS,
    DEFAULT_RETRY_BASE_MS,
  },
};