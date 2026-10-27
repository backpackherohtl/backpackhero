/*
 * Backpack Hero Junior Company: Website-Backend (Cloudflare Worker)
 *
 * - Liefert die statischen Seiten aus /public aus
 * - /api/public            öffentliche Daten (Termine, Einstellungen, Texte)
 * - /api/mailliste         Eintrag in die Mail-Liste "Bald bestellbar"
 * - /api/bestellung        Bestellung (nur wenn "Bestellen offen" an ist)
 * - /api/admin/...         Verwaltung, nur mit gültigem Cloudflare-Access-Login
 * - /admin/...             Admin-Oberfläche, ebenfalls nur mit Login
 * - scheduled()            wöchentliche Zusammenfassung per Mail
 *
 * Sicherheit: Der Login passiert bei Cloudflare Access. Dieser Worker prüft zusätzlich
 * die Signatur des Access-Tokens (JWT) selbst. Fehlt die Konfiguration, ist der Admin
 * gesperrt (fail closed).
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT, updated_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS termine (id INTEGER PRIMARY KEY AUTOINCREMENT, datum TEXT NOT NULL, von TEXT DEFAULT '', bis TEXT DEFAULT '', ort TEXT NOT NULL, info TEXT DEFAULT '', sichtbar INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_termine_datum ON termine(datum)`,
  `CREATE TABLE IF NOT EXISTS mailliste (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, vorname TEXT DEFAULT '', menge INTEGER, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_mailliste_created ON mailliste(created_at)`,
  `CREATE TABLE IF NOT EXISTS bestellungen (id INTEGER PRIMARY KEY AUTOINCREMENT, nr TEXT, created_at TEXT, name TEXT, email TEXT, menge INTEGER, lieferart TEXT, strasse TEXT DEFAULT '', plz TEXT DEFAULT '', ort TEXT DEFAULT '', land TEXT DEFAULT '', nachricht TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'neu', einzelpreis_cent INTEGER, versand_cent INTEGER, summe_cent INTEGER, notiz TEXT DEFAULT '', updated_at TEXT, updated_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_bestellungen_status ON bestellungen(status)`,
  `CREATE TABLE IF NOT EXISTS protokoll (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, email TEXT, aktion TEXT, details TEXT)`,
  `CREATE TABLE IF NOT EXISTS ratelimit (k TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_ratelimit ON ratelimit(k, ts)`,
];

// Einstellungen mit Standardwerten. Texte (text_*, dat_*, faq_*) sind leer = Text aus der Seite bleibt.
const DEFAULTS = {
  bestellen_offen: '0',
  preis: '',
  versand_at: '',
  versand_de: '',
  ausverkauft: '0',
  stueck_verfuegbar: '',
  stueck_anzeigen: '0',
  anteile_gesamt: '80',
  anteile_verkauft: '',
  banner_aktiv: '0',
  banner_text: '',
  banner_link: '',
};
const SETTING_KEY = /^(bestellen_offen|preis|versand_at|versand_de|ausverkauft|stueck_verfuegbar|stueck_anzeigen|anteile_gesamt|anteile_verkauft|banner_aktiv|banner_text|banner_link|text_[a-z0-9_]{1,40}|dat_[a-z0-9_]{1,40}|faq_[a-z0-9_]{1,40})$/;
const LABELS = {
  bestellen_offen: 'Bestellen offen', preis: 'Preis', versand_at: 'Versand Österreich', versand_de: 'Versand Deutschland',
  ausverkauft: 'Ausverkauft', stueck_verfuegbar: 'Verfügbare Stück', stueck_anzeigen: 'Stückzahl anzeigen',
  anteile_gesamt: 'Anteilsscheine insgesamt', anteile_verkauft: 'Verkaufte Anteilsscheine',
  banner_aktiv: 'Banner an', banner_text: 'Banner-Text', banner_link: 'Banner-Link', text_hero: 'Einleitung oben',
  dat_aufbau: 'Datenblatt Aufbau', dat_farben: 'Datenblatt Farben', dat_aussen: 'Datenblatt Außenmaße', dat_fach: 'Datenblatt Fach innen',
  dat_material: 'Datenblatt Material', dat_herkunft: 'Datenblatt Herkunft', dat_gewicht: 'Datenblatt Gewicht',
  faq_rucksack: 'FAQ Rucksack', faq_material: 'FAQ Material', faq_preis: 'FAQ Preis', faq_bekommen: 'FAQ Wie bekomme ich',
  faq_bezahlen: 'FAQ Bezahlen', faq_klasse: 'FAQ Klasse', faq_junior: 'FAQ Junior Company',
};
const zeigeWert = (k, v) => (/^(bestellen_offen|ausverkauft|stueck_anzeigen|banner_aktiv)$/.test(k) ? (v === '1' ? 'an' : 'aus') : v === '' ? 'leer' : `„${String(v).slice(0, 60)}“`);
const STATUS = ['neu', 'bezahlt', 'versendet', 'abgeholt', 'storniert'];
const LAENDER = ['Österreich', 'Deutschland'];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  schemaReady = true;
}

/* ---------- Hilfsfunktionen ---------- */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  });
const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);
const now = () => new Date().toISOString();
const heuteWien = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(new Date());

