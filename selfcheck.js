// Offline checks for the pure helpers; `node selfcheck.js --feeds` also fetches every RSS source once.
// Needs no database, Claude key or Facebook token.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/none';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'selfcheck';
const assert = require('assert');
const s = require('./server');

var n = 0;
function ok(cond, msg) { assert.ok(cond, msg); n++; }

ok(s.checkWarnings('Road closure on West End Avenue this weekend.').length === 0, 'clean text has no warnings');
ok(s.checkWarnings('A great neighborhood for anyone').length === 1, 'area characterization flagged');
ok(s.checkWarnings('This family-friendly event is free').some(function(w) { return /family/.test(w); }), 'family-friendly flagged');
ok(s.checkWarnings('Perfect for a growing family!').length === 0 && s.checkWarnings('Perfect for families!').some(function(w) { return /family/.test(w); }), '"perfect for families" flagged');
ok(s.checkWarnings('close to top-rated schools').length === 1, 'school quality flagged');
ok(s.checkWarnings('Home values are expected to rise').length === 1, 'value opinion flagged');
ok(s.checkWarnings('More at https://x.com').length === 1 && s.checkWarnings('Full listing: https://x.com', 'video').length === 0, 'URL flagged, except the listing link on videos');

ok(s.similar(s.titleKey('I-24 closed this weekend near Antioch'), s.titleKey('I-24 closed near Antioch this weekend')) >= 0.6, 'reworded duplicate detected');
ok(s.similar(s.titleKey('I-24 closed this weekend'), s.titleKey('Nashville library opens new branch')) < 0.6, 'different stories not duplicates');
ok(s.normalizeUrl('https://a.com/x?utm_source=fb&id=2#top') === 'https://a.com/x?id=2', 'tracking params stripped');

// Nashville is UTC-6 in winter (CST) and UTC-5 in summer (CDT).
ok(s.localSlotToDate({ y: 2026, m: 0, d: 15 }, '07:30', 0).toISOString() === '2026-01-15T13:30:00.000Z', 'Central slot (winter, CST)');
ok(s.localSlotToDate({ y: 2026, m: 6, d: 15 }, '19:30', 1).toISOString() === '2026-07-17T00:30:00.000Z', 'Central slot (summer, CDT, next day)');
ok(s.localSlotToDate({ y: 2026, m: 2, d: 8 }, '07:00', 0).toISOString() === '2026-03-08T12:00:00.000Z', 'DST starts Mar 8 2026: 7am is CDT');
ok(s.localSlotToDate({ y: 2026, m: 2, d: 7 }, '07:00', 0).toISOString() === '2026-03-07T13:00:00.000Z', 'day before DST: 7am is CST');
ok(s.localSlotToDate({ y: 2026, m: 9, d: 31 }, '21:00', 0).toISOString() === '2026-11-01T02:00:00.000Z', 'Oct 31 9pm is CDT');
ok(s.localSlotToDate({ y: 2026, m: 10, d: 1 }, '07:00', 0).toISOString() === '2026-11-01T13:00:00.000Z', 'DST ends Nov 1 2026: 7am is CST');
ok(s.localSlotToDate({ y: 2026, m: 10, d: 1 }, '00:00', 1).getTime() - s.localSlotToDate({ y: 2026, m: 10, d: 1 }, '00:00', 0).getTime() === 25 * 3600000, 'fall-back day is 25 hours');
var p = s.localParts(new Date('2026-10-15T03:00:00Z')); // 10pm Oct 14 in Nashville
ok(p.d === 14 && p.m === 9 && p.hour === 22 && p.wd === 3, 'local date rolls back across UTC midnight');
ok(s.localKey(new Date('2026-01-01T05:30:00Z')) === '2025-12-31', 'local date key');
ok(s.dateKeyPlus('2026-10-30', 2) === '2026-11-01', 'date math across months');

