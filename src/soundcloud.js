/**
 * SoundCloud, from the browser alone.
 *
 * Sign-in is OAuth 2.1 with PKCE against secure.soundcloud.com: the browser
 * sends the user to SoundCloud with a code challenge, is sent back with a
 * code, and exchanges it with the verifier - no client secret anywhere. The
 * tokens live in localStorage; access tokens last about an hour and refresh
 * tokens are single use, so a refresh always stores the new pair.
 *
 * One wrinkle: SoundCloud requires the app's client secret for the token
 * exchange even with PKCE, and a secret cannot live on a public page. So the
 * exchange goes through a small proxy that holds it (tools/soundcloud-proxy),
 * when one is configured; without one, only a secret kept in localStorage on
 * your own machine lets the page call SoundCloud directly.
 *
 * With a token, a SoundCloud URL resolves to a track, and a playable track's
 * `/streams` gives stream endpoints on the API - which need the token, so a
 * media element cannot fetch them - that redirect to a signed HLS playlist
 * on SoundCloud's CDN. The CDN allows cross-origin reads, so the page
 * fetches the playlist and its MP3 segments itself, joins them, and decodes
 * the whole track through the same path as a dropped file.
 *
 * SoundCloud's terms require attribution for playback in a custom player:
 * the uploader, SoundCloud as the source, and a link to the track's page.
 * `attribution()` gathers that from a track.
 */

const AUTH = 'https://secure.soundcloud.com';
const API = 'https://api.soundcloud.com';
const TOKENS = 'murmuration.soundcloud.tokens';
const PENDING = 'murmuration.soundcloud.pending';

export class SoundCloud {
  constructor({ clientId, redirectUri, tokenProxy }) {
    // Trimmed: a pasted value with a stray space or quote is refused by
    // SoundCloud as an invalid client, with nothing to say which.
    this.clientId = clean(clientId || readStored('murmuration.soundcloud.clientId'));
    this.redirectUri = redirectUri;
    this.tokenProxy = clean(tokenProxy || readStored('murmuration.soundcloud.tokenProxy'));
    this.clientSecret = clean(readStored('murmuration.soundcloud.clientSecret'));
    this.tokens = readJson(TOKENS);
  }

  get configured() { return Boolean(this.clientId); }

  /** Whether a sign-in could be completed: a proxy, or a local secret. */
  get canExchange() { return Boolean(this.tokenProxy || this.clientSecret); }

  get connected() { return Boolean(this.tokens?.refresh_token || (this.tokens?.access_token && !this.#expired())); }

  /**
   * Sends the user to SoundCloud to sign in. `pendingUrl` is what they were
   * about to play; it is kept for the return trip.
   */
  async connect(pendingUrl = '') {
    if (!this.configured) throw new Error('SoundCloud needs a client id - see src/config.js');
    if (!this.canExchange) throw new Error('SoundCloud needs the token proxy to finish a sign-in - see src/config.js');
    const verifier = randomString(64);
    const challenge = base64url(await sha256(verifier));
    const state = randomString(24);
    sessionStorage.setItem('murmuration.soundcloud.pkce', JSON.stringify({ verifier, state }));
    if (pendingUrl) sessionStorage.setItem(PENDING, pendingUrl);
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    location.assign(`${AUTH}/authorize?${params}`);
  }

  /**
   * Finishes a sign-in if this page load is the return trip: exchanges the
   * code, stores the tokens, cleans the URL. Returns the pending URL, if
   * any, or null when there was nothing to finish.
   */
  async handleRedirect() {
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code) return null;
    const pkce = readJson('murmuration.soundcloud.pkce', sessionStorage);
    sessionStorage.removeItem('murmuration.soundcloud.pkce');
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    history.replaceState(null, '', url.toString());
    if (!pkce || pkce.state !== state) throw new Error('the SoundCloud sign-in did not match this session - try again');
    await this.#exchange({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code_verifier: pkce.verifier,
      code,
    });
    const pending = sessionStorage.getItem(PENDING) || '';
    sessionStorage.removeItem(PENDING);
    return pending;
  }

  disconnect() {
    this.tokens = null;
    try { localStorage.removeItem(TOKENS); } catch { /* not available */ }
  }

  /** A SoundCloud URL to its track: id, title, uploader, access, artwork. */
  async resolve(trackUrl) {
    const track = await this.#get('/resolve', { url: trackUrl });
    if (track?.kind !== 'track') throw new Error('that SoundCloud link is not a track');
    return track;
  }

  /** The stream URLs of a track. Restricted tracks have none. */
  async streams(id) {
    return this.#get(`/tracks/${id}/streams`);
  }

  /** The signed-in user, for the panel. A token without a user behind it
   *  has no answer here; that is not a reason to sign out. */
  async me() {
    return this.#get('/me', {}, { keepOn401: true });
  }