function str(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
const isEmail = (e) => /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i.test(e);
function intOrNull(v, min, max) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return NaN;
  return n;
}
// "24,90" / "24.90" / "24" -> 2490 Cent, leer -> null
function cents(v) {
  const s = String(v ?? '').trim().replace(/\s|€/g, '');
  if (!s) return null;
  const m = s.match(/^(\d{1,5})(?:[.,](\d{1,2}))?$/);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}
const euro = (c) => (c / 100).toFixed(2).replace('.', ',') + ' €';

async function readJson(req, maxBytes = 20000) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('zu groß');
  const text = await req.text();
  if (text.length > maxBytes) throw new Error('zu groß');
  return JSON.parse(text || '{}');
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS };
  for (const r of results) s[r.key] = r.value;
  return s;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Einfache Bremse gegen Spam: höchstens `limit` Formular-Einsendungen pro IP in 10 Minuten.
// Die IP wird nur als Hash mit Tages-Salz gespeichert und nach einem Tag gelöscht.
async function rateLimited(env, req, bucket, limit = 5) {
  const ip = req.headers.get('cf-connecting-ip') || 'lokal';
  const k = bucket + ':' + (await sha256Hex(ip + '|' + heuteWien() + '|' + (env.HASH_SALT || 'bh')));
  const t = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ratelimit WHERE k = ? AND ts > ?').bind(k, t - 600).first();
  if (row && row.n >= limit) return true;
  const stmts = [env.DB.prepare('INSERT INTO ratelimit (k, ts) VALUES (?, ?)').bind(k, t)];
  if (Math.random() < 0.05) stmts.push(env.DB.prepare('DELETE FROM ratelimit WHERE ts < ?').bind(t - 86400));
  await env.DB.batch(stmts);
  return false;
}

async function log(env, email, aktion, details) {
  await env.DB.prepare('INSERT INTO protokoll (ts, email, aktion, details) VALUES (?, ?, ?, ?)')
    .bind(now(), email, aktion, String(details || '').slice(0, 1000)).run();
}

async function sendMail(env, subject, text) {
  if (!env.MAILER || !env.MAIL_FROM || !env.NOTIFY_TO) return false;
  try {
    await env.MAILER.send({ to: env.NOTIFY_TO, from: { email: env.MAIL_FROM, name: 'Backpack Hero Website' }, subject, text });
    return true;
  } catch (e) {
    console.log('Mail fehlgeschlagen', e && (e.code || e.message));
    return false;
  }
}

/* ---------- Cloudflare Access: Token prüfen ---------- */

let certCache = { at: 0, keys: [] };
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function accessKeys(team) {
  if (Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs');
  const { keys } = await r.json();
  certCache = { at: Date.now(), keys: keys || [] };
  return certCache.keys;
}
function cookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}