var lines = s.wrapText('West End Avenue closed between 21st and 31st Avenue this weekend for utility work', 26, 4);
ok(lines.length >= 2 && lines.every(function(l) { return l.length <= 30; }), 'card headline wraps');
ok(s.wrapText('a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt', 10, 2)[1].slice(-1) === '…', 'long headline truncated with ellipsis');
var badge = s.badgeFrom(s.DEFAULT_SETTINGS);
ok(badge === 'Len Nevin | Loyalty Home Group | Real Broker\nLen 773-632-6316 · Brokerage 844-591-7325', 'badge carries Len, the brokerage and both phones (Len first)');
ok(s.badgeFrom({ badge_text: 'off', badge_phones: 'x' }) === 'off', 'badge can be turned off');
var png = s.renderCard('West End Avenue closed this weekend for utility work', 'Nashville', 'traffic_closures', 'NewsChannel 5', null, badge);
ok(png.length > 5000 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'card renders a PNG');
if (process.env.CARD_OUT) { require('fs').writeFileSync(process.env.CARD_OUT, png); console.log('card written to', process.env.CARD_OUT); }
ok(Array.isArray(s.PHOTOS), 'photo library loads (empty is fine)');
ok(s.cardLabel('Nashville', 'openings') === 'NOW OPEN' && s.cardLabel('Williamson County', 'development_business') === 'WILLIAMSON COUNTY · DEVELOPMENT', 'friendly card labels');
ok(s.isPlaceholderImage('https://images.foxtv.com/x/img/1280/720/default-image.png?ve=1') && !s.isPlaceholderImage('https://ewscripps.brightspotcdn.com/dims4/default/a7b421c/x.jpg'), 'site placeholder images are skipped, real photos kept');
ok(s.photoCaption({ message: 'Hello', link: 'https://a.com/x' }) === 'Hello\n\nRead more: https://a.com/x', 'photo post caption carries the article link');
var credit = s.DEFAULT_SETTINGS.credit_line;
ok(/Len Nevin/.test(credit) && credit.indexOf('773-632-6316') < credit.indexOf('844-591-7325'), 'credit line names Len, with his phone before the brokerage phone');
ok(s.postText({ message: 'Hi', link: 'https://a.com/x', image_url: 'https://a.com/i.jpg' }, { credit_line: credit }) === 'Hi\n\n' + credit, 'link post ends with the credit');
ok(s.postText({ message: 'Hi', link: 'https://a.com/x' }, { credit_line: credit }) === 'Hi\n\nRead more: https://a.com/x\n\n' + credit, 'photo post: link, then the credit');
ok(s.postText({ kind: 'video', message: 'Home\n\nFull listing: https://x' }, { credit_line: credit }) === 'Home\n\nFull listing: https://x\n\n' + credit, 'Reel ends with the credit');
ok(s.postText({ message: 'Hi\n\n' + credit }, { credit_line: credit }) === 'Hi\n\n' + credit, 'credit never added twice');
ok(s.postText({ message: 'Hi' }, { credit_line: 'off' }) === 'Hi', 'credit can be turned off');

