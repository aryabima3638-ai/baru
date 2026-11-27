// ============================================================
//  FLUTTER SC BUILDER  -  index.js (menu utama)
// ============================================================
const { Telegraf } = require('telegraf');
const cfg = require('./setting');
const { Store } = require('./lib/db');
const { createGithub } = require('./lib/github');
const { createBuilder, MAINT_TEXT } = require('./lib/builder');
const { esc, fmtBytes, fmtDur, sleep } = require('./lib/util');

// ---------- cek konfigurasi ----------
const bad = [];
if (!cfg.botToken || cfg.botToken.startsWith('ISI_')) bad.push('botToken');
if (!cfg.owners.length || cfg.owners.includes(123456789)) bad.push('owners (telegram.js)');
if (!cfg.github.token || cfg.github.token.startsWith('ISI_')) bad.push('github.token');
if (cfg.github.owner.startsWith('ISI_') || cfg.github.repo.startsWith('ISI_')) bad.push('github.owner / github.repo');
if (bad.length) { console.error('❌ Isi dulu setting.js / telegram.js:', bad.join(', ')); process.exit(1); }
if (typeof fetch !== 'function') { console.error('❌ Butuh Node.js 18 ke atas. Ganti versi Node di panel.'); process.exit(1); }

const bot = new Telegraf(cfg.botToken, { telegram: { apiRoot: cfg.telegramApiRoot }, handlerTimeout: 600000 });
const db = new Store(cfg.dbFile, cfg);
const gh = createGithub(cfg);
const builder = createBuilder({ tg: bot.telegram, db, cfg, gh });
const pending = new Map(); // userId -> { target, mode, at }

const isRoot = (id) => db.isRoot(id);
const roleOf = (id) => db.role(id);
const ROLE = { member: '👤 MEMBER', reseller: '💼 RESELLER', owner: '👑 OWNER' };
const b = (t, d) => ({ text: t, callback_data: d });
const WARN_ABOVE_MEMBER = '⚠️ <b>WARNING!</b>\nHanya role di atas member (RESELLER / OWNER) yang bisa memakai command ini!';
const WARN_OWNER = '⚠️ <b>WARNING!</b>\nHanya role OWNER yang bisa memakai command ini!';
const creditEmpty = () => `❌ <b>CREDIT ANDA SUDAH HABIS!!!</b>\nSILAHKAN BELI CREDIT/TUNGGU 1 HARI LAGI UNTUK MENDAPATKAN CREDIT ANDA KEMBALI\n\n👤 OWNER : ${esc(cfg.ownerUsername)}`;
const maintOn = () => !!db.d.settings.maintenance;
const newId = () => 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const userLink = (u) => (u.username ? `@${esc(u.username)}` : esc(u.name));

