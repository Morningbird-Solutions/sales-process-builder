/**
 * Sales Process Builder — AI generation proxy (Cloudflare Worker)
 *
 * SETUP:
 * 1. Paste this whole file into the Worker's "Edit Code" editor, then Deploy.
 * 2. In Settings → Variables and Secrets, add ANTHROPIC_API_KEY as a Secret.
 * 3. Edit ALLOWED_ORIGIN below to your exact GitHub Pages URL (no trailing slash).
 * 4. Point your HTML tool's AI_ENDPOINT constant at this Worker's URL.
 *
 * Includes simple per-IP rate limiting (5 requests/hour) using the Cache API,
 * so a stranger who finds the URL can't run up your Anthropic bill.
 */

const ALLOWED_ORIGIN = 'https://morningbird-solutions.github.io';
const RATE_LIMIT = 5;                 // max requests
const RATE_WINDOW_SECONDS = 3600;     // per hour

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return json({ message: 'Method not allowed' }, 405, corsHeaders);
    }

    // ---- Basic per-IP rate limiting via the Cache API ----
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = new Request(`https://rate-limit.local/${ip}`);
    const cache = caches.default;
    let count = 0;
    const cached = await cache.match(rateKey);
    if (cached) {
      count = parseInt(await cached.text(), 10) || 0;
    }
    if (count >= RATE_LIMIT) {
      return json({ message: 'Too many requests. Please try again later.' }, 429, corsHeaders);
    }
    await cache.put(rateKey, new Response(String(count + 1), {
      headers: { 'Cache-Control': `max-age=${RATE_WINDOW_SECONDS}` },
    }));

    // ---- Parse & validate input ----
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ message: 'Invalid request body.' }, 400, corsHeaders);
    }

    const description = (body.description || '').toString().trim().slice(0, 2000);
    const motion = (body.motion || '').toString().trim();
    const stepCount = (body.step_count || '').toString().trim();

    if (!description) {
      return json({ message: 'Description is required.' }, 400, corsHeaders);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ message: 'AI generation is not configured on this server.' }, 500, corsHeaders);
    }

    // ---- Build the prompt ----
    const systemPrompt = 'You design sales processes for entrepreneurs and independent sales professionals. '
      + 'A sales process is a sequence of Action Steps, where each Action Step leads to a Call Objective '
      + '(the outcome that must be true before moving on), and that objective connects into the next Action Step. '
      + 'Keep steps concrete, specific to the business described, and ordered from first contact to close. '
      + 'Respond with ONLY raw JSON — no markdown fences, no commentary.';

    let userMessage = `Business/context: ${description}\n`;
    if (motion) userMessage += `Sales motion: ${motion}\n`;
    userMessage += stepCount
      ? `Target step count: ${stepCount}\n`
      : 'Target step count: between 3 and 8, whatever best fits this process.\n';
    userMessage += 'Return a JSON array of step objects, each with exactly these keys: '
      + '"action" (specific action the seller takes), '
      + '"objective" (the call objective / outcome needed before the next step), '
      + '"tag" (one of: Discovery, Qualification, Demo, Proposal, Negotiation, Close, Follow-up, Other).';

    // ---- Call the Anthropic API ----
    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
    } catch (e) {
      return json({ message: 'Could not reach the AI service.' }, 502, corsHeaders);
    }

    if (!anthropicRes.ok) {
      return json({ message: 'AI service returned an error.' }, 502, corsHeaders);
    }

    const data = await anthropicRes.json();
    const textBlocks = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const clean = textBlocks.replace(/```json|```/g, '').trim();

    let steps;
    try {
      steps = JSON.parse(clean);
    } catch (e) {
      return json({ message: 'Could not parse a sales process from the AI response.' }, 502, corsHeaders);
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      return json({ message: 'Could not parse a sales process from the AI response.' }, 502, corsHeaders);
    }

    const cleaned = steps.slice(0, 8).map((s) => ({
      action: (s.action || '').toString(),
      objective: (s.objective || '').toString(),
      tag: (s.tag || 'Other').toString(),
    }));

    return json(cleaned, 200, corsHeaders);
  },
};

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