ok(s.slotTimes({ posts_per_day: '8', first_post: '07:00', last_post: '21:00' }).join(',') === '07:00,09:00,11:00,13:00,15:00,17:00,19:00,21:00', '8 evenly spaced slots');
ok(s.slotTimes({ posts_per_day: '1', first_post: '08:00', last_post: '20:00' }).join(',') === '08:00', 'one slot');
(function() {
  var t = s.slotTimes({ posts_per_day: '18', first_post: '07:00', last_post: '21:00' }).map(function(x) { return +x.slice(0, 2) * 60 + +x.slice(3); });
  ok(t.length === 18 && t[0] === 420 && t[17] === 1260 && t.every(function(m, i) { return i === 0 || m - t[i - 1] >= 45; }), '18 slots, 7am-9pm, at least 45 min apart');
})();
ok(s.slotTimes({ posts_per_day: 'x', first_post: 'bad', last_post: '' }).length === 8, 'bad settings fall back to defaults');
ok(s.fmtTime('14:50') === '2:50pm' && s.fmtTime('07:00') === '7:00am' && s.fmtTime('12:10') === '12:10pm', 'friendly times');
var times = s.digestTimes(s.DEFAULT_SETTINGS);
ok(times.join(',') === '07:00,18:30', 'two approval emails a day by default');
ok(s.digestTimes({ digest_times: 'off' }).length === 0 && s.digestTimes({ digest_times: '18:30, bad, 07:00' }).join(',') === '07:00,18:30', 'email times parsed, sorted, bad ones dropped');
ok(s.dueDigestSlot(times, { y: 2026, m: 10, d: 14, hour: 6, min: 59 }) === null, 'no email before 7am');
ok(s.dueDigestSlot(times, { y: 2026, m: 10, d: 14, hour: 12, min: 5 }) === '2026-11-14 07:00', 'midday: the 7am email is the one due');
ok(s.dueDigestSlot(times, { y: 2026, m: 10, d: 14, hour: 21, min: 0 }) === '2026-11-14 18:30', 'evening: the 6:30pm email is due');
var exp = Math.floor(Date.now() / 1000) + 3600;
var tok = s.signLink('12', 'approve', exp);
ok(s.verifyLink('12', 'approve', exp, tok), 'signed email link verifies');
ok(!s.verifyLink('13', 'approve', exp, tok), 'token is bound to the draft');
ok(!s.verifyLink('12', 'reject', exp, tok), 'token is bound to the action');
ok(!s.verifyLink('12', 'approve', exp - 7200, s.signLink('12', 'approve', exp - 7200)), 'expired link rejected');

// Home videos
var firm = credit;
ok(s.videoWarnings({ duration: '42', width: '1080', height: '1920', own_listing: 'yes' }, firm).length === 0, 'good vertical video, own listing: no warnings');
ok(s.videoWarnings({ duration: '120', width: '1080', height: '1920' }, firm).some(function(w) { return /3-90/.test(w); }), 'too-long video flagged');
ok(s.videoWarnings({ duration: '30', width: '1920', height: '1080' }, firm).some(function(w) { return /vertical/.test(w); }), 'landscape video flagged');
ok(s.videoWarnings({}, 'Loyalty Home Group | Real Broker, LLC').some(function(w) { return /phone/.test(w); }), 'missing firm phone flagged');
ok(s.videoWarnings({ own_listing: 'no' }, firm).some(function(w) { return /written OK/.test(w); }), 'other broker listing flagged');
ok(s.brokerageLines({ own_listing: 'no', listing_brokerage: 'Acme Realty' }) === 'Listing courtesy of Acme Realty', 'listing courtesy line for other brokers');
ok(s.brokerageLines({ own_listing: 'yes' }) === '', 'own listing, no link: nothing extra');
ok(s.brokerageLines({ own_listing: 'yes', listing_url: 'https://x.com/l/1' }) === 'Full listing: https://x.com/l/1', 'listing link line');
ok(s.videoWarnings({ listing_url: 'https://x.com/l/1', page_read: false }, firm).some(function(w) { return /listing page/.test(w); }), 'unreadable listing page flagged');
ok(s.postUrl('reel:123') === 'https://www.facebook.com/reel/123' && s.postUrl('1_2') === 'https://www.facebook.com/1/posts/2', 'post links');
console.log('selfcheck: ' + n + ' checks passed');

if (process.argv.indexOf('--feeds') >= 0) {
  (async function() {
    for (var i = 0; i < s.SOURCES.length; i++) {
      var src = s.SOURCES[i];
      try { var f = await s.rss.parseURL(src.url); console.log('OK  ', src.key, (f.items || []).length, 'items |', ((f.items || [])[0] || {}).title); }
      catch (e) { console.log('FAIL', src.key, e.message); }
    }
    process.exit(0);
  })();
} else {
  process.exit(0);
}
