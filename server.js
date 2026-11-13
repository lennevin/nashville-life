// The Nashville Life: local news → Claude drafts → approval queue → Facebook Page publisher, plus home-for-sale video Reels.
// Nothing is posted until a human approves it in /admin, and nothing reaches Facebook unless PUBLISH_ENABLED=true.
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const Parser = require('rss-parser');

const PORT = process.env.PORT || 3000;
const FB_PAGE_ID = process.env.FB_PAGE_ID || null; // The Nashville Life
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || null;
const FB_GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v26.0';
const FB_GRAPH = 'https://graph.facebook.com/' + FB_GRAPH_VERSION;
const PUBLISH_ENABLED = process.env.PUBLISH_ENABLED === 'true';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const DIGEST_TO = (process.env.DIGEST_EMAIL || 'len@loyaltyhomegroup.com').split(',').map(function(x) { return x.trim(); }).filter(Boolean);
const EMAIL_FROM = process.env.EMAIL_FROM || 'The Nashville Life <noreply@eliteagentsystems.com>'; // domain already verified in Resend (Lofty uses it)
const PUBLIC_URL = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT)).replace(/\/$/, '');
// Uploaded videos wait here until they post. On Railway this must be a volume, or uploads vanish on each deploy.
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'), 'videos');
const BOT_UA = 'Mozilla/5.0 (compatible; TheNashvilleLifeBot/1.0)';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
const anthropic = new Anthropic();
const rss = new Parser({ timeout: 20000, headers: { 'User-Agent': BOT_UA } });

// ── SOURCES ──────────────────────────────────────────────────────────────────
// scope 'nashville' = metro-wide outlets (Claude decides the place); 'metro' = one city or county around Nashville.
// Direct publisher feeds only, so links go straight to the article.
const SOURCES = [
  { key: 'wsmv', name: 'WSMV 4', scope: 'nashville', url: 'https://www.wsmv.com/arc/outboundfeeds/rss/category/news/?outputType=xml' },
  { key: 'wkrn', name: 'WKRN News 2', scope: 'nashville', url: 'https://www.wkrn.com/news/local-news/feed/' },
  { key: 'wtvf', name: 'NewsChannel 5', scope: 'nashville', url: 'https://www.newschannel5.com/news/local-news.rss' },
  { key: 'fox17', name: 'FOX 17', scope: 'nashville', url: 'https://fox17.com/news/local.rss' },
  { key: 'banner', name: 'Nashville Banner', scope: 'nashville', url: 'https://nashvillebanner.com/feed/' },
  { key: 'guru', name: 'Nashville Guru', scope: 'nashville', url: 'https://www.nashvilleguru.com/feed' }, // openings, things to do
  { key: 'williamson-source', name: 'Williamson Source', scope: 'metro', url: 'https://williamsonsource.com/feed/' },
  { key: 'rutherford-source', name: 'Rutherford Source', scope: 'metro', url: 'https://rutherfordsource.com/feed/' },
  { key: 'wilson-source', name: 'Wilson County Source', scope: 'metro', url: 'https://wilsoncountysource.com/feed/' },
  { key: 'maury-source', name: 'Maury County Source', scope: 'metro', url: 'https://maurycountysource.com/feed/' },
  { key: 'franklin', name: 'City of Franklin', scope: 'metro', url: 'https://www.franklintn.gov/Home/Components/RssFeeds/RssFeed/View?ctID=5' },
  { key: 'murfreesboro', name: 'City of Murfreesboro', scope: 'metro', url: 'https://www.murfreesborotn.gov/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml' },
  { key: 'spring-hill', name: 'City of Spring Hill', scope: 'metro', url: 'https://www.springhilltn.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml' },
  { key: 'columbia', name: 'City of Columbia', scope: 'metro', url: 'https://www.columbiatn.gov/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml' },
  { key: 'hendersonville', name: 'City of Hendersonville', scope: 'metro', url: 'https://www.hvilletn.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml' },
  { key: 'lebanon', name: 'City of Lebanon', scope: 'metro', url: 'https://www.lebanontn.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml' }
  // Tested 2026-11-13, not usable: Nashville Scene and Williamson Herald (429 to bots), Axios Nashville (403), The Tennessean (paywall),
  // Nashville Post (metered paywall), Eater Nashville (stale), Brentwood / Smyrna / Mt. Juliet / Gallatin city sites and the Main Street
  // Media papers (no working feed), Sumner County Source (timeouts).
];
// The core area: kept at relevance >= core_min_relevance. Anything else needs importance >= wider_min_importance.
const CORE_AREAS = ['Nashville', 'Williamson County', 'Rutherford County', 'Sumner County', 'Wilson County', 'Maury County'];
const AREAS = CORE_AREAS.concat(['Middle Tennessee', 'Tennessee', 'Other']);
const CATEGORIES = ['traffic_closures', 'events', 'community', 'government', 'schools', 'development_business', 'openings', 'public_safety', 'weather', 'other'];
// Draft kinds: news (from a feed item), video (a home-for-sale Reel Len uploaded), filler_photo / filler_fact /
// filler_question / filler_tip (slow-day community posts, no link).
const FILLER_TYPES = { filler_photo: 'photo of the week', filler_fact: 'did you know', filler_question: 'community question', filler_tip: 'local tip' };

// ── TIME (America/Chicago, with daylight saving) ─────────────────────────────
const TZ = 'America/Chicago';
const TZ_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Wall-clock parts in Nashville: { y, m (0-11), d, hour, min, wd (0 = Sunday) }.
function localParts(d) {
  var o = {};
  TZ_PARTS.formatToParts(d).forEach(function(p) { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month - 1, d: +o.day, hour: +o.hour % 24, min: +o.minute, wd: WEEKDAYS.indexOf(o.weekday) };
}
function localDateParts(d) { var p = localParts(d); return { y: p.y, m: p.m, d: p.d }; }
// The instant when Nashville clocks show hh:mm on that date (+ addDays). Two passes settle the CST/CDT offset.
function localSlotToDate(parts, hhmm, addDays) {
  var hm = hhmm.split(':');
  var wall = Date.UTC(parts.y, parts.m, parts.d + (addDays || 0), parseInt(hm[0], 10), parseInt(hm[1] || '0', 10));
  var t = wall + 6 * 3600 * 1000;
  for (var i = 0; i < 2; i++) { var p = localParts(new Date(t)); t += wall - Date.UTC(p.y, p.m, p.d, p.hour, p.min); }
  return new Date(t);
}
function localKey(d) { var p = localParts(d); return p.y + '-' + pad2(p.m + 1) + '-' + pad2(p.d); }
function dateKeyPlus(key, days) { var d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().substring(0, 10); }
function dayLabel(key) { return new Date(key + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }); }
function fmtLocal(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function toMinutes(hhmm) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }

// ── DATABASE ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  posts_per_day: '8',   // posting slots (news and videos together), spread evenly from first_post to last_post (Central time)
  first_post: '07:00',
  last_post: '21:00',
  digest_time: '06:30', // approval emails start (Central time); "off" = never
  email_until: '21:00', // no approval emails after this; overnight drafts go out at digest_time
  voice: 'Friendly, plain-spoken local news for Nashville-area neighbors. Warm but factual, never hype. Short sentences. ' +
         'At most one emoji, usually none. No hashtags except an occasional #Nashville.',
  badge_text: 'Loyalty Home Group | Real Broker', // "Brought to you by" badge on image cards; "off" hides it
  // Added to the end of every home video caption. Tennessee advertising rules want the firm name and the firm's phone number.
  firm_line: 'Loyalty Home Group | Real Broker, LLC',
  filler_per_day: '2',  // most slow-day community posts drafted for one day; 0 = off
  filler_last: '',      // date slow-day posts were last considered
  core_min_relevance: '6',
  wider_min_importance: '8'
};

async function initDb() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS feed_items (' +
    ' id SERIAL PRIMARY KEY, source_key TEXT NOT NULL, source_name TEXT, scope TEXT, url TEXT NOT NULL, url_hash TEXT UNIQUE NOT NULL,' +
    ' title TEXT NOT NULL, title_key TEXT, snippet TEXT, published_at TIMESTAMPTZ, fetched_at TIMESTAMPTZ DEFAULT NOW(),' +
    " status TEXT NOT NULL DEFAULT 'new'," + // new | duplicate | rejected | kept | drafted | draft_skipped | stale | error
    ' town TEXT, relevance INT, importance INT, category TEXT, sensitive BOOLEAN DEFAULT FALSE, reason TEXT, duplicate_of INT)');
  await pool.query('CREATE INDEX IF NOT EXISTS feed_items_status_idx ON feed_items (status)');
  await pool.query(
    'CREATE TABLE IF NOT EXISTS drafts (' +
    ' id SERIAL PRIMARY KEY, feed_item_id INT REFERENCES feed_items(id), town TEXT, category TEXT, sensitive BOOLEAN DEFAULT FALSE,' +
    ' message TEXT NOT NULL, link TEXT, warnings TEXT,' +
    " status TEXT NOT NULL DEFAULT 'pending'," + // pending | scheduled | publishing | published | failed | rejected | expired
    ' scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ, fb_post_id TEXT, error TEXT,' +
    ' created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),' +
    ' image_url TEXT,' +      // the article's own preview image (og:image); without one we post a photo post with a branded card
    ' card_headline TEXT, source_name TEXT, emailed_at TIMESTAMPTZ,' +
    ' photo TEXT,' +          // file in assets/photos, or "none" for the plain card
    " kind TEXT NOT NULL DEFAULT 'news'," +
    ' post_by TIMESTAMPTZ,' + // time-sensitive: no use after this
    ' video_file TEXT, video_info TEXT)'); // kind video: file in VIDEO_DIR, and the listing details Len entered (JSON)
  await pool.query('CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts (status)');
  await pool.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (var k in DEFAULT_SETTINGS) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, DEFAULT_SETTINGS[k]]);
  }
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

async function getSettings() {
  var r = await pool.query('SELECT key, value FROM settings');
  var s = Object.assign({}, DEFAULT_SETTINGS);
  r.rows.forEach(function(row) { s[row.key] = row.value; });
  return s;
}

