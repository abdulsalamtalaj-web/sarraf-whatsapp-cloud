// محلّل نشرات الأسعار من صفحة تليجرام العامة (https://t.me/s/<channel>)
// دالة نقية بدون اعتماديات: تعمل في Cloudflare Workers وفي Node للاختبار وفي Background Runner.

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&rlm;': '', '&lrm;': '',
};

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (e) => (e.toLowerCase() in ENTITIES ? ENTITIES[e.toLowerCase()] : e));
}

// تحويل الأرقام العربية والفارسية والفواصل إلى صيغة قياسية
export function normalizeDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')            // فاصلة عشرية عربية
    .replace(/٬/g, ',')            // فاصل آلاف عربي
    .replace(/[‎‏‪-‮⁦-⁩]/g, ''); // علامات الاتجاه
}

// تفسير رقم مكتوب بفواصل: يميّز فاصل الآلاف عن الكسر العشري
//   "14,700" "11.650" "1.450.000" → آلاف      "146.75" "116.5" "146,90" → كسر
//   "1.450,5" (أوروبي) → 1450.5             "0.024" → كسر (لا يبدأ رقم آلاف بصفر)
function interpret(t) {
  const hasDot = t.includes('.'), hasComma = t.includes(',');
  if (hasDot && hasComma) {
    const last = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
    const dec = t.slice(last + 1);
    const int = t.slice(0, last).replace(/[.,]/g, '');
    return dec.length === 3 ? parseFloat(int + dec) : parseFloat(int + '.' + dec);
  }
  const sep = hasDot ? '.' : hasComma ? ',' : null;
  if (!sep) return parseFloat(t);
  const parts = t.split(sep);
  if (parts.length > 2) return parseFloat(parts.join('')); // أكثر من فاصل = آلاف حتماً
  const [a, b] = parts;
  // فاصل واحد متبوع بثلاث خانات بالضبط والجزء الصحيح ليس صفراً = آلاف
  if (b.length === 3 && a !== '0' && a.length <= 3) return parseFloat(a + b);
  return parseFloat(a + '.' + b);
}