// ---------- kirim kartu (foto + caption) ----------
async function sendCard(chatId, text, rows) {
  const extra = { caption: text.slice(0, 1024), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  try {
    const cache = (db.d.settings.photoCache ||= {});
    const m = await bot.telegram.sendPhoto(chatId, cache[cfg.photoUrl] || cfg.photoUrl, extra);
    if (!cache[cfg.photoUrl] && m.photo?.length) { cache[cfg.photoUrl] = m.photo[m.photo.length - 1].file_id; db.save(); }
    return m;
  } catch (e) {
    return bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  }
}
// ganti isi kartu yang sedang tampil (caption jika foto, teks jika tidak)
async function screen(ctx, text, rows) {
  const m = ctx.callbackQuery?.message;
  const extra = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  try {
    if (m?.photo) await ctx.editMessageCaption(text.slice(0, 1024), extra);
    else if (m) await ctx.editMessageText(text, extra);
    else await sendCard(ctx.chat.id, text, rows);
  } catch (e) {
    if (!/not modified/i.test(e.message)) { await ctx.deleteMessage().catch(() => {}); await sendCard(ctx.chat.id, text, rows); }
  }
}
async function notifyChannel(text) {
  if (!cfg.channel.id) return;
  try {
    const cache = (db.d.settings.photoCache ||= {});
    await bot.telegram.sendPhoto(cfg.channel.id, cache[cfg.photoUrl] || cfg.photoUrl, { caption: text.slice(0, 1024), parse_mode: 'HTML' });
  } catch {
    await bot.telegram.sendMessage(cfg.channel.id, text, { parse_mode: 'HTML' }).catch((e) => console.error('[channel]', e.message));
  }
}

// ---------- channel ----------
async function isJoined(userId) {
  if (!cfg.channel.id) return true;
  const m = await bot.telegram.getChatMember(cfg.channel.id, userId);
  if (m.status === 'restricted') return m.is_member !== false;
  return ['creator', 'administrator', 'member'].includes(m.status);
}
const joinRows = () => [
  [{ text: '📢 Join Channel', url: cfg.channel.url }],
  [b('✅ Verifikasi', 'verify')],
];
const joinText = () => `🤖 <b>FLUTTER SC BUILDER</b>\n━━━━━━━━━━━━━━\nSelamat datang! Ubah project Flutter (ZIP) jadi <b>APK / Web</b> otomatis.\n\n⚠️ Untuk memakai bot, <b>wajib join channel</b> dulu, lalu tekan <b>Verifikasi</b>.`;

// ---------- menu ----------
function menuText(uid) {
  const u = db.stub(uid);
  return `🤖 <b>FLUTTER SC BUILDER</b>\n━━━━━━━━━━━━━━\n👤 Nama: <b>${esc(u.name)}</b>\n🆔 ID: <code>${u.id}</code>\n🎖 Role: <b>${ROLE[roleOf(uid)]}</b>\n💳 Credit: <b>${esc(db.creditText(uid))}</b>\n━━━━━━━━━━━━━━\n${maintOn() ? `🔧 <b>MAINTENANCE AKTIF</b>\n` : ''}Pilih menu di bawah 👇`;
}
function menuRows(uid) {
  const r = [
    [b('🌐 Build Web', 'b:web'), b('🐦 Build Flutter', 'b:flutter')],
    [b('💳 Credit Saya', 'credit'), b('👤 Profil', 'profile')],
    [b('📜 Riwayat Build', 'history'), b('📊 Status Bot', 'status')],
    [{ text: '📢 Channel', url: cfg.channel.url }, b('ℹ️ Bantuan', 'help')],
  ];
  const role = roleOf(uid);
  if (role !== 'member') r.push([b('💼 Panel Reseller', 'reseller')]);
  if (role === 'owner') r.push([b('👑 Panel Owner', 'owner')]);
  return r;
}
const back = [[b('⬅️ Menu Utama', 'menu')]];
const sendMenu = (chatId, uid) => sendCard(chatId, menuText(uid), menuRows(uid));

// ---------- middleware ----------
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private') return;
  if (ctx.from && !ctx.from.is_bot) db.ensure(ctx.from);
  return next();
});