// ── INGESTION ────────────────────────────────────────────────────────────────
function normalizeUrl(u) {
  try {
    var url = new URL(u);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'oc'].forEach(function(p) { url.searchParams.delete(p); });
    url.hash = '';
    return url.toString();
  } catch (e) { return u; }
}
function cleanTitle(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
function titleKey(t) { return t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function similar(a, b) {
  var A = new Set(a.split(' ').filter(function(w) { return w.length > 2; }));
  var B = new Set(b.split(' ').filter(function(w) { return w.length > 2; }));
  if (!A.size || !B.size) return 0;
  var inter = 0; A.forEach(function(w) { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}

var lastIngest = { at: null, added: 0, errors: [] };
async function ingest() {
  var recent = (await pool.query("SELECT id, title_key FROM feed_items WHERE fetched_at > NOW() - INTERVAL '7 days'")).rows;
  var added = 0, errors = [];
  var cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  for (var i = 0; i < SOURCES.length; i++) {
    var src = SOURCES[i];
    var feed;
    if (i) await new Promise(function(r) { setTimeout(r, 3000); }); // several feeds share a host; avoid 429s
    try { feed = await rss.parseURL(src.url); }
    catch (e) { errors.push(src.key + ': ' + e.message); continue; }
    for (var j = 0; j < (feed.items || []).length; j++) {
      var it = feed.items[j];
      if (!it.link || !it.title) continue;
      var pub = it.isoDate ? new Date(it.isoDate) : null;
      if (pub && pub.getTime() < cutoff) continue;
      var url = normalizeUrl(it.link);
      var title = cleanTitle(it.title);
      var tkey = titleKey(title);
      var dup = null;
      // The county "Source" sites share many stories under different URLs; the title match catches those.
      for (var k = 0; k < recent.length; k++) { if (recent[k].title_key && similar(tkey, recent[k].title_key) >= 0.6) { dup = recent[k].id; break; } }
      var snippet = (it.contentSnippet || it.content || it.summary || '').replace(/\s+/g, ' ').trim().substring(0, 2000);
      var r = await pool.query(
        'INSERT INTO feed_items (source_key, source_name, scope, url, url_hash, title, title_key, snippet, published_at, status, duplicate_of)' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (url_hash) DO NOTHING RETURNING id',
        [src.key, src.name, src.scope, url, crypto.createHash('sha256').update(url).digest('hex'), title, tkey, snippet, pub,
         dup ? 'duplicate' : 'new', dup]);
      if (r.rows.length) { added++; if (!dup) recent.push({ id: r.rows[0].id, title_key: tkey }); }
    }
  }
  lastIngest = { at: new Date().toISOString(), added: added, errors: errors };
  console.log('Ingest: added', added, 'items', errors.length ? '| errors: ' + errors.join('; ') : '');
  return added;
}

// ── CLAUDE ───────────────────────────────────────────────────────────────────
// Structured JSON output; server-side fallback so a classifier decline is retried on another model.
async function claudeJson(system, user, schema, effort, maxTokens) {
  var resp = await anthropic.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens || 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: effort || 'medium', format: { type: 'json_schema', schema: schema } },
    system: system,
    messages: [{ role: 'user', content: user }]
  });
  if (resp.stop_reason === 'refusal') throw new Error('Claude declined (' + ((resp.stop_details && resp.stop_details.category) || 'no category') + ')');
  if (resp.stop_reason === 'max_tokens') throw new Error('Claude hit max_tokens');
  var text = resp.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
  return JSON.parse(text);
}

const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'town', 'relevance', 'importance', 'category', 'sensitive', 'same_story_as', 'reason'],
    properties: {
      id: { type: 'integer' },
      town: { type: 'string', enum: AREAS, description: 'the area the story is about' },
      relevance: { type: 'integer', description: '0-10: how much this matters to people who live in Nashville and its surrounding counties' },
      importance: { type: 'integer', description: '0-10: how big the story is (10 = major interstate closure, severe weather, major development, district-wide school change)' },
      category: { type: 'string', enum: CATEGORIES },
      sensitive: { type: 'boolean', description: 'crime, tragedy, politics/elections, lawsuits, or criticism of a named person or business' },
      same_story_as: { type: 'integer', description: 'id of an earlier item (from this batch or the recent list) covering the same story, else 0' },
      reason: { type: 'string', description: 'one short sentence' }
    } } } }
};

async function scoreNew() {
  var s = await getSettings();
  var items = (await pool.query("SELECT id, source_name, scope, title, snippet, published_at FROM feed_items WHERE status = 'new' ORDER BY id LIMIT 25")).rows;
  if (!items.length) return 0;
  var recent = (await pool.query("SELECT id, title FROM feed_items WHERE status IN ('kept','drafted') AND fetched_at > NOW() - INTERVAL '5 days' ORDER BY id DESC LIMIT 80")).rows;
  var system = 'You screen local news for "The Nashville Life", a community Facebook Page for Nashville, Tennessee and the towns around it. ' +
    'For each item, identify the area it is about, how relevant it is to people who live here, how big the story is, a category, and whether it is sensitive.\n' +
    'Areas: Nashville = Davidson County (including Antioch, Bellevue, Donelson, Hermitage, Madison, Belle Meade, Berry Hill, Oak Hill, Goodlettsville). ' +
    'Williamson County = Franklin, Brentwood, Nolensville, Thompson\'s Station, Fairview. Rutherford County = Murfreesboro, Smyrna, La Vergne. ' +
    'Sumner County = Hendersonville, Gallatin, White House, Portland. Wilson County = Lebanon, Mt. Juliet, Watertown. Maury County = Columbia, Spring Hill, Mount Pleasant. ' +
    'Middle Tennessee = other places in the region (for example Clarksville, Dickson, Cookeville). Tennessee = statewide.\n' +
    'Nashville itself is the focus: Nashville stories that touch daily life score highest. Stories from the surrounding counties are good too when they matter beyond one street. ' +
    'Middle Tennessee and statewide stories matter only when they are big for Nashville-area residents (I-24, I-40, I-65 or I-440 closures, severe weather, major employers, state laws that change daily life).\n' +
    'New restaurants, shops and businesses opening (or coming soon) in the area are good community news: category openings, relevance 7 or more. ' +
    'Score low: routine council business, minor crimes, sports scores and roster moves, national chain menu items or promotions, product recalls with no local angle, press releases, and national stories that merely mention Nashville. ' +
    'If an item covers the same story as an earlier item (in this batch or the recent list), set same_story_as to that id. Return one entry per item.';
  var user = 'Recently accepted stories (for duplicate detection):\n' +
    (recent.map(function(r) { return '[' + r.id + '] ' + r.title; }).join('\n') || '(none)') +
    '\n\nItems to screen:\n' + items.map(function(it) {
      return '[' + it.id + '] (' + it.scope + ' feed, ' + it.source_name + ', ' + (it.published_at ? new Date(it.published_at).toISOString().substring(0, 10) : 'no date') + ') ' +
        it.title + '\n' + (it.snippet || '').substring(0, 600);
    }).join('\n\n');
  var out;
  try { out = await claudeJson(system, user, SCORE_SCHEMA, 'low', 8000); }
  catch (e) { console.error('Scoring error:', e.message); return 0; }
  var minRel = parseInt(s.core_min_relevance, 10) || 6, minImp = parseInt(s.wider_min_importance, 10) || 8;
  var byId = {}; (out.items || []).forEach(function(x) { byId[x.id] = x; });
  for (var i = 0; i < items.length; i++) {
    var x = byId[items[i].id];
    if (!x) continue; // left as 'new', retried next run
    var dup = x.same_story_as && x.same_story_as !== x.id;
    var keep = !dup && (CORE_AREAS.indexOf(x.town) >= 0 ? x.relevance >= minRel : x.importance >= minImp && x.relevance >= 5);
    await pool.query('UPDATE feed_items SET status=$2, town=$3, relevance=$4, importance=$5, category=$6, sensitive=$7, reason=$8, duplicate_of=$9 WHERE id=$1',
      [items[i].id, dup ? 'duplicate' : (keep ? 'kept' : 'rejected'), x.town, x.relevance, x.importance, x.category, x.sensitive, x.reason, x.same_story_as || null]);
  }
  console.log('Scoring: screened', items.length);
  return items.length;
}

// ── DRAFTING ─────────────────────────────────────────────────────────────────
const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['skip', 'skip_reason', 'post', 'card_headline'],
  properties: {
    skip: { type: 'boolean', description: 'true if this should not be posted (too thin, promotional, outdated, or cannot be summarized without opinion)' },
    skip_reason: { type: 'string' },
    post: { type: 'string', description: 'the Facebook post text, without the link' },
    card_headline: { type: 'string', description: 'a short headline in your own words for an image card, at most 70 characters, no ending period' }
  }
};

// The article's own preview image, if the publisher provides one. Facebook shows it in the link card.
// Site-wide placeholders and logos count as no image, so those posts get a photo card instead.
function isPlaceholderImage(img) { return /default[-_]?image|placeholder|\/logos?[\/._-]|og-default|share-default/i.test(img); }
async function findPreviewImage(url) {
  try {
    var r = await axios.get(url, { timeout: 15000, maxContentLength: 3 * 1024 * 1024, responseType: 'text', headers: { 'User-Agent': BOT_UA } });
    var html = String(r.data || '');
    var m = html.match(/<meta[^>]+(?:property|name)=["']og:image(?::url|:secure_url)?["'][^>]*>/i);
    if (!m) return null;
    var c = m[0].match(/content=["']([^"']+)["']/i);
    if (!c) return null;
    var img = c[1].replace(/&amp;/g, '&');
    if (isPlaceholderImage(img)) return null;
    return /^https?:\/\//i.test(img) ? img : new URL(img, url).toString();
  } catch (e) { return null; }
}

// ── IMAGE CARD ───────────────────────────────────────────────────────────────
// 1200x630 branded headline card for posts whose article has no image. Fonts are bundled (Inter, OFL) so
// rendering doesn't depend on fonts installed on the server.
const { Resvg } = require('@resvg/resvg-js');
const FONT_FILES = [path.join(__dirname, 'assets/fonts/Inter_700Bold.ttf'), path.join(__dirname, 'assets/fonts/Inter_500Medium.ttf')];
const CARD_COLORS = { traffic_closures: '#c2410c', events: '#7c3aed', community: '#0f766e', government: '#1d4ed8', schools: '#b45309',
  development_business: '#0e7490', openings: '#be185d', public_safety: '#b91c1c', weather: '#0369a1', other: '#334155' };
const CATEGORY_LABELS = { traffic_closures: 'traffic', development_business: 'development', openings: 'now open', public_safety: 'public safety', other: 'news' };
const NAVY = '#0b1530', GOLD = '#f2b544';

function wrapText(text, maxChars, maxLines) {
  var words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  var lines = [], line = '';
  for (var i = 0; i < words.length; i++) {
    var next = line ? line + ' ' + words[i] : words[i];
    if (next.length > maxChars && line) { lines.push(line); line = words[i]; } else { line = next; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}

// Len's own Nashville photos (assets/photos, described in photos.json; only photos Len took or owns). Cards use one as a
// full-bleed background with a light color boost; "none" (or an empty library) falls back to the plain skyline card.
var PHOTOS = [];
try {
  PHOTOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets/photos/photos.json'), 'utf8')).map(function(ph) {
    ph.data = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'assets/photos', ph.file)).toString('base64');
    return ph;
  });
} catch (e) { console.error('Photo library not loaded:', e.message); }
function photoByFile(f) { return PHOTOS.filter(function(ph) { return ph.file === f; })[0] || null; }

// Nashville skyline silhouette (the AT&T "Batman" building in the middle), same drawing as the Page's cover photo.
function skylineSvg(x0, base, s, fill) {
  function R(x, w, h) { return '<rect x="' + (x0 + x * s) + '" y="' + (base - h * s) + '" width="' + (w * s) + '" height="' + (h * s + 1) + '"/>'; }
  function P(pts) { return '<polygon points="' + pts.map(function(p) { return (x0 + p[0] * s) + ',' + (base - p[1] * s); }).join(' ') + '"/>'; }
  return '<g fill="' + fill + '">' +
    R(0, 40, 70) + R(36, 30, 110) + R(70, 46, 90) + R(118, 34, 150) + P([[118, 150], [135, 172], [152, 150]]) +
    R(156, 50, 125) + R(210, 38, 185) + R(214, 30, 196) + R(252, 52, 230) + R(260, 36, 252) + R(270, 16, 268) + R(277, 3, 290) + R(308, 42, 160) +
    R(356, 80, 300) + P([[356, 300], [356, 345], [372, 345], [372, 330], [388, 318], [404, 318], [420, 330], [420, 345], [436, 345], [436, 300]]) +
    P([[358, 345], [364, 420], [370, 345]]) + P([[422, 345], [428, 420], [434, 345]]) +
    R(440, 44, 205) + P([[440, 205], [462, 228], [484, 205]]) + R(488, 56, 175) + R(548, 36, 240) + R(552, 28, 252) +
    R(588, 48, 140) + R(640, 40, 195) + R(684, 54, 120) + R(742, 34, 165) + R(780, 60, 95) + R(844, 40, 60) + '</g>';
}