  /** The stream to fetch: HLS in MP3 segments, which decode as one file
   *  once joined; else progressive MP3; else nothing usable. */
  static pickStream(streams) {
    if (!streams) return null;
    if (streams.hls_mp3_128_url) return { url: streams.hls_mp3_128_url, kind: 'hls' };
    if (streams.http_mp3_128_url) return { url: streams.http_mp3_128_url, kind: 'progressive' };
    return null;
  }

  /**
   * Downloads a track's audio as one MP3 buffer: for HLS, the playlist and
   * every segment, six at a time; for a progressive stream, the file.
   * `onProgress(done, total)` reports segments. Long tracks are refused
   * before download - decoded, an hour of stereo is over a gigabyte.
   */
  async fetchAudio(stream, { maxSeconds = 25 * 60, onProgress = () => {} } = {}) {
    const token = await this.#token();
    const auth = { Authorization: `OAuth ${token}` };
    if (stream.kind === 'progressive') {
      const res = await fetch(stream.url, { headers: auth });
      if (!res.ok) throw new Error(`SoundCloud would not serve the stream (${res.status})`);
      onProgress(1, 1);
      return res.arrayBuffer();
    }
    const res = await fetch(stream.url, { headers: auth });
    if (!res.ok) throw new Error(`SoundCloud would not serve the stream (${res.status})`);
    const playlist = parsePlaylist(await res.text(), res.url);
    if (!playlist.segments.length) throw new Error('the stream has no segments');
    if (playlist.duration > maxSeconds) {
      throw new Error(`that is ${Math.round(playlist.duration / 60)} minutes long - too much to hold decoded; capture a tab for long mixes`);
    }
    const parts = new Array(playlist.segments.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < playlist.segments.length) {
        const i = next++;
        const seg = await fetch(playlist.segments[i].url);
        if (!seg.ok) throw new Error(`a segment of the stream failed (${seg.status})`);
        parts[i] = new Uint8Array(await seg.arrayBuffer());
        onProgress(++done, playlist.segments.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, playlist.segments.length) }, worker));
    const total = parts.reduce((n, part) => n + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
    return joined.buffer;
  }

  /** What the terms ask a custom player to show. */
  static attribution(track) {
    return {
      title: track.title,
      artist: track.user?.username ?? 'unknown',
      trackUrl: track.permalink_url,
      artistUrl: track.user?.permalink_url ?? null,
      artwork: track.artwork_url ?? null,
    };
  }

  async #get(path, params = {}, { keepOn401 = false } = {}) {
    const token = await this.#token();
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Accept: 'application/json; charset=utf-8', Authorization: `OAuth ${token}` },
    });
    if (res.status === 401) {
      if (keepOn401) throw new Error('SoundCloud did not say who you are');
      this.disconnect();
      throw new Error('SoundCloud signed you out - connect again');
    }
    if (res.status === 429) throw new Error('SoundCloud is rate limiting - try again in a minute');
    if (!res.ok) throw new Error(`SoundCloud answered ${res.status}`);
    return res.json();
  }

  async #token() {
    if (!this.tokens) throw new Error('connect with SoundCloud first');
    if (this.#expired()) {
      if (!this.tokens.refresh_token) { this.disconnect(); throw new Error('the SoundCloud session expired - connect again'); }
      await this.#exchange({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: this.tokens.refresh_token,
      });
    }
    return this.tokens.access_token;
  }

  #expired() {
    return !this.tokens?.expires_at || Date.now() > this.tokens.expires_at - 30_000;
  }

  async #exchange(body) {
    let res;
    if (this.tokenProxy) {
      // The proxy adds the client id and secret and forwards the rest.
      const { client_id, ...rest } = body;
      res = await fetch(this.tokenProxy, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json; charset=utf-8' },
        body: JSON.stringify(rest),
      });
    } else {
      res = await fetch(`${AUTH}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' },
        body: new URLSearchParams({ ...body, client_secret: this.clientSecret }),
      });
    }
    if (!res.ok) {
      this.disconnect();
      let why = '';
      try { why = (await res.json()).error ?? ''; } catch { /* no body */ }
      throw new Error(`SoundCloud refused the sign-in (${res.status}${why ? `, ${why}` : ''})`);
    }
    const t = await res.json();
    this.tokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? null,
      expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
    };
    try { localStorage.setItem(TOKENS, JSON.stringify(this.tokens)); } catch { /* not available */ }
  }
}

/** An HLS media playlist: segment URLs (resolved against the playlist's)
 *  and durations. */
export function parsePlaylist(text, baseUrl) {
  const segments = [];
  let duration = 0;
  let pending = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      pending = parseFloat(line.slice(8)) || 0;
    } else if (!line.startsWith('#')) {
      segments.push({ url: new URL(line, baseUrl).href, duration: pending });
      duration += pending;
      pending = 0;
    }
  }
  return { segments, duration };
}

// -- PKCE ---------------------------------------------------------------------

export function randomString(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function clean(value) {
  return String(value ?? '').trim().replace(/^["']|["']$/g, '');
}

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function readJson(key, store) {
  try {
    const raw = (store ?? localStorage).getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