// استخراج أول رقم من نص
export function parseNumber(s) {
  const m = normalizeDigits(s).match(/\d(?:[\d.,]*\d)?/);
  if (!m) return null;
  const v = interpret(m[0]);
  return Number.isFinite(v) ? v : null;
}
// كل الأرقام في نص
function allNumbers(s) {
  return (normalizeDigits(s).match(/\d(?:[\d.,]*\d)?/g) || []).map(interpret).filter(Number.isFinite);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

// تقسيم الصفحة إلى رسائل: [{id, time, text}] من الأقدم إلى الأحدث
export function extractMessages(html) {
  const out = [];
  const parts = html.split('tgme_widget_message_wrap').slice(1);
  for (const p of parts) {
    const id = (p.match(/data-post="([^"]+)"/) || [])[1] || null;
    const time = (p.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || null;
    const m = p.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!m) continue; // رسائل صور فقط
    out.push({ id, time, text: htmlToText(m[1]) });
  }
  return out;
}

// ---------------- المدن ----------------
const CITIES = [
  ['damascus', /دمشق|الشام(?!ية)/], ['aleppo', /حلب/], ['idlib', /[إا]دلب/], ['homs', /حمص/],
  ['hama', /حما[هة]/], ['latakia', /اللاذقي[هة]/], ['hasakah', /الحسك[هة]/], ['qamishli', /القامشلي/],
  ['deir', /دير\s?الزور/], ['daraa', /درعا/], ['sweida', /السويداء/], ['raqqa', /الرق[هة]/], ['tartus', /طرطوس/],
];
function detectCity(s) {
  for (const [id, re] of CITIES) if (re.test(s)) return id;
  return null;
}

// ---------------- الأزواج ----------------
// أعلام الإيموجي كبديل عن الاسم (🇺🇸 🇹🇷 🇪🇺 🇸🇾)
const FLAG_US = /\u{1F1FA}\u{1F1F8}/u, FLAG_TR = /\u{1F1F9}\u{1F1F7}/u, FLAG_EU = /\u{1F1EA}\u{1F1FA}/u;
// عملات/سلع أخرى: أي سطر يذكرها ليس من أزواجنا (مثلاً "الريال السعودي مقابل الدولار")
const OTHER = /ريال|درهم|دينار|جنيه|استرليني|إسترليني|ين\b|يوان|روبل|فرنك|ذهب|فض[ةه]|بيتكوين|برنت|نفط|عيار|أونص|اونص|SAR|AED|KWD|JOD|GBP|BTC/i;

// تحديد الزوج من سطر عنوان. بدون ذكر "سوري" يُعتبر السعر بالليرة السورية افتراضياً.
function detectPair(line) {
  const l = line;
  const syp = /سوري|ل\.\s?س|SYP/i.test(l);
  const usd = /دولار|USD|\$/i.test(l) || FLAG_US.test(l);
  const tr = /ترك|TRY|₺/i.test(l) || FLAG_TR.test(l);
  const eur = /يورو|EUR|€/i.test(l) || FLAG_EU.test(l);
  if (OTHER.test(l)) return null;
  if (tr && usd && !syp) return 'try_usd';       // الدولار بالليرة التركية
  if (eur && usd && !syp) return null;           // اليورو مقابل الدولار: لا يعنينا
  if (tr) return 'try_syp';
  if (eur) return 'eur_syp';
  if (usd) return 'usd_syp';
  return null;
}

const BUY_RE = /شراء|الشراء|شرا\b|buy/i;
const SELL_RE = /مبيع|المبيع|بيع|sell/i;
const KW_RE = /^[^\d]*?(شراء|الشراء|شرا|مبيع|المبيع|بيع|buy|sell)/i;

// نطاقات منطقية (بالليرة الجديدة بعد التحويل) لرفض الأرقام الشاذة
const RANGE = { usd_syp: [30, 2000], eur_syp: [30, 2500], try_syp: [0.5, 80], try_usd: [5, 300] };
const inRange = (k, p) => p && p.buy > 0 && p.sell > 0 && p.buy >= RANGE[k][0] && p.sell <= RANGE[k][1];

// تحليل نص النشرة إلى دلاء حسب المدينة: { _: {...}, damascus: {...}, aleppo: {...} }
function collect(text) {
  const t = normalizeDigits(text);
  const buckets = {};
  let cur = null, city = null;
  const put = (pair, side, num) => {
    const b = (buckets[city || '_'] = buckets[city || '_'] || {});
    b[pair] = b[pair] || {};
    if (b[pair][side] == null) b[pair][side] = num;
  };
  for (const rawLine of t.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const c = detectCity(line);
    if (c) city = c;
    // سطر فيه زوج ورقمان بدون كلمة شراء/مبيع: "الدولار: 11650 / 11750"
    if (!BUY_RE.test(line) && !SELL_RE.test(line)) {
      const p = detectPair(line);
      if (p) cur = p;
      else if (OTHER.test(line)) { cur = null; continue; } // عنوان عملة أخرى: تجاهل ما تحته
      const nums = allNumbers(line.replace(/\d{1,2}[:/]\d{2}(?:[:/]\d{2,4})?/g, '')); // بدون أوقات وتواريخ
      if (cur && nums.length === 2 && (p || c)) {
        put(cur, 'buy', Math.min(...nums));
        put(cur, 'sell', Math.max(...nums));
      }
      continue;
    }
    // كل مقطع مفصول بـ / أو | أو - يعامل كسطر مستقل، وكذلك ما قبل كل كلمة شراء/مبيع
    // ("الدولار شراء 146.9 مبيع 147.4" → "الدولار" + "شراء 146.9" + "مبيع 147.4")
    const segs = line.split(/\s[\/|]\s|\s-\s|،\s/).flatMap((s) => s.split(/(?=شراء|مبيع|\bbuy|\bsell)/i));
    for (const seg0 of segs) {
      const seg = seg0.trim();
      if (!seg) continue;
      const sc = detectCity(seg);
      if (sc) city = sc;
      const isBuy = BUY_RE.test(seg);
      const isSell = !isBuy && SELL_RE.test(seg);
      const head = seg.split(BUY_RE)[0].split(SELL_RE)[0];
      const p = detectPair(head);
      if (p) cur = p;
      else if (OTHER.test(head)) { cur = null; continue; }
      if (!isBuy && !isSell) continue;
      if (!cur) continue;
      const num = parseNumber(seg.replace(KW_RE, ''));
      if (num == null) continue;
      put(cur, isBuy ? 'buy' : 'sell', num);
    }
  }
  return buckets;
}

function validPairs(r) {
  const o = {};
  for (const k of Object.keys(RANGE)) {
    const p = r[k];
    if (!p || p.buy == null || p.sell == null) continue;
    if (p.buy > p.sell) continue;        // فحص منطقي: الشراء لا يكون أكبر من المبيع
    o[k] = { buy: p.buy, sell: p.sell };
  }
  return o;
}

// تحليل نص رسالة واحدة. يرجع null إذا لم تكن نشرة أسعار صالحة.
// النشرات المقسّمة حسب المدن: دمشق افتراضياً، وإلا القسم العام، وإلا أول مدينة صالحة.
export function parseBulletin(text, preferCity = 'damascus') {
  const buckets = collect(text);
  const order = [preferCity, '_', ...Object.keys(buckets)];
  for (const key of order) {
    if (!buckets[key]) continue;
    // قيم القسم العام (مثل التركي مقابل الدولار) تكمّل قسم المدينة
    const merged = key === '_' ? buckets._ : { ...(buckets._ || {}), ...buckets[key] };
    const r = fixUnits(validPairs(merged));
    for (const k of Object.keys(r)) if (!inRange(k, r[k])) delete r[k];
    if (r.usd_syp) {
      if (key !== '_') r.city = key;
      return r;
    }
  }
  return null;
}

function scale(pair, f) {
  return pair ? { buy: round(pair.buy * f), sell: round(pair.sell * f) } : pair;
}
function round(v) {
  return v == null ? v : Math.round(v * 10000) / 10000;
}

// الليرة القديمة → الجديدة بالقسمة على 100، وقلب TRY/USD إن جاء معكوساً
export function fixUnits(r) {
  const o = { ...r };
  if (o.usd_syp && o.usd_syp.buy > 2000) o.usd_syp = scale(o.usd_syp, 0.01);
  if (o.eur_syp && o.eur_syp.buy > 2500) o.eur_syp = scale(o.eur_syp, 0.01);
  if (o.try_syp && o.try_syp.buy > 80) o.try_syp = scale(o.try_syp, 0.01);
  if (o.try_usd && o.try_usd.buy < 1) {
    o.try_usd = { buy: round(1 / o.try_usd.sell), sell: round(1 / o.try_usd.buy) };
  }
  return o;
}

// أحدث نشرة صالحة في الصفحة، ومعها النشرة التي قبلها (للتأكيد الذاتي)
export function parseChannelPage(html) {
  const msgs = extractMessages(html);
  let latest = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const r = parseBulletin(msgs[i].text);
    if (!r) continue;
    const item = { ...r, post_time: msgs[i].time, post_id: msgs[i].id };
    if (!latest) { latest = item; continue; }
    latest.previous = { usd_syp: item.usd_syp, post_time: item.post_time };
    break;
  }
  return latest;
}