// Largest font size (up to max) at which the longest line fits the width; Inter Bold averages ~0.58em per character.
function fitSize(lines, max, width) {
  var longest = Math.max.apply(null, lines.map(function(l) { return l.length; }));
  return Math.min(max, Math.floor(width / (Math.max(longest, 1) * 0.58)));
}
function cardLabel(town, category) { return ((town && town !== 'Nashville' ? town + ' · ' : '') + (CATEGORY_LABELS[category] || String(category || 'news').replace(/_/g, ' '))).toUpperCase(); }
function labelPill(x, y, label, accent) {
  return '<rect x="' + x + '" y="' + y + '" rx="20" width="' + (label.length * 16.5 + 48) + '" height="40" fill="' + accent + '"/>' +
    '<text x="' + (x + 24) + '" y="' + (y + 28) + '" font-family="Inter" font-weight="700" font-size="22" letter-spacing="2" fill="#ffffff">' + esc(label) + '</text>';
}
// Bottom-right sponsor badge. The wording is a setting (badge_text) because the brokerage name must be exact.
function badgeSvg(badge) {
  if (!badge || badge === 'off') return '';
  var w = Math.max(230, Math.round(badge.length * 11.2) + 40), x = 1200 - 40 - w;
  return '<rect x="' + x + '" y="528" rx="12" width="' + w + '" height="64" fill="#ffffff" fill-opacity="0.94"/>' +
    '<text x="' + (x + 20) + '" y="553" font-family="Inter" font-weight="500" font-size="13" letter-spacing="1.5" fill="#64748b">BROUGHT TO YOU BY</text>' +
    '<text x="' + (x + 20) + '" y="580" font-family="Inter" font-weight="700" font-size="20" fill="#0f172a">' + esc(badge) + '</text>';
}

function cardSvg(headline, town, category, source, badge) {
  var accent = CARD_COLORS[category] || CARD_COLORS.other;
  var lines = wrapText(headline, 30, 4);
  var size = fitSize(lines, lines.length <= 2 ? 72 : lines.length === 3 ? 64 : 56, 1040);
  var lineH = Math.round(size * 1.18);
  var top = 300 - Math.round(((lines.length - 1) * lineH) / 2) + Math.round(size * 0.35);
  var text = lines.map(function(l, i) { return '<tspan x="80" y="' + (top + i * lineH) + '">' + esc(l) + '</tspan>'; }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">' +
    '<rect width="1200" height="630" fill="' + NAVY + '"/>' + skylineSvg(1200 - 884 * 0.62 - 10, 630, 0.62, '#16224a') +
    '<rect width="16" height="630" fill="' + accent + '"/>' +
    labelPill(80, 64, cardLabel(town, category), accent) +
    '<text font-family="Inter" font-weight="700" font-size="' + size + '" fill="#ffffff">' + text + '</text>' +
    '<text x="80" y="558" font-family="Inter" font-weight="700" font-size="30" fill="' + GOLD + '">The Nashville Life</text>' +
    '<text x="80" y="590" font-family="Inter" font-weight="500" font-size="20" fill="#94a3b8">' + esc(source ? 'Source: ' + source : '') + '</text>' +
    badgeSvg(badge) + '</svg>';
}

function photoCardSvg(headline, town, category, source, photo, badge) {
  var accent = CARD_COLORS[category] || CARD_COLORS.other;
  var lines = wrapText(headline, 32, 3);
  var size = fitSize(lines, lines.length <= 2 ? 62 : 54, 1080);
  var lineH = Math.round(size * 1.15);
  // headline: "top" in photos.json for photos whose subject sits low in the frame (sky on top, so the text goes there).
  var top = photo.headline === 'top';
  var first = top ? 120 + Math.round(size * 0.85) : 478 - (lines.length - 1) * lineH;
  var text = lines.map(function(l, i) { return '<tspan x="60" y="' + (first + i * lineH) + '">' + esc(l) + '</tspan>'; }).join('');
  // Cover-crop to 1200x630, keeping the photo's focus_y (0 = top, 1 = bottom) as close to the middle as possible.
  var sc = Math.max(1200 / photo.w, 630 / photo.h), iw = photo.w * sc, ih = photo.h * sc;
  var ix = (1200 - iw) / 2, iy = Math.min(0, Math.max(630 - ih, 315 - (photo.focus_y == null ? 0.5 : photo.focus_y) * ih));
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630"><defs>' +
    '<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="' + (top ? 0.7 : 0.25) + '" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="' + (top ? 0.75 : 0.88) + '"/></linearGradient>' +
    '<linearGradient id="topfade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="' + (top ? 0.8 : 0.45) + '"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>' +
    '<filter id="pop"><feColorMatrix type="saturate" values="1.15"/><feComponentTransfer>' +
    '<feFuncR type="linear" slope="1.08" intercept="-0.03"/><feFuncG type="linear" slope="1.08" intercept="-0.03"/><feFuncB type="linear" slope="1.08" intercept="-0.03"/></feComponentTransfer></filter>' +
    '<filter id="shadow" x="-5%" y="-30%" width="110%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#000" flood-opacity="0.7"/></filter></defs>' +
    '<image x="' + ix.toFixed(1) + '" y="' + iy.toFixed(1) + '" width="' + iw.toFixed(1) + '" height="' + ih.toFixed(1) + '" preserveAspectRatio="none" filter="url(#pop)" xlink:href="' + photo.data + '"/>' +
    '<rect width="1200" height="630" fill="url(#fade)"/><rect width="1200" height="' + (top ? 400 : 170) + '" fill="url(#topfade)"/>' +
    labelPill(60, 48, cardLabel(town, category), accent) +
    '<text font-family="Inter" font-weight="700" font-size="' + size + '" fill="#ffffff" filter="url(#shadow)">' + text + '</text>' +
    '<text x="60" y="560" font-family="Inter" font-weight="700" font-size="26" fill="#ffffff">The Nashville Life</text>' +
    '<text x="60" y="588" font-family="Inter" font-weight="500" font-size="18" fill="#cbd5e1">' + esc(source ? 'Source: ' + source : '') + '</text>' +
    badgeSvg(badge) + '</svg>';
}

function renderCard(headline, town, category, source, photoFile, badge) {
  var photo = photoByFile(photoFile);
  var svg = photo ? photoCardSvg(headline, town, category, source, photo, badge) : cardSvg(headline, town, category, source, badge);
  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
}
async function renderDraftCard(d) {
  var s = await getSettings();
  return renderCard(d.card_headline, d.town, d.category, d.source_name, d.photo, s.badge_text);
}

// Least recently used photo tagged for the category (any photo if none is tagged), so the Page doesn't repeat itself.
async function pickPhoto(category) {
  if (!PHOTOS.length) return null;
  var choices = PHOTOS.filter(function(ph) { return ph.categories.indexOf(category) >= 0; });
  if (!choices.length) choices = PHOTOS;
  var used = {};
  (await pool.query('SELECT photo, MAX(id) AS last FROM drafts WHERE photo IS NOT NULL GROUP BY photo')).rows.forEach(function(r) { used[r.photo] = r.last; });
  choices = choices.slice().sort(function(a, b) { return (used[a.file] || 0) - (used[b.file] || 0); });
  return choices[0].file;
}

function draftSystem(voice) {
  return 'You write posts for "The Nashville Life", a community Facebook Page for Nashville, Tennessee and the towns around it. Voice: ' + voice + '\n\n' +
    'Write an original 2-3 sentence summary of the story in your own words, then optionally one short, friendly, non-divisive question or tip that invites comments. ' +
    'Put the key facts first: what, where, when (dates, times, roads, cross streets) and what residents should do. End with "Source: <publisher>". The link is attached separately; do not include URLs.\n' +
    'For a business opening, write a neighborly "now open" or "coming soon" heads-up (what, where, when) with no hype, no endorsement and no ad copy.\n\n' + hardRules();
}
function fairHousingRules() {
  return '- Fair Housing: never describe an area, neighborhood or school as good, bad, safe, unsafe, desirable, exclusive, family-friendly or up-and-coming. ' +
    'Never mention or imply race, color, religion, national origin, sex, disability or family status of residents or buyers. Never use school quality as a selling point.\n';
}
function hardRules() {
  return 'Hard rules:\n' +
    '- Never copy sentences or distinctive phrases from the source. Summarize; do not reproduce.\n' +
    '- Only state facts given in the source. No speculation, no invented details, no quotes unless they are in the source.\n' +
    fairHousingRules() +
    '- No opinions on home prices, property values, or whether it is a good time to buy or sell. No real estate promotion.\n' +
    '- Crime and tragedy: neutral and brief, no names of suspects, victims or minors, no graphic detail.\n' +
    '- Politics and elections: strictly neutral, no endorsements or framing.\n' +
    '- Write as the Page, not as a resident or neighbor. Do not claim personal experience.';
}

// Deterministic second check. Flags for human review; does not block.
const WARN_PATTERNS = [
  [/\b(safe|safer|safest|unsafe|dangerous|sketchy|rough|bad|good|great|best|nice|quiet|desirable|exclusive|up[- ]and[- ]coming)\s+(area|areas|neighborhood|neighborhoods|part of town|side of town|community)\b/i, 'Fair Housing: area characterized'],
  [/\bfamily[- ]friendly\b|\bperfect for (a )?(young )?famil(y|ies)\b/i, 'Fair Housing: family status'],
  [/\b(good|great|top|best|excellent|highly[- ]rated|top[- ]rated|bad)\s+schools?\b/i, 'Fair Housing: school quality'],
  [/\b(white|black|hispanic|latino|latina|asian|caucasian|christian|jewish|muslim|mormon|lds|immigrants?)\b/i, 'Fair Housing: protected class mentioned — check context'],
  [/\b(home|property|house)\s+(values?|prices?)\b.*\b(rise|rising|increase|go up|drop|fall|falling)\b/i, 'Property value opinion'],
  [/\bgreat time to (buy|sell)\b|\binvest(ment)? opportunit/i, 'Real estate promotion'],
  [/https?:\/\//i, 'URL in post text (link is attached separately)']
];
// kind "video": the listing link belongs in a Reel caption, so the URL check is skipped there.
function checkWarnings(text, kind) {
  return WARN_PATTERNS.filter(function(p) { return p[0].test(text) && !(kind === 'video' && /^URL/.test(p[1])); }).map(function(p) { return p[1]; });
}

async function draftKept() {
  var s = await getSettings();
  // News goes stale: kept stories not drafted within 2 days are dropped instead of piling up.
  await pool.query("UPDATE feed_items SET status='stale' WHERE status='kept' AND fetched_at < NOW() - INTERVAL '2 days'");
  var items = (await pool.query("SELECT * FROM feed_items WHERE status = 'kept' ORDER BY importance DESC NULLS LAST, id LIMIT 10")).rows;
  var made = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var user = 'Area: ' + it.town + '\nCategory: ' + it.category + '\nPublisher: ' + it.source_name + '\nPublished: ' +
      (it.published_at ? new Date(it.published_at).toISOString().substring(0, 10) : 'unknown') +
      '\nHeadline: ' + it.title + '\nSource text:\n' + (it.snippet || '(headline only)') +
      (CORE_AREAS.indexOf(it.town) < 0 ? '\n\nThis story is from outside the Nashville area. Make clear why it matters to people who live in and around Nashville.' : '');
    var out;
    try { out = await claudeJson(draftSystem(s.voice), user, DRAFT_SCHEMA, 'medium', 4000); }
    catch (e) {
      console.error('Draft error for item', it.id, e.message);
      await pool.query("UPDATE feed_items SET status='error', reason=COALESCE(reason,'') || ' | draft error: ' || $2 WHERE id=$1", [it.id, e.message]);
      continue;
    }
    if (out.skip || !out.post) {
      await pool.query("UPDATE feed_items SET status='draft_skipped', reason=COALESCE(reason,'') || ' | skipped: ' || $2 WHERE id=$1", [it.id, out.skip_reason || 'empty']);
      continue;
    }
    var warnings = checkWarnings(out.post);
    var image = await findPreviewImage(it.url);
    var photo = image ? null : await pickPhoto(it.category);
    await pool.query('INSERT INTO drafts (feed_item_id, town, category, sensitive, message, link, warnings, image_url, card_headline, source_name, photo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [it.id, it.town, it.category, it.sensitive, out.post.trim(), it.url, warnings.join('; ') || null, image,
       (out.card_headline || it.title).substring(0, 90), it.source_name, photo]);
    await pool.query("UPDATE feed_items SET status='drafted' WHERE id=$1", [it.id]);
    made++;
  }
  if (items.length) console.log('Drafting: created', made, 'of', items.length);
  return made;
}