// Gibt die E-Mail des eingeloggten Admins zurück oder null.
async function adminEmail(req, env) {
  // Nur für lokale Tests (wrangler dev mit .dev.vars). Wird nie mitveröffentlicht.
  if (env.DEV_ADMIN_EMAIL && new URL(req.url).hostname === 'localhost') return env.DEV_ADMIN_EMAIL;
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) return null; // nicht eingerichtet -> gesperrt
  const token = req.headers.get('cf-access-jwt-assertion') || cookie(req, 'CF_Authorization');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
    if (header.alg !== 'RS256') return null;
    const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const t = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (payload.iss !== `https://${team}`) return null;
    if (!payload.exp || payload.exp < t || (payload.nbf && payload.nbf > t + 60)) return null;
    const email = String(payload.email || '').toLowerCase();
    if (!email) return null;
    if (env.ADMIN_EMAILS) {
      const allowed = env.ADMIN_EMAILS.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      if (!allowed.includes(email)) return null;
    }
    return email;
  } catch {
    return null;
  }
}

/* ---------- Öffentliche Schnittstelle ---------- */

async function publicData(env) {
  const s = await getSettings(env);
  const { results: termine } = await env.DB.prepare(
    'SELECT datum, von, bis, ort, info FROM termine WHERE sichtbar = 1 AND datum >= ? ORDER BY datum, von LIMIT 6'
  ).bind(heuteWien()).all();
  const stock = s.stueck_verfuegbar === '' ? null : Number(s.stueck_verfuegbar);
  const ausverkauft = s.ausverkauft === '1' || (stock !== null && stock <= 0);
  return {
    ok: true,
    s,
    termine,
    verkauf: {
      offen: s.bestellen_offen === '1' && !ausverkauft && cents(s.preis) > 0,
      ausverkauft,
      stueck: s.stueck_anzeigen === '1' && stock !== null && stock > 0 ? stock : null,
    },
  };
}

async function mailliste(req, env) {
  let b;
  try { b = await readJson(req, 4000); } catch { return fail('Ungültige Anfrage.'); }
  if (str(b.website, 200)) return json({ ok: true }); // Honeypot: Bot, still verwerfen
  const email = str(b.email, 254).toLowerCase();
  if (!isEmail(email)) return fail('Bitte gib eine gültige E-Mail-Adresse ein.');
  if (b.einwilligung !== true) return fail('Bitte setz noch das Häkchen, damit wir dir schreiben dürfen.');
  const menge = intOrNull(b.menge, 1, 500);
  if (Number.isNaN(menge)) return fail('Die Anzahl muss zwischen 1 und 500 liegen.');
  if (await rateLimited(env, req, 'ml')) return fail('Zu viele Versuche. Probier es in ein paar Minuten nochmal.', 429);
  await env.DB.prepare(
    'INSERT INTO mailliste (email, vorname, menge, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET vorname = excluded.vorname, menge = COALESCE(excluded.menge, mailliste.menge)'
  ).bind(email, str(b.vorname, 60), menge, now()).run();
  return json({ ok: true });
}