// ---------------- الذهب ----------------
// يتعرف على أسطر مثل:
//   "أونصة الذهب: $3941.85"     "عيار 21: $111"     "غرام عيار 21: ١٬٢٥٠٬٠٠٠ ل.س"
//   "الليرة الذهب: 9,800,000 ل.س"
function currencyOf(line, value) {
  if (/\$|دولار|USD/i.test(line)) return 'usd';
  if (/ل\.?\s?س|سوري|SYP/i.test(line)) return 'syp';
  return value > 5000 ? 'syp' : 'usd';
}

export function parseGold(text) {
  const t = normalizeDigits(text);
  if (!/ذهب|عيار/.test(t)) return null;
  const g = { ounce_usd: null, gram: {}, lira: null };
  for (const raw of t.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const k = line.match(/عيار\s*(24|22|21|18|14)\s*[^\d]*?(\d(?:[\d.,]*\d)?)/);
    if (k && !/أونص|اونص/.test(line)) {
      const v = parseNumber(k[2]);
      if (v) g.gram[k[1]] = { value: v, cur: currencyOf(line, v) };
      continue;
    }
    if (/(أونص|اونص)[^\n]*ذهب|ذهب[^\n]*(أونص|اونص)/.test(line)) {
      const v = parseNumber(line.replace(/^[^\d]*/, ''));
      if (v && v > 500) g.ounce_usd = v; // الأونصة دائماً بالدولار
      continue;
    }
    if (/(ليرة|الليرة)\s*(ال)?ذهب/.test(line)) {
      const v = parseNumber(line.replace(/^[^\d]*/, ''));
      if (v) g.lira = { value: v, cur: currencyOf(line, v) };
    }
  }
  if (!g.ounce_usd && !Object.keys(g.gram).length && !g.lira) return null;
  return g;
}

// أحدث رسالة فيها أسعار ذهب
export function parseGoldPage(html) {
  const msgs = extractMessages(html);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const g = parseGold(msgs[i].text);
    if (g) return { ...g, post_time: msgs[i].time, post_id: msgs[i].id };
  }
  return null;
}