async function insertDraft(d) {
  var warnings = checkWarnings(d.message, d.kind).concat(d.extraWarnings || []);
  var r = await pool.query('INSERT INTO drafts (kind, town, category, sensitive, message, link, warnings, image_url, card_headline, source_name, photo, post_by, video_file, video_info) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13) RETURNING id',
    [d.kind, d.town || 'Nashville', d.category, !!d.sensitive, d.message.trim(), d.link || null, warnings.join('; ') || null, (d.card_headline || '').substring(0, 90),
     d.source_name || null, d.photo || null, d.post_by || null, d.video_file || null, d.video_info ? JSON.stringify(d.video_info) : null]);
  return r.rows[0].id;
}

// Slow days: from 2pm, once a day, look at tomorrow. If scheduled posts plus drafts waiting for approval leave
// open slots, Claude drafts up to filler_per_day community posts. They still need approval like everything else.
const FILLER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posts'],
  properties: { posts: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['type', 'post', 'card_headline', 'photo_file'],
    properties: {
      type: { type: 'string', enum: Object.keys(FILLER_TYPES) },
      post: { type: 'string' },
      card_headline: { type: 'string', description: 'at most 60 characters, no ending period' },
      photo_file: { type: 'string', description: 'for filler_photo: the file name of the photo the post is about; otherwise ""' }
    } } } }
};
async function draftFiller() {
  var s = await getSettings();
  var max = parseInt(s.filler_per_day, 10) || 0;
  var now = new Date(), today = localKey(now);
  if (!max || localParts(now).hour < 14 || s.filler_last === today) return 0;
  await pool.query("INSERT INTO settings (key, value) VALUES ('filler_last', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [today]);
  var tStart = localSlotToDate(localDateParts(now), '00:00', 1), tEnd = localSlotToDate(localDateParts(now), '00:00', 2);
  var booked = parseInt((await pool.query("SELECT COUNT(*) AS c FROM drafts WHERE status IN ('scheduled','publishing','published') AND scheduled_at >= $1 AND scheduled_at < $2", [tStart, tEnd])).rows[0].c, 10);
  var waiting = parseInt((await pool.query("SELECT COUNT(*) AS c FROM drafts WHERE status='pending'")).rows[0].c, 10);
  var open = slotTimes(s).length - booked - waiting;
  var n = Math.min(max, open);
  if (n <= 0) { console.log('Filler: tomorrow is full (' + booked + ' scheduled, ' + waiting + ' waiting)'); return 0; }
  var recent = (await pool.query("SELECT kind, message, created_at FROM drafts WHERE kind LIKE 'filler%' ORDER BY id DESC LIMIT 25")).rows;
  var photoWeek = recent.some(function(r) { return r.kind === 'filler_photo' && Date.now() - new Date(r.created_at).getTime() < 6 * 86400000; });
  var types = Object.keys(FILLER_TYPES).filter(function(t) { return t !== 'filler_photo' || (!photoWeek && PHOTOS.length); });
  var out;
  try {
    out = await claudeJson('You write posts for "The Nashville Life", a community Facebook Page for Nashville, Tennessee and the towns around it. Voice: ' + s.voice + '\n\n' +
      'It is a slow news day. Write ' + n + ' short community post' + (n === 1 ? '' : 's') + ' for tomorrow, each a different type from: ' +
      types.map(function(t) { return t + ' (' + FILLER_TYPES[t] + ')'; }).join(', ') + '.\n' +
      '- filler_photo: a warm caption for one of the Page\'s own photos listed below, describing only what the photo label says. Set photo_file to that file.\n' +
      '- filler_fact: one well-documented fact about Nashville or Middle Tennessee history, music history or landmarks. Only facts you are highly confident about; if unsure, pick another type. No dates or numbers you are not sure of.\n' +
      '- filler_question: one light, fun question that invites comments (favorite hot chicken spot, best place to catch live music, favorite park or greenway, go-to Saturday breakfast). ' +
      'Never ask about the best or worst neighborhood, area or school, never about home prices, never anything political or divisive.\n' +
      '- filler_tip: a seasonal, practical tip for Middle Tennessee residents (severe weather and tornado safety, winter ice, summer heat, allergy season, holiday safety). General advice only; no event dates, prices or programs that are not given here.\n' +
      'Each post is 1-3 sentences, plain and friendly, no links, no hashtags except an occasional #Nashville. Do not repeat a recent post.\n\n' + hardRules(),
      'Tomorrow: ' + dayLabel(dateKeyPlus(today, 1)) + '\n\nPage photos:\n' + (PHOTOS.map(function(ph) { return '- ' + ph.file + ': ' + ph.label; }).join('\n') || '(none)') +
      '\n\nRecent community posts (do not repeat):\n' + (recent.map(function(r) { return '- ' + r.message.replace(/\s+/g, ' ').substring(0, 160); }).join('\n') || '(none)'),
      FILLER_SCHEMA, 'medium', 4000);
  } catch (e) { console.error('Filler draft error:', e.message); return 0; }
  var made = 0;
  for (var i = 0; i < (out.posts || []).length && made < n; i++) {
    var f = out.posts[i];
    if (!f.post || types.indexOf(f.type) < 0) continue;
    var photo = f.type === 'filler_photo' && photoByFile(f.photo_file) ? f.photo_file : await pickPhoto('community');
    await insertDraft({ kind: f.type, category: 'community', message: f.post, card_headline: f.card_headline, photo: photo,
      extraWarnings: f.type === 'filler_fact' ? ['Check the fact before approving'] : [] });
    made++;
  }
  console.log('Filler: drafted', made, 'for tomorrow (' + booked + ' scheduled, ' + waiting + ' waiting, ' + slotTimes(s).length + ' slots)');
  return made;
}

// ── HOME VIDEOS (Reels) ──────────────────────────────────────────────────────
// Len uploads a vertical home-for-sale video in /admin with a link to the listing. The server reads the listing page,
// Claude writes the caption from it, the link and the firm line are added at the end, and it waits in the queue like any
// other draft. Once approved it takes the next open slot and posts as a Reel. Videos never expire from the queue.
const VIDEO_CAPTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'address', 'city', 'caption'],
  properties: {
    found: { type: 'boolean', description: 'true if the listing details include at least the address or the price' },
    address: { type: 'string', description: 'street address of the home, or "" if not given' },
    city: { type: 'string', description: 'city or area of the home (for example Franklin or East Nashville), or "" if not given' },
    caption: { type: 'string', description: 'the Reel caption, without the link or the brokerage line' }
  }
};
function stripTags(html) {
  return String(html || '').replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
// What the listing page says about the home: title, description, structured data (JSON-LD) and the start of the page text.
// Many listing sites render with JavaScript or block bots, so this can come back thin; the caption then says less.
async function readListing(url) {
  var r = await axios.get(url, { timeout: 20000, maxContentLength: 5 * 1024 * 1024, responseType: 'text', headers: { 'User-Agent': BOT_UA } });
  var html = String(r.data || '');
  function meta(name) {
    var m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + name + '["\'][^>]*>', 'i'));
    var c = m && m[0].match(/content=["']([^"']*)["']/i);
    return c ? stripTags(c[1]) : '';
  }
  var title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  var ld = [];
  html.replace(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi, function(m, j) { ld.push(j.replace(/\s+/g, ' ').trim()); return m; });
  return ['Page title: ' + stripTags(title || meta('og:title')), 'Description: ' + (meta('og:description') || meta('description')),
    ld.length ? 'Structured data: ' + ld.join(' ').substring(0, 5000) : '', 'Page text: ' + stripTags(html).substring(0, 5000)].filter(Boolean).join('\n');
}
// Problems Facebook or the Tennessee advertising rules would have with this video. Flags only; Len decides.
function videoWarnings(info, firmLine) {
  var w = [];
  var dur = parseFloat(info.duration), vw = parseInt(info.width, 10), vh = parseInt(info.height, 10);
  if (dur && (dur < 3 || dur > 90)) w.push('Reels must be 3-90 seconds (this is ' + Math.round(dur) + 's)');
  if (vw && vh && vh <= vw) w.push('Video is not vertical (' + vw + 'x' + vh + '); Reels need 9:16');
  else if (vw && vh && Math.min(vw, vh) < 540) w.push('Video is small (' + vw + 'x' + vh + '); Reels need at least 540x960');
  if (!/\d{3}\D{0,3}\d{3}\D{0,3}\d{4}/.test(firmLine || '')) w.push('Add your firm phone number to the brokerage line in Settings (TN advertising rule)');
  if (info.own_listing === 'no') w.push('Not your listing: you need the listing broker\'s written OK before posting');
  if (info.listing_url && !info.page_read) w.push('Could not read the listing page; check the caption details');
  return w;
}
// The end of every Reel caption: the listing link, "Listing courtesy of" for another broker's listing, then the firm line.
function brokerageLines(info, firmLine) {
  var lines = [];
  if (info.listing_url) lines.push('Full listing: ' + info.listing_url);
  if (info.own_listing === 'no' && info.listing_brokerage) lines.push('Listing courtesy of ' + info.listing_brokerage);
  if (firmLine) lines.push(firmLine);
  return lines.join('\n');
}
async function draftVideo(info, file) {
  var s = await getSettings();
  var caption = (info.caption || '').trim(), page = '';
  if (info.listing_url) {
    try { page = await readListing(info.listing_url); } catch (e) { console.error('Listing page error:', info.listing_url, e.message); }
  }
  try {
    var out = await claudeJson('You write captions for home-for-sale video Reels on "The Nashville Life", a community Facebook Page for Nashville, Tennessee. Voice: ' + s.voice + '\n\n' +
      'From the listing details below, pull out the street address and city, and write a short caption (3-5 short lines): a one-line hook about the home, ' +
      'the key facts (city or area, price, beds, baths, square feet) and two or three standout features, then "Message us for details or a private tour." ' +
      'Use only facts stated in the listing details; never invent features, prices or nearby places. Ignore site menus, ads and other listings on the page. ' +
      'Up to 3 hashtags at the end, such as #NashvilleHomes or the city name plus "RealEstate". Do not add a link, brokerage name or phone number; those are added separately. ' +
      'If Len wrote his own caption, keep it as written and only fill in address and city.\n\n' +
      'Hard rules:\n' + fairHousingRules() +
      '- Describe the home, not who should live there: no "perfect for families", "ideal for empty nesters", "great for young professionals" or similar.\n' +
      '- No claims about the neighborhood\'s safety or character, and no school names or ratings.\n' +
      '- No predictions about values or investment returns.',
      (caption ? 'Len\'s caption:\n' + caption + '\n\n' : '') + 'Listing link: ' + (info.listing_url || '(none)') +
      (info.details ? '\nListing description Len pasted:\n' + info.details : '') + '\nListing page:\n' + (page || '(the listing page could not be read)'),
      VIDEO_CAPTION_SCHEMA, 'medium', 3000);
    info.page_read = !!((page || info.details) && out.found); // "page_read" = Claude had real listing details to work from
    info.address = out.address || '';
    info.city = out.city || '';
    if (!caption && out.found) caption = (out.caption || '').trim();
  } catch (e) { console.error('Video caption error:', e.message); }
  if (!caption) caption = 'New on the market' + (info.city ? ' in ' + info.city : '') + '. Message us for details or a private tour.';
  var tail = brokerageLines(info, s.firm_line);
  return insertDraft({ kind: 'video', town: info.city || 'Nashville', category: 'real_estate', message: caption + (tail ? '\n\n' + tail : ''),
    card_headline: info.address || 'Home video', video_file: file, video_info: info, extraWarnings: videoWarnings(info, s.firm_line) });
}
function videoPath(file) { return path.join(VIDEO_DIR, path.basename(String(file || ''))); }
function removeVideo(file) { if (file) fs.unlink(videoPath(file), function() {}); }