// ---------- /start ----------
bot.start(async (ctx) => {
  const u = db.ensure(ctx.from);
  if (!u.startNotified) {
    u.startNotified = true; db.save();
    notifyChannel(`🆕 <b>USER MEMULAI BOT</b>\n━━━━━━━━━━━━━━\n👤 ${esc(u.name)} (${userLink(u)})\n🆔 <code>${u.id}</code>\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
  }
  let joined = u.verified;
  if (joined) { try { joined = await isJoined(ctx.from.id); } catch { joined = true; } }
  if (!joined) { u.verified = false; db.save(); return sendCard(ctx.chat.id, joinText(), joinRows()); }
  return sendMenu(ctx.chat.id, ctx.from.id);
});
bot.command('menu', async (ctx) => {
  const u = db.ensure(ctx.from);
  if (!u.verified) return sendCard(ctx.chat.id, joinText(), joinRows());
  return sendMenu(ctx.chat.id, ctx.from.id);
});
bot.command('id', (ctx) => ctx.reply(`🆔 ID kamu: ${ctx.from.id}`));

bot.action('verify', async (ctx) => {
  let ok;
  try { ok = await isJoined(ctx.from.id); }
  catch (e) {
    console.error('[verify]', e.message);
    await ctx.answerCbQuery('Bot gagal mengecek channel.', { show_alert: true }).catch(() => {});
    return ctx.reply('⚠️ Bot gagal mengecek keanggotaan channel. Pastikan <b>bot sudah jadi admin di channel</b> dan channel.id di setting.js benar. Hubungi owner ' + esc(cfg.ownerUsername), { parse_mode: 'HTML' });
  }
  if (!ok) return ctx.answerCbQuery('❌ Kamu belum join channel!', { show_alert: true }).catch(() => {});
  const u = db.ensure(ctx.from);
  const first = !u.verified;
  u.verified = true; db.save();
  await ctx.answerCbQuery('✅ Verifikasi berhasil!').catch(() => {});
  if (first) notifyChannel(`✅ <b>USER BARU TERVERIFIKASI</b>\n━━━━━━━━━━━━━━\n👤 ${esc(u.name)} (${userLink(u)})\n🆔 <code>${u.id}</code>\n🎖 Role: ${ROLE[roleOf(u.id)]}\n💳 Credit awal: ${cfg.freeCredits}\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
  await ctx.deleteMessage().catch(() => {});
  return sendMenu(ctx.chat.id, ctx.from.id);
});

// gerbang: wajib verified
const guard = (fn) => async (ctx) => {
  const u = db.ensure(ctx.from);
  if (!u.verified) { await ctx.answerCbQuery().catch(() => {}); return screen(ctx, joinText(), joinRows()); }
  try { return await fn(ctx, u); }
  finally { ctx.answerCbQuery().catch(() => {}); } // no-op jika handler sudah menjawab (mis. alert)
};
const ownerOnly = (fn) => guard(async (ctx, u) => {
  if (roleOf(u.id) !== 'owner') return ctx.answerCbQuery('Khusus OWNER!', { show_alert: true }).catch(() => {});
  return fn(ctx, u);
});

bot.action('menu', guard((ctx) => { pending.delete(ctx.from.id); return screen(ctx, menuText(ctx.from.id), menuRows(ctx.from.id)); }));

// ---------- build ----------
bot.action('b:flutter', guard((ctx) => screen(ctx, '🐦 <b>BUILD FLUTTER (APK)</b>\n━━━━━━━━━━━━━━\nPilih jenis build:\n\n🚀 <b>Release</b> — APK siap pakai, ukuran kecil\n🐞 <b>Debug</b> — untuk testing', [[b('🚀 Release', 'bm:apk:release'), b('🐞 Debug', 'bm:apk:debug')], [b('⬅️ Kembali', 'menu')]])));
bot.action('b:web', guard((ctx) => askZip(ctx, 'web', 'release')));
bot.action(/^bm:(apk):(release|debug)$/, guard((ctx) => askZip(ctx, ctx.match[1], ctx.match[2])));

async function askZip(ctx, target, mode) {
  if (maintOn() && !isRoot(ctx.from.id)) return screen(ctx, `🔧 <b>${MAINT_TEXT}</b>`, back);
  if (!db.hasCredit(ctx.from.id)) return screen(ctx, creditEmpty(), back);
  pending.set(ctx.from.id, { target, mode, at: Date.now() });
  const lim = cfg.localBotApi ? 'sampai 2GB' : 'maks 20MB';
  return screen(ctx, `📤 <b>KIRIM PROJECT</b>\n━━━━━━━━━━━━━━\nMode: <b>${target === 'web' ? '🌐 Web' : mode === 'debug' ? '🐞 APK Debug' : '🚀 APK Release'}</b>\n\n1️⃣ Kirim file <b>.zip</b> project Flutter (${lim} lewat Telegram)\n2️⃣ Untuk ZIP lebih besar (sampai <b>2GB</b>) kirim <b>link direct download</b> (http/https)\n\nBot menunggu 10 menit.`, [[b('❌ Batal', 'menu')]]);
}

async function accept(ctx, source) {
  const uid = ctx.from.id;
  const p = pending.get(uid);
  if (!p || Date.now() - p.at > 600000) { pending.delete(uid); return ctx.reply('Pilih menu <b>Build</b> dulu lewat /menu, baru kirim ZIP-nya.', { parse_mode: 'HTML' }); }
  if (maintOn() && !isRoot(uid)) { pending.delete(uid); return ctx.reply(`🔧 ${MAINT_TEXT}`); }
  try { if (!(await isJoined(uid))) { db.d.users[uid].verified = false; db.save(); return sendCard(ctx.chat.id, joinText(), joinRows()); } } catch {}
  if (builder.userActive(uid)) return ctx.reply('⚠️ Kamu masih punya build yang berjalan. Tunggu selesai atau batalkan dulu.');
  if (builder.count() >= cfg.maxConcurrentBuilds) return ctx.reply('⏳ Antrian build sedang penuh. Coba lagi 1–2 menit lagi.');
  if (!db.hasCredit(uid)) { pending.delete(uid); return ctx.reply(creditEmpty(), { parse_mode: 'HTML' }); }

  const msg = await ctx.reply('⏳ Menyiapkan build...');
  const job = { id: newId(), userId: uid, chatId: ctx.chat.id, msgId: msg.message_id, target: p.target, mode: p.mode, source };
  if (!db.charge(job.id, uid)) return ctx.reply(creditEmpty(), { parse_mode: 'HTML' });
  pending.delete(uid);
  try { builder.start(job); }
  catch (e) { db.refund(job.id); console.error(e); return ctx.reply('❌ Gagal memulai build: ' + e.message + '\n💳 Credit dikembalikan.'); }
}

bot.on('document', async (ctx) => {
  const d = ctx.message.document;
  if (!pending.has(ctx.from.id)) return ctx.reply('Pilih menu <b>Build</b> dulu lewat /menu.', { parse_mode: 'HTML' });
  if (!/\.zip$/i.test(d.file_name || '') && !/zip/.test(d.mime_type || '')) return ctx.reply('❌ File harus berformat <b>.zip</b>', { parse_mode: 'HTML' });
  if (d.file_size > cfg.limits.maxZipBytes) return ctx.reply(`❌ ZIP ${fmtBytes(d.file_size)} melebihi batas ${fmtBytes(cfg.limits.maxZipBytes)}.`);
  if (d.file_size > 20 * 1024 * 1024 && !cfg.localBotApi) {
    return ctx.reply(`⚠️ ZIP ${fmtBytes(d.file_size)} terlalu besar untuk diunduh bot lewat Telegram (batas 20MB).\n\nUpload ZIP ke hosting file (direct link) lalu <b>kirim linknya di sini</b> — bot bisa mengunduh sampai <b>2GB</b>.`, { parse_mode: 'HTML' });
  }
  return accept(ctx, { type: 'tg', fileId: d.file_id, size: d.file_size });
});

bot.on('text', async (ctx, next) => {
  const t = ctx.message.text.trim();
  if (!pending.has(ctx.from.id)) return next();
  if (!/^https?:\/\/\S+$/i.test(t)) return ctx.reply('Kirim file ZIP atau link direct download (diawali http:// atau https://).');
  return accept(ctx, { type: 'url', url: t });
});

bot.action(/^cancel:(.+)$/, async (ctx) => {
  const job = builder.get(ctx.match[1]);
  if (!job) return ctx.answerCbQuery('Build sudah selesai.').catch(() => {});
  if (job.userId !== ctx.from.id && roleOf(ctx.from.id) !== 'owner') return ctx.answerCbQuery('Bukan build kamu!', { show_alert: true }).catch(() => {});
  builder.abort(job.id, 'user');
  return ctx.answerCbQuery('Membatalkan build...').catch(() => {});
});

// ---------- info ----------
bot.action('credit', guard((ctx) => {
  const role = roleOf(ctx.from.id);
  const note = role === 'member' ? `\n\nMember dapat <b>${cfg.freeCredits} credit gratis</b>. Setiap build memakai 1 credit. Jika habis, tunggu ${cfg.creditResetHours} jam atau beli ke ${esc(cfg.ownerUsername)}.` : '\n\nRole kamu: build <b>UNLIMITED</b> 🎉';
  return screen(ctx, `💳 <b>CREDIT SAYA</b>\n━━━━━━━━━━━━━━\nSaldo: <b>${esc(db.creditText(ctx.from.id))}</b>${note}`, back);
}));
bot.action('profile', guard((ctx, u) => screen(ctx, `👤 <b>PROFIL</b>\n━━━━━━━━━━━━━━\nNama: <b>${esc(u.name)}</b>\nUsername: ${u.username ? '@' + esc(u.username) : '-'}\nID: <code>${u.id}</code>\nRole: <b>${ROLE[roleOf(u.id)]}</b>\nCredit: <b>${esc(db.creditText(u.id))}</b>\nTotal build sukses: <b>${u.builds || 0}</b>\nBergabung: ${new Date(u.joinedAt).toLocaleDateString('id-ID')}`, back)));
bot.action('history', guard((ctx) => {
  const h = db.d.history.filter((x) => x.userId === ctx.from.id).slice(-8).reverse();
  const lines = h.map((x) => `${x.state === 'success' ? '✅' : x.state === 'failed' ? '❌' : '🚫'} ${x.target === 'web' ? 'Web' : 'APK ' + x.mode} • ${fmtDur(x.dur)} • ${new Date(x.at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
  return screen(ctx, `📜 <b>RIWAYAT BUILD</b>\n━━━━━━━━━━━━━━\n${lines.join('\n') || 'Belum ada build.'}`, back);
}));
bot.action('status', guard((ctx) => screen(ctx, `📊 <b>STATUS BOT</b>\n━━━━━━━━━━━━━━\nStatus: ${maintOn() ? '🔧 MAINTENANCE' : '🟢 ONLINE'}\nBuild berjalan: <b>${builder.count()} / ${cfg.maxConcurrentBuilds}</b>\nUptime: ${fmtDur(process.uptime() * 1000)}\nMesin build: GitHub Actions (ubuntu-latest)`, back)));
bot.action('help', guard((ctx) => screen(ctx, `ℹ️ <b>BANTUAN</b>\n━━━━━━━━━━━━━━\n1. Menu <b>Build Flutter</b> → Release/Debug (APK)\n2. Menu <b>Build Web</b> → hasil ZIP web\n3. Kirim ZIP project (atau link direct sampai 2GB)\n4. Tunggu progres, hasil dikirim otomatis\n\nJika gagal, bot kirim <b>penyebab + log lengkap</b>.\nCommand: /menu /id /cancel\nOwner: ${esc(cfg.ownerUsername)}`, back)));
bot.command('cancel', (ctx) => { pending.delete(ctx.from.id); return ctx.reply('✅ Dibatalkan.'); });

// ---------- panel reseller & owner ----------
bot.action('reseller', guard((ctx) => {
  if (roleOf(ctx.from.id) === 'member') return ctx.answerCbQuery('Khusus RESELLER/OWNER!', { show_alert: true }).catch(() => {});
  return screen(ctx, `💼 <b>PANEL RESELLER</b>\n━━━━━━━━━━━━━━\nBuild UNLIMITED + jual credit.\n\n<code>/addcredit ID_USER [jumlah]</code>\nTambah credit user (default ${cfg.defaultAddCredit}, maks ${cfg.resellerMaxPerCommand}/command).\n\nUser harus pernah /start bot agar menerima notifikasi.`, back);
}));

const ownerRows = () => [
  [b(maintOn() ? '🟢 Matikan Maintenance' : '🔧 Nyalakan Maintenance', 'own:maint')],
  [b('📊 Statistik', 'own:stats'), b('👥 Daftar User', 'own:users')],
  [b('🧹 Bersihkan GitHub', 'own:sweep'), b('📣 Cara Broadcast', 'own:bc')],
  [b('⬅️ Menu Utama', 'menu')],
];
const ownerText = () => `👑 <b>PANEL OWNER</b>\n━━━━━━━━━━━━━━\nMaintenance: ${maintOn() ? '🔧 <b>AKTIF</b>' : '🟢 mati'}\nBuild berjalan: ${builder.count()}\n\n<b>Command:</b>\n/addcredit ID [jumlah]\n/address ID — jadikan RESELLER\n/addowner ID — jadikan OWNER\n/delreseller ID\n/maintenance on|off\n/broadcast teks`;
bot.action('owner', ownerOnly((ctx) => screen(ctx, ownerText(), ownerRows())));

async function setMaintenance(ctx, on) {
  if (!isRoot(ctx.from.id)) return false; // hanya ID di telegram.js
  db.d.settings.maintenance = on;
  db.d.settings.maintenanceBy = ctx.from.id;
  db.d.settings.maintenanceAt = Date.now();
  db.save();
  return on ? builder.abortAll('maintenance') : 0;
}
bot.action('own:maint', ownerOnly(async (ctx) => {
  if (!isRoot(ctx.from.id)) return ctx.answerCbQuery('Maintenance hanya untuk owner utama (telegram.js).', { show_alert: true }).catch(() => {});
  const n = await setMaintenance(ctx, !maintOn());
  await screen(ctx, ownerText() + (maintOn() ? `\n\n🔧 Maintenance <b>DINYALAKAN</b>. ${n} build aktif dihentikan & credit dikembalikan.` : '\n\n🟢 Maintenance <b>DIMATIKAN</b>.'), ownerRows());
}));
bot.command('maintenance', async (ctx) => {
  if (!isRoot(ctx.from.id)) return ctx.reply(WARN_OWNER, { parse_mode: 'HTML' });
  const a = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
  if (!['on', 'off'].includes(a)) return ctx.reply('Pakai: /maintenance on  atau  /maintenance off');
  const n = await setMaintenance(ctx, a === 'on');
  return ctx.reply(a === 'on' ? `🔧 Maintenance AKTIF. ${n} build dihentikan.` : '🟢 Maintenance dimatikan.');
});
bot.action('own:stats', ownerOnly((ctx) => {
  const us = Object.values(db.d.users);
  const c = (r) => us.filter((u) => roleOf(u.id) === r).length;
  const h = db.d.history;
  return screen(ctx, `📊 <b>STATISTIK</b>\n━━━━━━━━━━━━━━\nTotal user: <b>${us.length}</b>\nTerverifikasi: ${us.filter((u) => u.verified).length}\nMember: ${c('member')} • Reseller: ${c('reseller')} • Owner: ${c('owner')}\n\nBuild (500 terakhir): ${h.length}\n✅ ${h.filter((x) => x.state === 'success').length} • ❌ ${h.filter((x) => x.state === 'failed').length} • 🚫 ${h.filter((x) => x.state === 'aborted').length}\nBuild berjalan: ${builder.count()}`, [[b('⬅️ Panel Owner', 'owner')]]);
}));
bot.action('own:users', ownerOnly(async (ctx) => {
  const us = Object.values(db.d.users).slice(-25).reverse();
  const t = us.map((u) => `${ROLE[roleOf(u.id)].split(' ')[0]} <code>${u.id}</code> ${esc(u.name)} • 💳${u.role === 'member' ? u.credits : '∞'}`).join('\n');
  await ctx.reply(`👥 <b>25 USER TERBARU</b>\n${t || '-'}`, { parse_mode: 'HTML' });
}));
bot.action('own:sweep', ownerOnly(async (ctx) => {
  let t;
  try { t = `🧹 ${await gh.sweep(0, builder.activeTags())} release lama dihapus dari GitHub.`; } catch (e) { t = '❌ ' + e.message; }
  await ctx.reply(t);
}));
bot.action('own:bc', ownerOnly((ctx) => ctx.reply('📣 Pakai: /broadcast teks pesan kamu')));

bot.command('broadcast', async (ctx) => {
  if (roleOf(ctx.from.id) !== 'owner') return ctx.reply(WARN_OWNER, { parse_mode: 'HTML' });
  const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();
  if (!text) return ctx.reply('Pakai: /broadcast teks pesan');
  const ids = Object.values(db.d.users).filter((u) => u.verified).map((u) => u.id);
  await ctx.reply(`📣 Mengirim ke ${ids.length} user...`);
  let ok = 0;
  for (const id of ids) { try { await bot.telegram.sendMessage(id, `📣 <b>PENGUMUMAN</b>\n\n${esc(text)}`, { parse_mode: 'HTML' }); ok++; } catch {} await sleep(60); }
  return ctx.reply(`✅ Terkirim ${ok}/${ids.length}`);
});

// ---------- command role & credit ----------
const parseId = (s) => (/^\d{5,15}$/.test(s || '') ? Number(s) : null);
const tryDm = (id, text) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});

bot.command('addcredit', async (ctx) => {
  if (roleOf(ctx.from.id) === 'member') return ctx.reply(WARN_ABOVE_MEMBER, { parse_mode: 'HTML' });
  const [, idS, nS] = ctx.message.text.trim().split(/\s+/);
  const id = parseId(idS);
  if (!id) return ctx.reply('Pakai: /addcredit <ID user Telegram> [jumlah]\nContoh: /addcredit 123456789 10');
  let n = nS === undefined ? cfg.defaultAddCredit : Number(nS);
  if (!Number.isInteger(n) || n < 1) return ctx.reply('❌ Jumlah credit harus angka bulat ≥ 1.');
  if (roleOf(ctx.from.id) === 'reseller' && n > cfg.resellerMaxPerCommand) return ctx.reply(`❌ Reseller maksimal ${cfg.resellerMaxPerCommand} credit per command.`);
  if (n > 100000) return ctx.reply('❌ Jumlah terlalu besar.');
  const total = db.addCredit(id, n);
  tryDm(id, `🎁 Kamu mendapat <b>+${n} credit</b> dari ${esc(ctx.from.first_name || 'admin')}.\n💳 Saldo sekarang: <b>${total}</b>`);
  return ctx.reply(`✅ Berhasil menambah <b>${n} credit</b> ke <code>${id}</code>.\nSaldo user: ${total}`, { parse_mode: 'HTML' });
});
bot.command('address', async (ctx) => {
  if (roleOf(ctx.from.id) !== 'owner') return ctx.reply(WARN_OWNER, { parse_mode: 'HTML' });
  const id = parseId(ctx.message.text.trim().split(/\s+/)[1]);
  if (!id) return ctx.reply('Pakai: /address <ID user Telegram>');
  if (roleOf(id) === 'owner') return ctx.reply('ℹ️ User itu sudah OWNER.');
  db.setRole(id, 'reseller');
  tryDm(id, '🎉 Selamat! Role kamu naik menjadi <b>💼 RESELLER</b>.\nBuild UNLIMITED + bisa /addcredit. Ketik /menu');
  return ctx.reply(`✅ <code>${id}</code> sekarang <b>RESELLER</b>.`, { parse_mode: 'HTML' });
});
bot.command('delreseller', async (ctx) => {
  if (roleOf(ctx.from.id) !== 'owner') return ctx.reply(WARN_OWNER, { parse_mode: 'HTML' });
  const id = parseId(ctx.message.text.trim().split(/\s+/)[1]);
  if (!id) return ctx.reply('Pakai: /delreseller <ID user Telegram>');
  if (roleOf(id) !== 'reseller') return ctx.reply('ℹ️ User itu bukan reseller.');
  db.setRole(id, 'member');
  return ctx.reply(`✅ <code>${id}</code> dikembalikan menjadi MEMBER.`, { parse_mode: 'HTML' });
});
bot.command('addowner', async (ctx) => {
  if (roleOf(ctx.from.id) !== 'owner') return ctx.reply(WARN_OWNER, { parse_mode: 'HTML' });
  const id = parseId(ctx.message.text.trim().split(/\s+/)[1]);
  if (!id) return ctx.reply('Pakai: /addowner <ID user Telegram>');
  db.setRole(id, 'owner');
  tryDm(id, '👑 Kamu sekarang <b>OWNER</b> bot ini. Ketik /menu');
  return ctx.reply(`✅ <code>${id}</code> sekarang <b>OWNER</b>.\n<i>Catatan: maintenance tetap hanya untuk ID di telegram.js.</i>`, { parse_mode: 'HTML' });
});

bot.catch((e, ctx) => console.error(`[bot error] ${ctx?.updateType}:`, e.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// ---------- start ----------
(async () => {
  // pulihkan credit job yang terputus karena restart/crash
  const stale = Object.keys(db.d.active);
  for (const id of stale) {
    const uid = db.d.active[id].userId;
    if (db.refund(id)) tryDm(uid, '♻️ Bot sempat restart saat build kamu berjalan. <b>Credit sudah dikembalikan</b>, silakan build ulang.');
  }
  try { console.log('[GitHub] build.yml', await gh.ensureWorkflow()); }
  catch (e) { console.error('[GitHub] ❌', e.message); }
  const sweepOld = () => gh.sweep(cfg.retainHours, builder.activeTags()).catch((e) => console.error('[sweep]', e.message));
  sweepOld(); setInterval(sweepOld, 3600e3);
  setInterval(() => { for (const [k, v] of pending) if (Date.now() - v.at > 600000) pending.delete(k); }, 60e3);

  bot.launch({ dropPendingUpdates: true }, () => console.log('✅ Bot aktif sebagai @' + bot.botInfo.username)).catch((e) => { console.error('❌ Gagal start bot:', e.message); process.exit(1); });
})();

let stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(`\n${sig}: menghentikan bot...`);
  builder.abortAll('shutdown');
  await sleep(2500);
  db.flush();
  try { bot.stop(sig); } catch {}
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