async function bestellung(req, env) {
  let b;
  try { b = await readJson(req, 8000); } catch { return fail('Ungültige Anfrage.'); }
  if (str(b.website, 200)) return json({ ok: true, nr: '' });
  const pub = await publicData(env);
  if (!pub.verkauf.offen) return fail(pub.verkauf.ausverkauft ? 'Leider gerade ausverkauft.' : 'Bestellen ist gerade nicht möglich.', 409);
  const s = pub.s;
  const d = {
    name: str(b.name, 100), email: str(b.email, 254).toLowerCase(), menge: intOrNull(b.menge, 1, 200),
    lieferart: str(b.lieferart, 20), strasse: str(b.strasse, 120), plz: str(b.plz, 10), ort: str(b.ort, 80),
    land: str(b.land, 20), nachricht: str(b.nachricht, 1500),
  };
  if (d.name.length < 2) return fail('Bitte gib deinen Namen an.');
  if (!isEmail(d.email)) return fail('Bitte gib eine gültige E-Mail-Adresse ein.');
  if (!d.menge || Number.isNaN(d.menge)) return fail('Bitte gib eine Menge zwischen 1 und 200 an.');
  if (!['Abholung', 'Versand'].includes(d.lieferart)) return fail('Bitte wähl Abholung oder Versand.');
  if (b.datenschutz !== true) return fail('Bitte bestätige noch die Datenschutz-Einwilligung.');
  let versand = 0;
  if (d.lieferart === 'Versand') {
    if (!d.strasse || !d.plz || !d.ort || !LAENDER.includes(d.land)) return fail('Bitte füll die Lieferadresse vollständig aus.');
    const v = cents(d.land === 'Deutschland' ? s.versand_de : s.versand_at);
    if (v === null || Number.isNaN(v)) return fail('Versand dorthin ist gerade nicht möglich. Bitte wähl Abholung oder schreib uns.', 409);
    versand = v;
  } else {
    d.strasse = d.plz = d.ort = d.land = '';
  }
  const stock = s.stueck_verfuegbar === '' ? null : Number(s.stueck_verfuegbar);
  if (stock !== null && d.menge > stock) return fail(`Es sind nur noch ${stock} Stück verfügbar.`, 409);
  if (await rateLimited(env, req, 'best', 4)) return fail('Zu viele Bestellungen in kurzer Zeit. Probier es in ein paar Minuten nochmal.', 429);

  const einzel = cents(s.preis);
  const summe = einzel * d.menge + versand;
  const ts = now();
  const ins = await env.DB.prepare(
    `INSERT INTO bestellungen (created_at, name, email, menge, lieferart, strasse, plz, ort, land, nachricht, status, einzelpreis_cent, versand_cent, summe_cent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'neu', ?, ?, ?, ?)`
  ).bind(ts, d.name, d.email, d.menge, d.lieferart, d.strasse, d.plz, d.ort, d.land, d.nachricht, einzel, versand, summe, ts).run();
  const id = ins.meta.last_row_id;
  const nr = `BH-${ts.slice(0, 4)}-${String(id).padStart(3, '0')}`;
  const stmts = [env.DB.prepare('UPDATE bestellungen SET nr = ? WHERE id = ?').bind(nr, id)];
  if (stock !== null) {
    stmts.push(env.DB.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('stueck_verfuegbar', ?, ?, 'Bestellung') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(String(Math.max(0, stock - d.menge)), ts));
  }
  stmts.push(env.DB.prepare('INSERT INTO protokoll (ts, email, aktion, details) VALUES (?, ?, ?, ?)').bind(ts, 'Website', 'Neue Bestellung', `${nr}: ${d.menge} Stück, ${d.lieferart}, ${euro(summe)}`));
  await env.DB.batch(stmts);

  const adr = d.lieferart === 'Versand' ? `\nLieferadresse: ${d.strasse}, ${d.plz} ${d.ort}, ${d.land}` : '';
  await sendMail(env, `Neue Bestellung ${nr} (${d.menge} Stück)`,
    `Neue Bestellung über die Website.\n\nRechnungsnummer: ${nr}\nName: ${d.name}\nE-Mail: ${d.email}\nMenge: ${d.menge}\nLieferart: ${d.lieferart}${adr}\n` +
    `Preis: ${d.menge} × ${euro(einzel)}${versand ? ' + Versand ' + euro(versand) : ''} = ${euro(summe)}\n` +
    (d.nachricht ? `Nachricht: ${d.nachricht}\n` : '') +
    `\nNächster Schritt: Rechnung mit Junior-Hinweis an den Kunden schicken${d.lieferart === 'Versand' ? ' (mit IBAN, Versand erst nach Zahlungseingang)' : ''}.\nIm Admin: ${new URL(req.url).origin}/admin/`);
  return json({ ok: true, nr, summe: euro(summe) });
}

/* ---------- Admin-Schnittstelle ---------- */