// Graph API Reels flow: start → upload the bytes to rupload → finish with video_state=PUBLISHED.
// Each step's error names the step; rupload reports errors as debug_info instead of Graph's error object.
async function reelStep(step, fn) {
  try { return await fn(); }
  catch (e) {
    var data = e.response && e.response.data, fb = data && (data.error || data.debug_info);
    throw new Error('Reel ' + step + ' step: ' + (fb ? (fb.message || JSON.stringify(fb)) + (fb.code ? ' (code ' + fb.code + ')' : '') : e.message));
  }
}
async function postReel(d) {
  var file = videoPath(d.video_file);
  var size = fs.statSync(file).size;
  var start = await reelStep('start', function() {
    return axios.post(FB_GRAPH + '/' + FB_PAGE_ID + '/video_reels', new URLSearchParams({ upload_phase: 'start', access_token: FB_PAGE_TOKEN }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
  });
  var videoId = start.data.video_id;
  var uploadUrl = start.data.upload_url || ('https://rupload.facebook.com/video-upload/' + FB_GRAPH_VERSION + '/' + videoId);
  await reelStep('upload', function() {
    return axios.post(uploadUrl, fs.createReadStream(file), {
      headers: { Authorization: 'OAuth ' + FB_PAGE_TOKEN, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 15 * 60 * 1000 });
  });
  var fin = await reelStep('finish', function() {
    return axios.post(FB_GRAPH + '/' + FB_PAGE_ID + '/video_reels', new URLSearchParams({
      upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: d.message, access_token: FB_PAGE_TOKEN }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 60000 });
  });
  if (!fin.data || fin.data.success === false) throw new Error('Reel finish step failed: ' + JSON.stringify(fin.data));
  return 'reel:' + videoId;
}

var pipelineRunning = false;
async function runPipeline() {
  if (pipelineRunning) return;
  pipelineRunning = true;
  var drafted = 0;
  try {
    await ingest();
    for (var n = 0; n < 8; n++) { if (!(await scoreNew())) break; } // up to 200 items per run
    drafted = await draftKept();
    drafted += await draftFiller();
    // News goes stale: drafts nobody approved within 3 days drop out of the queue. Videos stay until Len decides.
    await pool.query("UPDATE drafts SET status='expired', updated_at=NOW() WHERE status='pending' AND kind <> 'video' AND (created_at < NOW() - INTERVAL '3 days' OR post_by < NOW())");
  } catch (e) { console.error('Pipeline error:', e.message); }
  finally { pipelineRunning = false; }
  // New drafts → approval email right away (inside email hours; otherwise the morning email picks them up).
  if (drafted) await sendDigest(false).catch(function(e) { console.error('Digest error:', e.message); });
}

// ── SCHEDULING & PUBLISHING ──────────────────────────────────────────────────
// Evenly spaced posting times, rounded to 5 minutes. 8 posts from 07:00 to 21:00 → 07:00, 09:00, 11:00, ... 21:00.
function slotTimes(s) {
  var n = Math.max(1, Math.min(12, parseInt(s.posts_per_day, 10) || 8));
  var a = toMinutes(s.first_post), b = toMinutes(s.last_post);
  if (a === null) a = 7 * 60;
  if (b === null || b <= a) b = Math.min(a + 14 * 60, 23 * 60);
  var out = [];
  for (var i = 0; i < n; i++) {
    var m = n === 1 ? a : Math.round((a + (b - a) * i / (n - 1)) / 5) * 5;
    out.push(pad2(Math.floor(m / 60)) + ':' + pad2(m % 60));
  }
  return out;
}

// deadline: a time-sensitive draft (post_by) that can't make a regular slot in time posts as soon as possible.
async function nextFreeSlot(deadline) {
  var s = await getSettings();
  var slots = slotTimes(s);
  var cap = slots.length;
  var taken = (await pool.query("SELECT scheduled_at FROM drafts WHERE status IN ('scheduled','publishing','published') AND scheduled_at > NOW() - INTERVAL '1 day'")).rows
    .map(function(r) { return new Date(r.scheduled_at).getTime(); });
  var today = localDateParts(new Date());
  var soonest = Date.now() + 5 * 60 * 1000;
  var gap = 45 * 60 * 1000; // never two posts within 45 minutes
  for (var day = 0; day < 30; day++) {
    var dayStart = localSlotToDate(today, '00:00', day).getTime(), dayEnd = localSlotToDate(today, '00:00', day + 1).getTime();
    var onDay = taken.filter(function(x) { return x >= dayStart && x < dayEnd; }).length;
    if (onDay >= cap) continue;
    for (var i = 0; i < slots.length; i++) {
      var t = localSlotToDate(today, slots[i], day).getTime();
      if (t < soonest) continue;
      if (taken.some(function(x) { return Math.abs(x - t) < gap; })) continue;
      if (deadline && t > new Date(deadline).getTime()) return new Date(soonest);
      return new Date(t);
    }
  }
  return new Date(soonest);
}

// Article has its own image → link post (Facebook builds the card: article photo + clickable link).
// Everything else (no article image, community posts) → photo post with a card; any link goes in the text. Videos → Reel.
function photoCaption(d) { return d.message + (d.link ? '\n\nRead more: ' + d.link : ''); }

async function postToFacebook(d) {
  if (!FB_PAGE_TOKEN) throw new Error('FB_PAGE_TOKEN not set');
  if (!FB_PAGE_ID) throw new Error('FB_PAGE_ID not set');
  try {
    if (d.kind === 'video') return await postReel(d);
    if (d.image_url && d.link) {
      var body = new URLSearchParams({ message: d.message, access_token: FB_PAGE_TOKEN });
      body.append('link', d.link);
      var r = await axios.post(FB_GRAPH + '/' + FB_PAGE_ID + '/feed', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
      return r.data.id;
    }
    var png = await renderDraftCard(d);
    var form = new FormData();
    form.append('caption', photoCaption(d));
    form.append('access_token', FB_PAGE_TOKEN);
    form.append('source', new Blob([png], { type: 'image/png' }), 'nashville-life.png');
    var p = await axios.post(FB_GRAPH + '/' + FB_PAGE_ID + '/photos', form, { timeout: 60000 });
    return p.data.post_id || p.data.id;
  } catch (e) {
    var fb = e.response && e.response.data && e.response.data.error;
    throw new Error(fb ? fb.message + ' (code ' + fb.code + ')' : e.message);
  }
}
function postUrl(fbId) {
  var id = String(fbId || '');
  if (id.indexOf('reel:') === 0) return 'https://www.facebook.com/reel/' + id.substring(5);
  var parts = id.split('_');
  return parts.length === 2 ? 'https://www.facebook.com/' + parts[0] + '/posts/' + parts[1] : '#';
}

var lastPublish = { at: null, result: null };
// Approve a pending draft into the next open time (before its post_by, if it has one). Returns the time, or null.
async function scheduleDraft(id) {
  var d = (await pool.query("SELECT post_by FROM drafts WHERE id=$1 AND status='pending'", [id])).rows[0];
  if (!d) return null;
  var slot = await nextFreeSlot(d.post_by);
  var u = await pool.query("UPDATE drafts SET status='scheduled', scheduled_at=$2, updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING id", [id, slot]);
  return u.rows.length ? slot : null;
}
async function rejectDraft(id) {
  var r = await pool.query("UPDATE drafts SET status='rejected', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING video_file", [id]);
  if (r.rows.length) removeVideo(r.rows[0].video_file);
  return r.rows.length > 0;
}

async function publishDue() {
  // A post more than an hour past its slot (publishing was off, or the app was down) moves to the next open
  // slot instead of going out late in a burst. "Post now" sets scheduled_at=NOW, so it is never affected.
  await pool.query("UPDATE drafts SET status='expired', updated_at=NOW() WHERE status='scheduled' AND post_by < NOW()"); // missed its moment
  var late = (await pool.query("SELECT id, post_by FROM drafts WHERE status='scheduled' AND scheduled_at < NOW() - INTERVAL '60 minutes' ORDER BY scheduled_at")).rows;
  for (var j = 0; j < late.length; j++) {
    var slot = await nextFreeSlot(late[j].post_by);
    await pool.query("UPDATE drafts SET scheduled_at=$2, updated_at=NOW() WHERE id=$1 AND status='scheduled'", [late[j].id, slot]);
    console.log('Publisher: draft', late[j].id, 'missed its slot; moved to', fmtLocal(slot));
  }
  var due = (await pool.query("SELECT id FROM drafts WHERE status='scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at LIMIT 3")).rows;
  if (!due.length) return;
  if (!PUBLISH_ENABLED) { console.log('Publisher:', due.length, 'due but PUBLISH_ENABLED is not true; leaving them scheduled'); return; }
  for (var i = 0; i < due.length; i++) {
    // Claim the row first so overlapping runs can never post the same draft twice.
    var claim = await pool.query("UPDATE drafts SET status='publishing', updated_at=NOW() WHERE id=$1 AND status='scheduled' RETURNING *", [due[i].id]);
    if (!claim.rows.length) continue;
    var d = claim.rows[0];
    try {
      var postId = await postToFacebook(d);
      await pool.query("UPDATE drafts SET status='published', fb_post_id=$2, published_at=NOW(), error=NULL, updated_at=NOW() WHERE id=$1", [d.id, postId]);
      if (d.kind === 'video') removeVideo(d.video_file); // Facebook has it now; free the volume
      lastPublish = { at: new Date().toISOString(), result: 'published draft ' + d.id + ' as ' + postId };
      console.log('Publisher: posted draft', d.id, postId);
    } catch (e) {
      await pool.query("UPDATE drafts SET status='failed', error=$2, updated_at=NOW() WHERE id=$1", [d.id, e.message]);
      lastPublish = { at: new Date().toISOString(), result: 'draft ' + d.id + ' failed: ' + e.message };
      console.error('Publisher: draft', d.id, 'failed:', e.message);
    }
  }
}

// ── ADMIN UI ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function csrfToken() { return crypto.createHmac('sha256', ADMIN_PASSWORD || 'unset').update('csrf').digest('hex').substring(0, 32); }

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Set ADMIN_PASSWORD in Railway to use the admin page.');
  var h = req.headers.authorization || '';
  var pass = h.indexOf('Basic ') === 0 ? Buffer.from(h.substring(6), 'base64').toString().split(':').slice(1).join(':') : '';
  var a = Buffer.from(crypto.createHash('sha256').update(pass).digest('hex'));
  var b = Buffer.from(crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex'));
  if (!crypto.timingSafeEqual(a, b)) { res.set('WWW-Authenticate', 'Basic realm="The Nashville Life admin"'); return res.status(401).send('Login required'); }
  // The video upload is multipart (no parsed body), so it sends the form token in a header.
  if (req.method === 'POST' && ((req.body && req.body._csrf) || req.get('x-csrf')) !== csrfToken()) return res.status(403).send('Bad form token; reload the page.');
  next();
}

const CSS = 'body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f4f5f7;color:#1c1e21}main{max-width:820px;margin:0 auto;padding:16px}' +
  'h1{font-size:22px;margin:8px 0}h2{font-size:17px;margin:24px 0 8px}.card{background:#fff;border-radius:10px;padding:14px;margin:10px 0;box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
  '.meta{font-size:13px;color:#65676b;margin-bottom:6px}.tag{display:inline-block;font-size:12px;padding:2px 7px;border-radius:9px;background:#e7f0fe;color:#1a56c4;margin-right:4px}' +
  '.tag.warn{background:#fdecea;color:#b3261e}.tag.sens{background:#fff4e5;color:#8a4b00}textarea{width:100%;box-sizing:border-box;min-height:110px;font:inherit;padding:8px;border:1px solid #ccd0d5;border-radius:6px}' +
  'button{font:inherit;padding:7px 12px;border-radius:6px;border:1px solid #ccd0d5;background:#fff;cursor:pointer;margin:6px 6px 0 0}button.primary{background:#1877f2;color:#fff;border-color:#1877f2}' +
  'button.danger{color:#b3261e}.row{display:flex;flex-wrap:wrap;align-items:center}a{color:#1a56c4}.status{font-size:14px}.status b{font-weight:600}' +
  'input[type=text],select{font:inherit;padding:6px;border:1px solid #ccd0d5;border-radius:6px;width:100%;box-sizing:border-box}' +
  'details{margin:8px 0}summary{cursor:pointer;color:#65676b}img.pv{width:100%;max-width:520px;aspect-ratio:1200/630;object-fit:cover;border-radius:8px;display:block;margin:4px 0 10px;background:#e4e6eb}' +
  'video.pv{width:100%;max-width:300px;aspect-ratio:9/16;border-radius:8px;display:block;margin:4px 0 10px;background:#000}' +
  '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.grid label{font-size:13px;color:#65676b}progress{width:100%}';

function kindLabel(d) { return d.kind === 'video' ? 'home video (Reel)' : FILLER_TYPES[d.kind] || ''; }
function draftCard(d, csrf) {
  var tags = (kindLabel(d) ? '<span class="tag">' + esc(kindLabel(d)) + '</span>' : '') + (d.post_by ? '<span class="tag warn">post by ' + esc(fmtLocal(d.post_by)) + '</span>' : '') + '<span class="tag">' + esc(d.town) + '</span><span class="tag">' + esc((d.category || '').replace(/_/g, ' ')) + '</span>' +
    (d.sensitive ? '<span class="tag sens">sensitive</span>' : '') +
    (d.warnings ? d.warnings.split('; ').map(function(w) { return '<span class="tag warn">' + esc(w) + '</span>'; }).join('') : '');
  var src = d.feed_item_id ? '<div class="meta">' + esc(d.source_name) + ' · <a href="' + esc(d.link) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a>' +
    ' · relevance ' + esc(d.relevance) + ' / importance ' + esc(d.importance) + '</div>'
    : '<div class="meta">' + (d.kind === 'video' ? esc(d.card_headline) : d.source_name ? esc(d.source_name) : 'The Nashville Life community post') + '</div>';
  var preview = d.kind === 'video'
    ? '<div class="meta">Reel: posts as a vertical video with this caption</div><video class="pv" controls preload="metadata" src="/admin/video/' + d.id + '"></video>'
    : d.image_url
    ? '<div class="meta">Link post: Facebook shows the article\'s photo and link</div><img class="pv" src="' + esc(d.image_url) + '" alt="" loading="lazy">'
    : '<div class="meta">Photo post: image card, with the article link added at the end of the text</div><img class="pv" src="/admin/card/' + d.id + '.png?v=' + encodeURIComponent(d.updated_at ? new Date(d.updated_at).getTime() : 0) + '" alt="" loading="lazy">';
  return '<div class="card"><div>' + tags + '</div>' + src + preview +
    '<form method="post" action="/admin/draft/' + d.id + '"><input type="hidden" name="_csrf" value="' + csrf + '">' +
    '<textarea name="message">' + esc(d.message) + '</textarea>' +
    (d.image_url || d.kind === 'video' ? '' : '<label class="meta">Card headline<input type="text" name="card_headline" maxlength="90" value="' + esc(d.card_headline) + '"></label>' +
      (PHOTOS.length ? '<label class="meta">Photo <select name="photo">' + PHOTOS.map(function(ph) {
        return '<option value="' + esc(ph.file) + '"' + (ph.file === d.photo ? ' selected' : '') + '>' + esc(ph.label) + '</option>';
      }).join('') + '<option value="none"' + (photoByFile(d.photo) ? '' : ' selected') + '>No photo (plain skyline card)</option></select></label>' : '')) +
    '<div class="row">' +
    '<button class="primary" name="action" value="approve">Approve (next slot)</button>' +
    '<button name="action" value="now">Post now</button>' +
    '<button name="action" value="save">Save edit</button>' +
    '<button class="danger" name="action" value="reject">Reject</button></div></form></div>';
}

// Upload form: the browser reads the video's length and size first (to warn before a long upload), then sends it
// with a progress bar. The file input is last so the listing fields arrive before the video bytes.
function videoForm(csrf) {
  return '<h2>Add a home video</h2><div class="card"><form id="vform">' +
    '<label class="meta">Listing link (Claude reads the address, price and features from it; the link goes in the Reel caption)' +
    '<input type="url" name="listing_url" required placeholder="https://..." style="font:inherit;padding:6px;border:1px solid #ccd0d5;border-radius:6px;width:100%;box-sizing:border-box"></label>' +
    '<div class="grid"><label>Whose listing?<select name="own_listing"><option value="yes">Ours (Real Broker)</option><option value="no">Another brokerage (I have their written OK)</option></select></label>' +
    '<label>Listing brokerage (if not ours)<input type="text" name="listing_brokerage"></label></div>' +
    '<details><summary>Paste the listing description (optional; use it when the site blocks the reader, like Zillow, Realtor.com or Lofty sites)</summary>' +
    '<textarea name="details" style="min-height:80px" placeholder="Paste the address, price, beds/baths and description from the listing"></textarea></details>' +
    '<details><summary>Write my own caption instead (optional)</summary><textarea name="caption" style="min-height:60px"></textarea></details>' +
    '<input type="hidden" name="duration"><input type="hidden" name="width"><input type="hidden" name="height">' +
    '<label class="meta">Video (vertical 9:16, 3-90 seconds, MP4 or MOV)<input type="file" name="video" accept="video/*" required></label>' +
    '<div id="vinfo" class="meta"></div><progress id="vprog" value="0" max="100" hidden></progress>' +
    '<button class="primary" id="vbtn">Upload and draft caption</button> <span id="vstatus" class="meta"></span></form></div>' +
    '<script>(function(){var f=document.getElementById("vform"),info=document.getElementById("vinfo"),prog=document.getElementById("vprog"),st=document.getElementById("vstatus"),btn=document.getElementById("vbtn");' +
    'f.video.addEventListener("change",function(){var file=f.video.files[0];info.textContent="";f.duration.value=f.width.value=f.height.value="";if(!file)return;' +
    'var v=document.createElement("video");v.preload="metadata";v.onloadedmetadata=function(){f.duration.value=v.duration;f.width.value=v.videoWidth;f.height.value=v.videoHeight;' +
    'var w=[];if(v.duration<3||v.duration>90)w.push("Reels must be 3-90 seconds");if(v.videoHeight<=v.videoWidth)w.push("not vertical");' +
    'info.textContent=Math.round(v.duration)+"s, "+v.videoWidth+"x"+v.videoHeight+", "+(file.size/1048576).toFixed(0)+" MB"+(w.length?"  ⚠ "+w.join("; "):"  ✓ looks right for a Reel");URL.revokeObjectURL(v.src)};' +
    'v.onerror=function(){info.textContent=(file.size/1048576).toFixed(0)+" MB (this browser cannot preview it; Facebook will check it)"};v.src=URL.createObjectURL(file)});' +
    'f.addEventListener("submit",function(e){e.preventDefault();var x=new XMLHttpRequest();x.open("POST","/admin/video");x.setRequestHeader("X-CSRF",' + JSON.stringify(csrf) + ');' +
    'prog.hidden=false;btn.disabled=true;st.textContent="Uploading…";x.upload.onprogress=function(ev){if(ev.lengthComputable){prog.value=ev.loaded/ev.total*100;if(ev.loaded===ev.total)st.textContent="Writing the caption…"}};' +
    'x.onload=function(){var r={};try{r=JSON.parse(x.responseText)}catch(err){}if(x.status===200&&r.ok){location.reload()}else{btn.disabled=false;st.textContent="Upload failed: "+(r.error||x.status+" "+x.responseText.slice(0,200))}};' +
    'x.onerror=function(){btn.disabled=false;st.textContent="Upload failed (connection)"};x.send(new FormData(f))})})();</script>';
}

app.get('/admin', requireAdmin, async function(req, res) {
  var csrf = csrfToken();
  var s = await getSettings();
  var q = 'SELECT d.*, f.title, COALESCE(d.source_name, f.source_name) AS source_name, f.relevance, f.importance FROM drafts d LEFT JOIN feed_items f ON f.id = d.feed_item_id ';
  var pending = (await pool.query(q + "WHERE d.status='pending' ORDER BY d.post_by NULLS LAST, (d.kind = 'video') DESC, (d.kind LIKE 'filler%'), f.importance DESC NULLS LAST, d.id")).rows;
  var scheduled = (await pool.query(q + "WHERE d.status IN ('scheduled','publishing') ORDER BY d.scheduled_at")).rows;
  var failed = (await pool.query(q + "WHERE d.status='failed' ORDER BY d.updated_at DESC LIMIT 10")).rows;
  var published = (await pool.query(q + "WHERE d.status='published' ORDER BY d.published_at DESC LIMIT 15")).rows;
  var counts = (await pool.query("SELECT status, COUNT(*)::int AS n FROM feed_items WHERE fetched_at > NOW() - INTERVAL '24 hours' GROUP BY status")).rows;
  var rejected = (await pool.query("SELECT title, town, relevance, importance, reason, url FROM feed_items WHERE status IN ('rejected','draft_skipped') ORDER BY id DESC LIMIT 30")).rows;

  var h = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nashville Life Queue</title><style>' + CSS + '</style></head><body><main>';
  h += '<h1>The Nashville Life · post queue</h1>';
  h += '<div class="card status">Publishing to Facebook: <b>' + (PUBLISH_ENABLED ? 'ON' : 'OFF (approved posts wait until PUBLISH_ENABLED=true)') + '</b>' +
    (FB_PAGE_TOKEN ? '' : ' · <b style="color:#b3261e">FB_PAGE_TOKEN missing</b>') + (FB_PAGE_ID ? '' : ' · <b style="color:#b3261e">FB_PAGE_ID missing</b>') +
    '<br>Last news check: ' + (lastIngest.at ? fmtLocal(lastIngest.at) + ' (' + lastIngest.added + ' new)' : 'not yet') +
    (lastIngest.errors.length ? ' · <span style="color:#b3261e" title="' + esc(lastIngest.errors.join('\n')) + '">' + lastIngest.errors.length + ' feed error(s)</span>' : '') +
    '<br>Last 24h items: ' + (counts.map(function(c) { return esc(c.status) + ' ' + c.n; }).join(', ') || 'none') +
    (lastPublish.at ? '<br>Last publish: ' + esc(lastPublish.result) : '') +
    '<br>Posting times: ' + slotTimes(s).map(fmtTime).join(', ') + ' (Central)' +
    '<br>Approval email: ' + (emailHours(s) ? 'after each news check that finds new posts, ' + fmtTime(s.digest_time) + '–' + fmtTime(s.email_until) + ' to ' + esc(DIGEST_TO.join(', ')) : 'off') +
    (RESEND_API_KEY ? '' : ' · <b style="color:#b3261e">RESEND_API_KEY missing</b>') +
    (lastDigest.at ? ' · last: ' + esc(lastDigest.result) : '') +
    '<div class="row"><form method="post" action="/admin/run"><input type="hidden" name="_csrf" value="' + csrf + '"><button>Check news now</button></form>' +
    '<form method="post" action="/admin/digest"><input type="hidden" name="_csrf" value="' + csrf + '"><button>Send approval email now</button></form></div></div>';

  h += '<h2>Waiting for approval (' + pending.length + ')</h2>' + (pending.map(function(d) { return draftCard(d, csrf); }).join('') || '<div class="card">Nothing waiting.</div>');
  h += videoForm(csrf);
  h += '<h2>Scheduled (' + scheduled.length + ')</h2>' + (scheduled.map(function(d) {
    return '<div class="card"><div class="meta"><b>' + esc(fmtLocal(d.scheduled_at)) + '</b> · ' + (d.kind === 'video' ? 'home video · ' : '') + esc(d.town) + ' · ' + esc(d.status) + '</div><div style="white-space:pre-wrap">' + esc(d.message) + '</div>' +
      '<form method="post" action="/admin/draft/' + d.id + '"><input type="hidden" name="_csrf" value="' + csrf + '"><button name="action" value="unschedule">Back to queue</button></form></div>';
  }).join('') || '<div class="card">Nothing scheduled.</div>');
  if (failed.length) h += '<h2>Failed</h2>' + failed.map(function(d) {
    return '<div class="card"><div class="meta" style="color:#b3261e">' + esc(d.error) + '</div><div style="white-space:pre-wrap">' + esc(d.message) + '</div>' +
      '<form method="post" action="/admin/draft/' + d.id + '"><input type="hidden" name="_csrf" value="' + csrf + '"><button name="action" value="unschedule">Back to queue</button></form></div>';
  }).join('');
  h += '<h2>Published</h2>' + (published.map(function(d) {
    return '<div class="card"><div class="meta">' + esc(fmtLocal(d.published_at)) + ' · <a href="' + postUrl(d.fb_post_id) + '" target="_blank" rel="noopener">view on Facebook</a></div><div style="white-space:pre-wrap">' + esc(d.message) + '</div></div>';
  }).join('') || '<div class="card">Nothing yet.</div>');

  h += '<details><summary>Filtered out recently (' + rejected.length + ')</summary>' + rejected.map(function(r) {
    return '<div class="card"><div class="meta">' + esc(r.town) + ' · rel ' + esc(r.relevance) + ' / imp ' + esc(r.importance) + ' · ' + esc(r.reason) + '</div><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.title) + '</a></div>';
  }).join('') + '</details>';

  h += '<details><summary>Settings</summary><div class="card"><form method="post" action="/admin/settings"><input type="hidden" name="_csrf" value="' + csrf + '">' +
    '<label>Posts per day, news and videos together (1-12)<input type="text" name="posts_per_day" value="' + esc(s.posts_per_day) + '"></label><br><br>' +
    '<label>First post (Central, HH:MM)<input type="text" name="first_post" value="' + esc(s.first_post) + '"></label><br><br>' +
    '<label>Last post (Central, HH:MM)<input type="text" name="last_post" value="' + esc(s.last_post) + '"></label><br><br>' +
    '<label>Approval emails from (Central, HH:MM, or "off")<input type="text" name="digest_time" value="' + esc(s.digest_time) + '"></label><br><br>' +
    '<label>Approval emails until (Central, HH:MM)<input type="text" name="email_until" value="' + esc(s.email_until) + '"></label><br><br>' +
    '<label>Image badge, after "Brought to you by" ("off" hides it)<input type="text" name="badge_text" maxlength="40" value="' + esc(s.badge_text) + '"></label><br><br>' +
    '<label>Brokerage line at the end of home video captions (firm name and firm phone)<input type="text" name="firm_line" maxlength="120" value="' + esc(s.firm_line) + '"></label><br><br>' +
    '<label>Slow-day community posts per day (0 = off)<input type="text" name="filler_per_day" value="' + esc(s.filler_per_day) + '"></label><br><br>' +
    '<label>Nashville and surrounding counties: minimum relevance (0-10)<input type="text" name="core_min_relevance" value="' + esc(s.core_min_relevance) + '"></label><br><br>' +
    '<label>Wider Middle Tennessee and statewide: minimum importance (0-10)<input type="text" name="wider_min_importance" value="' + esc(s.wider_min_importance) + '"></label><br><br>' +
    '<label>Voice<textarea name="voice">' + esc(s.voice) + '</textarea></label>' +
    '<button class="primary">Save settings</button></form></div></details>';
  h += '</main></body></html>';
  res.send(h);
});

app.post('/admin/draft/:id', requireAdmin, async function(req, res) {
  var id = parseInt(req.params.id, 10);
  var action = req.body.action;
  var message = typeof req.body.message === 'string' ? req.body.message.trim() : null;
  try {
    if (message !== null && message && ['approve', 'now', 'save'].indexOf(action) >= 0) {
      var cur = (await pool.query('SELECT kind, video_info FROM drafts WHERE id=$1', [id])).rows[0] || {};
      // Video warnings come from the upload (length, shape, consent), not the caption, so keep them.
      var vw = cur.kind === 'video' ? videoWarnings(JSON.parse(cur.video_info || '{}'), (await getSettings()).firm_line) : [];
      await pool.query("UPDATE drafts SET message=$2, warnings=$3, updated_at=NOW() WHERE id=$1 AND status='pending'", [id, message, checkWarnings(message, cur.kind).concat(vw).join('; ') || null]);
      var headline = typeof req.body.card_headline === 'string' ? req.body.card_headline.trim().substring(0, 90) : '';
      if (headline) await pool.query("UPDATE drafts SET card_headline=$2 WHERE id=$1 AND status='pending'", [id, headline]);
      var photo = req.body.photo;
      if (photo === 'none' || photoByFile(photo)) await pool.query("UPDATE drafts SET photo=$2 WHERE id=$1 AND status='pending'", [id, photo]);
    }
    if (action === 'approve') {
      await scheduleDraft(id);
    } else if (action === 'now') {
      await pool.query("UPDATE drafts SET status='scheduled', scheduled_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='pending'", [id]);
      await publishDue();
    } else if (action === 'reject') {
      await rejectDraft(id);
    } else if (action === 'unschedule') {
      await pool.query("UPDATE drafts SET status='pending', scheduled_at=NULL, updated_at=NOW() WHERE id=$1 AND status IN ('scheduled','failed')", [id]);
    }
  } catch (e) { console.error('Admin action error:', e.message); }
  res.redirect('/admin');
});

app.post('/admin/video', requireAdmin, function(req, res) {
  var bb;
  try { bb = Busboy({ headers: req.headers, limits: { files: 1, fields: 20, fieldSize: 10000, fileSize: 1024 * 1024 * 1024 } }); }
  catch (e) { return res.status(400).json({ error: 'Expected a video upload' }); }
  var fields = {}, file = null, tooBig = false, written = Promise.resolve();
  bb.on('field', function(k, v) { fields[k] = String(v).trim(); });
  bb.on('file', function(name, stream, info) {
    if (name !== 'video' || !/^video\//.test(info.mimeType || '')) { stream.resume(); return; }
    var ext = /\.(mp4|mov|m4v)$/i.exec(info.filename || '');
    file = crypto.randomBytes(12).toString('hex') + (ext ? ext[0].toLowerCase() : '.mp4');
    var out = fs.createWriteStream(videoPath(file));
    written = new Promise(function(ok, fail) { out.on('finish', ok); out.on('error', fail); });
    stream.on('limit', function() { tooBig = true; });
    stream.pipe(out);
  });
  bb.on('error', function(e) { if (file) removeVideo(file); if (!res.headersSent) res.status(400).json({ error: e.message }); });
  bb.on('close', async function() {
    try {
      await written;
      if (!file) return res.status(400).json({ error: 'No video file in the upload' });
      if (tooBig) { removeVideo(file); return res.status(413).json({ error: 'Video is over 1 GB' }); }
      var info = {};
      ['listing_url', 'own_listing', 'listing_brokerage', 'details', 'caption', 'duration', 'width', 'height']
        .forEach(function(k) { if (fields[k]) info[k] = fields[k].substring(0, 8000); });
      if (info.listing_url && !/^https?:\/\/[^\s]+$/i.test(info.listing_url)) { removeVideo(file); return res.status(400).json({ error: 'The listing link must start with http:// or https://' }); }
      var id = await draftVideo(info, file);
      console.log('Video: draft', id, 'from upload', file, (fs.statSync(videoPath(file)).size / 1048576).toFixed(1) + ' MB');
      res.json({ ok: true, id: id });
    } catch (e) {
      console.error('Video upload error:', e.message);
      if (file) removeVideo(file);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
  req.pipe(bb);
});

app.get('/admin/video/:id', requireAdmin, async function(req, res) {
  var r = await pool.query('SELECT video_file FROM drafts WHERE id=$1', [parseInt(req.params.id, 10)]);
  if (!r.rows.length || !r.rows[0].video_file || !fs.existsSync(videoPath(r.rows[0].video_file))) return res.sendStatus(404);
  res.sendFile(videoPath(r.rows[0].video_file)); // handles Range requests, so the player can seek
});

app.get('/admin/card/:id.png', requireAdmin, async function(req, res) {
  var r = await pool.query('SELECT card_headline, town, category, source_name, photo FROM drafts WHERE id=$1', [parseInt(req.params.id, 10)]);
  if (!r.rows.length) return res.sendStatus(404);
  res.type('png').send(await renderDraftCard(r.rows[0]));
});

app.post('/admin/digest', requireAdmin, async function(req, res) {
  await sendDigest(true);
  res.redirect('/admin');
});

app.post('/admin/run', requireAdmin, function(req, res) {
  runPipeline(); // runs in the background; refresh to see results
  res.redirect('/admin');
});

app.post('/admin/settings', requireAdmin, async function(req, res) {
  var keys = ['posts_per_day', 'first_post', 'last_post', 'digest_time', 'email_until', 'badge_text', 'firm_line', 'filler_per_day', 'voice', 'core_min_relevance', 'wider_min_importance'];
  for (var i = 0; i < keys.length; i++) {
    var v = (req.body[keys[i]] || '').trim();
    if (v) await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [keys[i], v]);
  }
  res.redirect('/admin');
});

// ── APPROVAL EMAIL ───────────────────────────────────────────────────────────
// Links in the email carry a signed, expiring token instead of the admin password. They open a confirmation page
// with a button (POST), so email link scanners that pre-open links can never approve or reject anything.
function linkSecret() { return process.env.LINK_SECRET || crypto.createHmac('sha256', ADMIN_PASSWORD || 'unset').update('email-links').digest('hex'); }
function signLink(subject, action, exp) { return crypto.createHmac('sha256', linkSecret()).update(subject + ':' + action + ':' + exp).digest('hex').substring(0, 32); }
function verifyLink(subject, action, exp, token) {
  if (!ADMIN_PASSWORD || !token || !exp || parseInt(exp, 10) < Math.floor(Date.now() / 1000)) return false;
  var a = Buffer.from(signLink(subject, action, exp)), b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function emailLink(path, subject, action, days) {
  var exp = Math.floor(Date.now() / 1000) + (days || 4) * 86400;
  return PUBLIC_URL + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'e=' + exp + '&t=' + signLink(subject, action, exp);
}

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  var r = await axios.post('https://api.resend.com/emails', { from: EMAIL_FROM, to: DIGEST_TO, subject: subject, html: html },
    { headers: { Authorization: 'Bearer ' + RESEND_API_KEY }, timeout: 30000 });
  return r.data && r.data.id;
}

function emailButton(href, label, primary) {
  return '<a href="' + esc(href) + '" style="display:inline-block;padding:10px 18px;margin:4px 8px 4px 0;border-radius:6px;text-decoration:none;font-weight:600;' +
    (primary ? 'background:#1877f2;color:#ffffff;' : 'background:#ffffff;color:#b3261e;border:1px solid #ccd0d5;') + '">' + esc(label) + '</a>';
}

async function buildDigest() {
  var s = await getSettings();
  var pending = (await pool.query("SELECT d.*, f.title, f.relevance, f.importance FROM drafts d LEFT JOIN feed_items f ON f.id = d.feed_item_id WHERE d.status='pending' ORDER BY d.post_by NULLS LAST, (d.kind = 'video') DESC, (d.kind LIKE 'filler%'), f.importance DESC NULLS LAST, d.id")).rows;
  var scheduled = (await pool.query("SELECT COUNT(*)::int AS n FROM drafts WHERE status='scheduled'")).rows[0].n;
  if (!pending.length) return null;
  var ids = pending.map(function(d) { return d.id; }).join('.');
  var h = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1c1e21">' +
    '<h2 style="margin:0 0 6px">The Nashville Life: ' + pending.length + ' post' + (pending.length === 1 ? '' : 's') + ' waiting</h2>' +
    '<p style="color:#65676b;margin:0 0 14px">Up to ' + slotTimes(s).length + ' posts a day (' + slotTimes(s).map(function(t) { return fmtTime(t); }).join(', ') + ' Central time). ' +
    scheduled + ' already scheduled. Approved posts take the next open time. News drafts not approved within 3 days expire.' +
    (PUBLISH_ENABLED ? '' : ' <b style="color:#b3261e">Publishing is OFF, so approved posts wait.</b>') + '</p>' +
    emailButton(emailLink('/email/approve-all?ids=' + ids, ids, 'approve-all'), 'Approve all ' + pending.length, true) +
    emailButton(PUBLIC_URL + '/admin', 'Edit in queue', false).replace('color:#b3261e', 'color:#1c1e21');
  pending.sort(function(a, b) { return (a.emailed_at ? 1 : 0) - (b.emailed_at ? 1 : 0); }); // new ones first
  pending.forEach(function(d) {
    var visual = d.kind === 'video'
      ? '<div style="background:#0b1530;color:#f2b544;border-radius:8px;padding:18px;margin-bottom:10px;font-weight:600">🎬 Home video Reel: ' + esc(d.card_headline) + '<br><a href="' + esc(PUBLIC_URL + '/admin') + '" style="color:#ffffff;font-weight:400">Watch it in the queue</a></div>'
      : '<img src="' + esc(d.image_url || emailLink('/card/' + d.id + '.png', String(d.id), 'card', 7)) + '" width="560" style="width:100%;max-width:560px;border-radius:8px;display:block;margin-bottom:10px" alt="">';
    h += '<div style="border:1px solid #e4e6eb;border-radius:10px;padding:14px;margin:16px 0">' +
      '<div style="font-size:13px;color:#65676b;margin-bottom:6px">' + (d.emailed_at ? '' : '<b style="color:#1877f2">NEW</b> · ') + (kindLabel(d) ? esc(kindLabel(d)) + ' · ' : '') + esc(d.town) + ' · ' + esc((d.category || '').replace(/_/g, ' ')) +
      (d.sensitive ? ' · <b style="color:#8a4b00">sensitive</b>' : '') + (d.warnings ? ' · <b style="color:#b3261e">' + esc(d.warnings) + '</b>' : '') + '</div>' + visual +
      '<div style="white-space:pre-wrap;font-size:15px;line-height:1.4">' + esc(d.image_url || d.kind === 'video' ? d.message : photoCaption(d)) + '</div>' +
      (d.feed_item_id ? '<div style="font-size:13px;margin:8px 0"><a href="' + esc(d.link) + '" style="color:#1a56c4">' + esc(d.source_name) + ': ' + esc(d.title) + '</a></div>'
        : '<div style="font-size:13px;margin:8px 0;color:#65676b">' + esc(kindLabel(d) || 'community post') + (d.post_by ? ' · good until ' + esc(fmtLocal(d.post_by)) : '') + '</div>') +
      emailButton(emailLink('/email/approve/' + d.id, String(d.id), 'approve'), 'Approve', true) +
      emailButton(emailLink('/email/reject/' + d.id, String(d.id), 'reject'), 'Reject', false) + '</div>';
  });
  h += '<p style="font-size:12px;color:#65676b">Buttons open a confirmation page. Links expire in 4 days.</p></div>';
  var fresh = pending.filter(function(d) { return !d.emailed_at; }).length;
  return { subject: 'Nashville Life: ' + (fresh ? fresh + ' new, ' : '') + pending.length + ' post' + (pending.length === 1 ? '' : 's') + ' to approve', html: h, count: pending.length, fresh: fresh,
    ids: pending.map(function(d) { return d.id; }) };
}
function fmtTime(hhmm) { var m = toMinutes(hhmm); var h = Math.floor(m / 60); return (h % 12 || 12) + ':' + pad2(m % 60) + (h < 12 ? 'am' : 'pm'); }

// Approval emails go out when there are pending drafts not yet emailed (normally right after a news check),
// only between digest_time and email_until (Central). Overnight drafts wait for the morning; the 5-minute cron catches that.
function emailHours(s) {
  var from = toMinutes(s.digest_time), until = toMinutes(s.email_until);
  if (from === null) return null;
  return { from: from, until: until === null ? 21 * 60 : until };
}
var lastDigest = { at: null, result: null }, digestFailedAt = 0;
async function sendDigest(force) {
  var s = await getSettings();
  if (!force) {
    var hrs = emailHours(s);
    var lp = localParts(new Date()), mins = lp.hour * 60 + lp.min;
    if (!hrs || mins < hrs.from || mins >= hrs.until || !RESEND_API_KEY) return;
    if (Date.now() - digestFailedAt < 30 * 60 * 1000) return; // back off 30 min after a failed send
    // Len uploaded the videos himself, so videos alone don't trigger an email.
    var unsent = (await pool.query("SELECT COUNT(*)::int AS n FROM drafts WHERE status='pending' AND emailed_at IS NULL AND kind <> 'video'")).rows[0].n;
    if (!unsent) return;
  }
  var d = await buildDigest();
  if (!d) { lastDigest = { at: new Date().toISOString(), result: 'nothing waiting; no email' }; return; }
  try {
    await sendEmail(d.subject, d.html);
    await pool.query('UPDATE drafts SET emailed_at=NOW() WHERE id = ANY($1) AND emailed_at IS NULL', [d.ids]);
    lastDigest = { at: new Date().toISOString(), result: 'sent (' + d.fresh + ' new, ' + d.count + ' waiting) to ' + DIGEST_TO.join(', ') };
    console.log('Digest:', lastDigest.result);
  } catch (e) {
    digestFailedAt = Date.now();
    var msg = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    lastDigest = { at: new Date().toISOString(), result: 'failed: ' + msg };
    console.error('Digest failed:', msg);
  }
}

function emailPage(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' + CSS + '</style></head>' +
    '<body><main><h1>' + esc(title) + '</h1>' + body + '<p><a href="/admin">Open the full queue</a></p></main></body></html>';
}

app.get('/card/:id.png', async function(req, res) {
  if (!verifyLink(req.params.id, 'card', req.query.e, req.query.t)) return res.sendStatus(403);
  var r = await pool.query('SELECT card_headline, town, category, source_name, photo FROM drafts WHERE id=$1', [parseInt(req.params.id, 10)]);
  if (!r.rows.length) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=86400').type('png').send(await renderDraftCard(r.rows[0]));
});

// GET = confirmation page only. POST = do it.
app.get('/email/:action/:id?', async function(req, res) {
  var action = req.params.action, subject = action === 'approve-all' ? String(req.query.ids || '') : String(req.params.id || '');
  if (['approve', 'reject', 'approve-all'].indexOf(action) < 0 || !verifyLink(subject, action, req.query.e, req.query.t)) {
    return res.status(403).send(emailPage('Link expired', '<div class="card">This link is invalid or has expired. Use the queue instead.</div>'));
  }
  var ids = subject.split('.').map(function(x) { return parseInt(x, 10); }).filter(Boolean);
  var rows = (await pool.query("SELECT id, message, status FROM drafts WHERE id = ANY($1::int[])", [ids])).rows;
  var waiting = rows.filter(function(r) { return r.status === 'pending'; });
  var label = action === 'reject' ? 'Reject this post' : action === 'approve' ? 'Approve this post' : 'Approve all ' + waiting.length + ' waiting posts';
  var body = waiting.map(function(r) { return '<div class="card" style="white-space:pre-wrap">' + esc(r.message) + '</div>'; }).join('') ||
    '<div class="card">Already handled; nothing waiting here.</div>';
  if (waiting.length) {
    body += '<form method="post"><input type="hidden" name="e" value="' + esc(req.query.e) + '"><input type="hidden" name="t" value="' + esc(req.query.t) + '">' +
      (action === 'approve-all' ? '<input type="hidden" name="ids" value="' + esc(subject) + '">' : '') +
      '<button class="' + (action === 'reject' ? 'danger' : 'primary') + '">' + esc(label) + '</button></form>';
  }
  res.send(emailPage(label, body));
});

app.post('/email/:action/:id?', async function(req, res) {
  var action = req.params.action, subject = action === 'approve-all' ? String(req.body.ids || '') : String(req.params.id || '');
  if (['approve', 'reject', 'approve-all'].indexOf(action) < 0 || !verifyLink(subject, action, req.body.e, req.body.t)) {
    return res.status(403).send(emailPage('Link expired', '<div class="card">This link is invalid or has expired. Use the queue instead.</div>'));
  }
  var ids = subject.split('.').map(function(x) { return parseInt(x, 10); }).filter(Boolean);
  var lines = [];
  if (action === 'reject') {
    lines.push((await rejectDraft(ids[0])) ? 'Rejected.' : 'Already handled.');
  } else {
    // Time-sensitive first, then videos, then news by importance, then community posts.
    var rows = (await pool.query("SELECT d.id FROM drafts d LEFT JOIN feed_items f ON f.id = d.feed_item_id WHERE d.id = ANY($1::int[]) AND d.status='pending' ORDER BY d.post_by NULLS LAST, (d.kind = 'video') DESC, (d.kind LIKE 'filler%'), f.importance DESC NULLS LAST, d.id", [ids])).rows;
    for (var i = 0; i < rows.length; i++) {
      var slot = await scheduleDraft(rows[i].id);
      if (slot) lines.push('Scheduled for ' + fmtLocal(slot));
    }
    if (!lines.length) lines.push('Already handled.');
  }
  res.send(emailPage('Done', '<div class="card">' + lines.map(esc).join('<br>') + '</div>'));
});

app.get('/health', async function(req, res) {
  var db = 'ok';
  try { await pool.query('SELECT 1'); } catch (e) { db = 'error'; }
  var videoDirOk = false;
  try { fs.accessSync(VIDEO_DIR, fs.constants.W_OK); videoDirOk = true; } catch (e) {}
  res.json({ ok: db === 'ok', db: db, publish_enabled: PUBLISH_ENABLED, fb_page_id_set: !!FB_PAGE_ID, fb_token_set: !!FB_PAGE_TOKEN, admin_password_set: !!ADMIN_PASSWORD,
    resend_key_set: !!RESEND_API_KEY, model: CLAUDE_MODEL, video_dir: VIDEO_DIR, video_dir_writable: videoDirOk, video_on_volume: !!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.VIDEO_DIR),
    last_ingest: lastIngest, last_publish: lastPublish, last_digest: lastDigest, pipeline_running: pipelineRunning });
});

app.get('/', function(req, res) { res.redirect('/admin'); });

// ── START ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  initDb().then(function() {
    app.listen(PORT, function() { console.log('The Nashville Life listening on', PORT, '| publishing', PUBLISH_ENABLED ? 'ON' : 'OFF', '| videos in', VIDEO_DIR); });
    // News check 3x a day at 6am, noon and 6pm Nashville time (node-cron follows daylight saving with the timezone option).
    cron.schedule('0 6,12,18 * * *', function() { runPipeline(); }, { timezone: TZ });
    cron.schedule('*/5 * * * *', function() { publishDue().catch(function(e) { console.error('Publisher error:', e.message); }); });
    cron.schedule('*/5 * * * *', function() { sendDigest(false).catch(function(e) { console.error('Digest error:', e.message); }); });
    setTimeout(runPipeline, 15000);
  }).catch(function(e) { console.error('Startup failed:', e.message); process.exit(1); });
}

module.exports = { app: app, pool: pool, videoForm: videoForm, readListing: readListing, initDb: initDb, draftFiller: draftFiller, draftVideo: draftVideo, scheduleDraft: scheduleDraft, buildDigest: buildDigest, renderDraftCard: renderDraftCard,
  dateKeyPlus: dateKeyPlus, cardLabel: cardLabel, PHOTOS: PHOTOS, isPlaceholderImage: isPlaceholderImage, slotTimes: slotTimes, emailHours: emailHours, fmtTime: fmtTime,
  signLink: signLink, verifyLink: verifyLink, renderCard: renderCard, wrapText: wrapText, findPreviewImage: findPreviewImage, photoCaption: photoCaption, checkWarnings: checkWarnings,
  cleanTitle: cleanTitle, titleKey: titleKey, similar: similar, localParts: localParts, localDateParts: localDateParts, localSlotToDate: localSlotToDate, localKey: localKey,
  normalizeUrl: normalizeUrl, videoWarnings: videoWarnings, brokerageLines: brokerageLines, postUrl: postUrl, SOURCES: SOURCES, rss: rss };
