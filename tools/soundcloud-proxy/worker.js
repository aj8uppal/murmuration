/**
 * SoundCloud token proxy: a Cloudflare Worker that holds the app's client
 * secret, which SoundCloud requires for the token exchange even with PKCE,
 * and which must never reach the browser. The page sends it the
 * authorization code and the PKCE verifier (or a refresh token); it adds
 * the secret, calls SoundCloud, and returns the tokens. It answers only
 * the page's own origin.
 *
 *   npx wrangler deploy
 *   npx wrangler secret put SC_CLIENT_SECRET
 *
 * Vars: SC_CLIENT_ID, ALLOWED_ORIGIN (in wrangler.toml); secret: SC_CLIENT_SECRET.
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = {
      'Access-Control-Allow-Origin': origin === env.ALLOWED_ORIGIN ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
    if (origin !== env.ALLOWED_ORIGIN) return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers: cors });

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400, cors); }
    const form = new URLSearchParams({ client_id: env.SC_CLIENT_ID, client_secret: env.SC_CLIENT_SECRET });
    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.code_verifier || !body.redirect_uri) return json({ error: 'missing fields' }, 400, cors);
      form.set('grant_type', 'authorization_code');
      form.set('code', body.code);
      form.set('code_verifier', body.code_verifier);
      form.set('redirect_uri', body.redirect_uri);
    } else if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return json({ error: 'missing fields' }, 400, cors);
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', body.refresh_token);
    } else {
      return json({ error: 'unsupported grant' }, 400, cors);
    }
    const upstream = await fetch('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' },
      body: form,
    });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
  },
};

function json(value, status, headers) {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