async function admin(req, env, path, email) {
  const m = req.method;
  if (m !== 'GET') {
    // Schutz gegen Anfragen von fremden Seiten
    if (req.headers.get('x-bh-admin') !== '1') return fail('Nicht erlaubt.', 403);
    const origin = req.headers.get('origin');
    if (origin && origin !== new URL(req.url).origin) return fail('Nicht erlaubt.', 403);
  }
  let parts = path.split('/').filter(Boolean); // [api, admin, ...]
  parts = parts.slice(2);
  const [res, idStr] = parts;
  const id = idStr ? Number(idStr) : null;
  if (idStr && !Number.isInteger(id)) return fail('Ungültige ID.');

  if (res === 'me' && m === 'GET') return json({ ok: true, email });

  if (res === 'data' && m === 'GET') {
    const [s, termine, ml, ml7, best, last] = await Promise.all([
      getSettings(env),
      env.DB.prepare('SELECT * FROM termine ORDER BY datum DESC, von DESC LIMIT 500').all(),
      env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(menge),0) AS menge FROM mailliste').first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM mailliste WHERE created_at > ?').bind(new Date(Date.now() - 7 * 864e5).toISOString()).first(),
      env.DB.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(menge),0) AS menge FROM bestellungen GROUP BY status').all(),
      env.DB.prepare('SELECT ts, email, aktion, details FROM protokoll ORDER BY id DESC LIMIT 8').all(),
    ]);
    return json({ ok: true, email, heute: heuteWien(), s, termine: termine.results, mailliste: { gesamt: ml.n, menge: ml.menge, woche: ml7.n }, bestellungen: best.results, protokoll: last.results });
  }

  if (res === 'settings' && m === 'PUT') {
    let b;
    try { b = await readJson(req, 60000); } catch { return fail('Ungültige Anfrage.'); }
    const alt = await getSettings(env);
    const ts = now(), stmts = [], changes = [];
    for (const [k, v0] of Object.entries(b)) {
      if (!SETTING_KEY.test(k)) return fail(`Unbekanntes Feld: ${k}`);
      const v = str(v0, 2000);
      if (['preis', 'versand_at', 'versand_de'].includes(k) && v && Number.isNaN(cents(v))) return fail('Preise bitte als Zahl angeben, z. B. 24,90.');
      if (['stueck_verfuegbar', 'anteile_verkauft', 'anteile_gesamt'].includes(k) && v && Number.isNaN(intOrNull(v, 0, 100000))) return fail('Stückzahlen bitte als ganze Zahl angeben.');
      if (k === 'banner_link' && v && !/^(https:\/\/|#|\/)/.test(v)) return fail('Der Banner-Link muss mit https://, # oder / beginnen.');
      if ((alt[k] ?? '') === v) continue;
      stmts.push(env.DB.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by').bind(k, v, ts, email));
      changes.push(`${LABELS[k] || k}: ${zeigeWert(k, alt[k] ?? '')} → ${zeigeWert(k, v)}`);
    }
    const neu = { ...alt, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, str(v, 2000)])) };
    if (neu.bestellen_offen === '1' && !(cents(neu.preis) > 0)) return fail('Bevor Bestellen offen sein kann, muss ein Preis eingetragen sein.');
    if (!stmts.length) return json({ ok: true, geaendert: 0 });
    stmts.push(env.DB.prepare('INSERT INTO protokoll (ts, email, aktion, details) VALUES (?, ?, ?, ?)').bind(ts, email, 'Einstellungen geändert', changes.join('\n').slice(0, 1000)));
    await env.DB.batch(stmts);
    return json({ ok: true, geaendert: changes.length });
  }

  if (res === 'termine') {
    if (m === 'DELETE' && id) {
      const t = await env.DB.prepare('SELECT * FROM termine WHERE id = ?').bind(id).first();
      if (!t) return fail('Termin nicht gefunden.', 404);
      await env.DB.prepare('DELETE FROM termine WHERE id = ?').bind(id).run();
      await log(env, email, 'Termin gelöscht', `${t.datum} ${t.ort}`);
      return json({ ok: true });
    }
    if (m === 'POST' || (m === 'PUT' && id)) {
      let b;
      try { b = await readJson(req, 4000); } catch { return fail('Ungültige Anfrage.'); }
      const t = {
        datum: str(b.datum, 10), von: str(b.von, 5), bis: str(b.bis, 5), ort: str(b.ort, 120), info: str(b.info, 300),
        sichtbar: b.sichtbar === false || b.sichtbar === 0 ? 0 : 1,
      };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.datum) || Number.isNaN(Date.parse(t.datum))) return fail('Bitte ein gültiges Datum wählen.');
      for (const z of ['von', 'bis']) if (t[z] && !/^\d{1,2}:\d{2}$/.test(t[z])) return fail('Uhrzeiten bitte als 9:00 oder 14:30 angeben.');
      if (t.ort.length < 2) return fail('Bitte einen Ort angeben.');
      const ts = now();
      if (m === 'POST') {
        await env.DB.prepare('INSERT INTO termine (datum, von, bis, ort, info, sichtbar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(t.datum, t.von, t.bis, t.ort, t.info, t.sichtbar, ts, ts).run();
        await log(env, email, 'Termin angelegt', `${t.datum} ${t.von}–${t.bis} ${t.ort}${t.sichtbar ? '' : ' (versteckt)'}`);
      } else {
        const r = await env.DB.prepare('UPDATE termine SET datum = ?, von = ?, bis = ?, ort = ?, info = ?, sichtbar = ?, updated_at = ? WHERE id = ?')
          .bind(t.datum, t.von, t.bis, t.ort, t.info, t.sichtbar, ts, id).run();
        if (!r.meta.changes) return fail('Termin nicht gefunden.', 404);
        await log(env, email, 'Termin geändert', `${t.datum} ${t.von}–${t.bis} ${t.ort}${t.sichtbar ? '' : ' (versteckt)'}`);
      }
      return json({ ok: true });
    }
  }

  if (res === 'mailliste') {
    if (m === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, email, vorname, menge, created_at FROM mailliste ORDER BY id DESC').all();
      return json({ ok: true, liste: results });
    }
    if (m === 'DELETE' && id) {
      const e = await env.DB.prepare('SELECT email FROM mailliste WHERE id = ?').bind(id).first();
      if (!e) return fail('Eintrag nicht gefunden.', 404);
      await env.DB.prepare('DELETE FROM mailliste WHERE id = ?').bind(id).run();
      await log(env, email, 'Mail-Liste: Eintrag gelöscht', e.email.replace(/^(.).*(@.*)$/, '$1…$2'));
      return json({ ok: true });
    }
  }

  if (res === 'bestellungen') {
    if (m === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM bestellungen ORDER BY id DESC LIMIT 1000').all();
      return json({ ok: true, liste: results });
    }
    if (m === 'PUT' && id) {
      let b;
      try { b = await readJson(req, 4000); } catch { return fail('Ungültige Anfrage.'); }
      const alt = await env.DB.prepare('SELECT * FROM bestellungen WHERE id = ?').bind(id).first();
      if (!alt) return fail('Bestellung nicht gefunden.', 404);
      const status = b.status === undefined ? alt.status : str(b.status, 20);
      if (!STATUS.includes(status)) return fail('Unbekannter Status.');
      const notiz = b.notiz === undefined ? alt.notiz : str(b.notiz, 1000);
      const ts = now();
      const stmts = [env.DB.prepare('UPDATE bestellungen SET status = ?, notiz = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(status, notiz, ts, email, id)];
      // Lagerstand mitführen: Storno gibt Stück zurück, Rückgängig-Storno zieht wieder ab
      if (status !== alt.status && (status === 'storniert' || alt.status === 'storniert')) {
        const s = await getSettings(env);
        if (s.stueck_verfuegbar !== '') {
          const neu = Math.max(0, Number(s.stueck_verfuegbar) + (status === 'storniert' ? alt.menge : -alt.menge));
          stmts.push(env.DB.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('stueck_verfuegbar', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(String(neu), ts, email));
        }
      }
      const det = [status !== alt.status ? `Status ${alt.status} → ${status}` : '', notiz !== alt.notiz ? 'Notiz geändert' : ''].filter(Boolean).join(', ');
      if (det) stmts.push(env.DB.prepare('INSERT INTO protokoll (ts, email, aktion, details) VALUES (?, ?, ?, ?)').bind(ts, email, `Bestellung ${alt.nr}`, det));
      await env.DB.batch(stmts);
      return json({ ok: true });
    }
  }

  if (res === 'protokoll' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT ts, email, aktion, details FROM protokoll ORDER BY id DESC LIMIT 500').all();
    return json({ ok: true, liste: results });
  }

  if (res === 'export' && m === 'GET') {
    const tabs = ['settings', 'termine', 'mailliste', 'bestellungen', 'protokoll'];
    const out = { exportiert_am: now(), exportiert_von: email };
    for (const t of tabs) out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
    await log(env, email, 'Sicherung heruntergeladen', '');
    return json(out, 200, { 'content-disposition': `attachment; filename="backpackhero-sicherung-${heuteWien()}.json"` });
  }

  return fail('Nicht gefunden.', 404);
}

/* ---------- Wöchentliche Zusammenfassung ---------- */

async function wochenbericht(env) {
  await ensureSchema(env);
  const seit = new Date(Date.now() - 7 * 864e5).toISOString();
  const [neu, gesamt, offen, termine] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM mailliste WHERE created_at > ?').bind(seit).first(),
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(menge),0) AS menge FROM mailliste').first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM bestellungen WHERE status IN ('neu','bezahlt')").first(),
    env.DB.prepare('SELECT datum, von, ort FROM termine WHERE sichtbar = 1 AND datum >= ? ORDER BY datum LIMIT 3').bind(heuteWien()).all(),
  ]);
  const t = termine.results.map((x) => `- ${x.datum.split('-').reverse().join('.')} ${x.von ? x.von + ' Uhr ' : ''}${x.ort}`).join('\n') || '- keine eingetragen';
  await sendMail(env, `Backpack Hero: Wochenübersicht (${neu.n} neue auf der Mail-Liste)`,
    `Hallo Team,\n\nhier die Woche auf der Website:\n\nMail-Liste: ${neu.n} neue Einträge, insgesamt ${gesamt.n}` +
    (gesamt.menge ? ` (zusammen ${gesamt.menge} Stück gewünscht)` : '') +
    `\nBestellungen, die noch bearbeitet werden müssen: ${offen.n}\n\nNächste Termine:\n${t}\n\nAlles Weitere im Admin.\n`);
}

/* ---------- Einstiegspunkt ---------- */

const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith('/admin')) {
      const email = await adminEmail(req, env);
      if (!email) return new Response('Kein Zugriff. Bitte über den Login anmelden.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', ...SEC_HEADERS } });
      const r = await env.ASSETS.fetch(req);
      const h = new Headers(r.headers);
      for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
      h.set('cache-control', 'no-store');
      return new Response(r.body, { status: r.status, headers: h });
    }

    if (path.startsWith('/api/')) {
      try {
        await ensureSchema(env);
        if (path === '/api/public' && req.method === 'GET') return json(await publicData(env));
        if (path === '/api/mailliste' && req.method === 'POST') return await mailliste(req, env);
        if (path === '/api/bestellung' && req.method === 'POST') return await bestellung(req, env);
        if (path.startsWith('/api/admin/')) {
          const email = await adminEmail(req, env);
          if (!email) return fail('Nicht angemeldet.', 401);
          return await admin(req, env, path, email);
        }
        return fail('Nicht gefunden.', 404);
      } catch (e) {
        console.log('Fehler', path, e && e.message);
        return fail('Da ist auf unserer Seite etwas schiefgelaufen.', 500);
      }
    }

    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(wochenbericht(env));
  },
};
