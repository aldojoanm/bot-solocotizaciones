// tg-cotizaciones.js — Bot de COTIZACIONES (Publicom / Eco Rural)
import 'dotenv/config';
import fs from 'fs';
import { Telegraf, Markup } from 'telegraf';

import { sendAutoQuotePDF } from './quote.js';         // Publicom (actual)
import { sendEcoRuralQuotePDF } from './quote-eco.js'; // Eco Rural (nuevo archivo)

// ====== ENV ======
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('Falta TELEGRAM_BOT_TOKEN en .env'); process.exit(1); }
const bot = new Telegraf(token);

// ====== Utils ======
const pad2 = n => String(n).padStart(2,'0');
const hoyBO = () => {
  const d = new Date();
  return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`;
};
const cleanName = (s='') => String(s)
  .normalize('NFD').replace(/\p{Diacritic}/gu,'')
  .replace(/[\\/:*?"<>|]+/g,'')
  .replace(/\s+/g,' ')
  .trim()
  .slice(0, 80);

// ====== Estado ======
/**
 * state por chatId:
 * {
 *   step: 'brand'|'plantilla'|null,
 *   brand: 'PUBLICOM'|'ECORURAL'|null
 * }
 */
const state = new Map();
const getS = (id) => state.get(id) || {};
const setS = (id, patch) => state.set(id, { ...getS(id), ...patch });
const clearS = (id) => state.delete(id);

// ====== UI ======
const brandMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🏢 PUBLICOM', 'brand:PUBLICOM'), Markup.button.callback('🌿 ECO RURAL', 'brand:ECORURAL')]
]);

const afterCotizacionMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🧾 COTIZAR NUEVAMENTE', 'cotizar_nuevo'), Markup.button.callback('✅ FINALIZAR', 'finalizar')]
]);

const introCampos = () => 'Por favor rellena estos campos y envíame el texto completo 👇';
const plantillaCampos = () => (
`Empresa:
Fecha: ${hoyBO()}

Descripción:

Items:
2; Diseño de logo; 350
1 Mantenimiento mensual - Bs 300
5 Horas de soporte 100`
);

// ====== Parsers COTIZACIÓN ======
const RE_EMPRESA = /(?:^|\n)\s*(?:empresa|cliente)\s*:\s*([^\n]+)/i;
const RE_FECHA   = /(?:^|\n)\s*fecha\s*:\s*([^\n]+)/i;
const RE_DESC    = /(?:^|\n)\s*(?:desc|descripci[oó]n|concepto)\s*:\s*([\s\S]+?)(?=\n(?:items?|ítems?|total)\s*:|\s*$)/i;
const RE_TOTAL   = /(?:^|\n)\s*total\s*:\s*(?:bs\.?\s*)?([0-9]+(?:[.,][0-9]{1,2})?)/i;

function parseItems(block='') {
  const items = [];
  const lines = String(block).split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    let m;
    m = line.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s*;\s*(.+?)\s*;\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*$/);
    if (m) { items.push({ qty:+m[1].replace(',','.'), detail:m[2].trim(), line:+m[3].replace(',','.') }); continue; }
    m = line.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:x|por)?\s*(.+?)\s*@\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*$/i);
    if (m) { items.push({ qty:+m[1].replace(',','.'), detail:m[2].trim(), line:+m[3].replace(',','.') }); continue; }
    m = line.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s+(.+?)\s*[-–]\s*bs?\.?\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*$/i);
    if (m) { items.push({ qty:+m[1].replace(',','.'), detail:m[2].trim(), line:+m[3].replace(',','.') }); continue; }
    m = line.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s+(.+?)\s+([0-9]+(?:[.,][0-9]{1,2})?)\s*$/);
    if (m) { items.push({ qty:+m[1].replace(',','.'), detail:m[2].trim(), line:+m[3].replace(',','.') }); continue; }
  }
  return items;
}

function parseQuoteText(text='') {
  const empresa = (text.match(RE_EMPRESA)?.[1] || '').trim();
  const fecha   = (text.match(RE_FECHA)?.[1] || '').trim();
  const desc    = (text.match(RE_DESC)?.[1] || '').trim();
  const totalIn = text.match(RE_TOTAL)?.[1];

  let itemsBlock = '';
  const idxItems = text.search(/(?:^|\n)\s*(items?|ítems?)\s*:/i);
  if (idxItems >= 0) itemsBlock = text.slice(idxItems).replace(/^[^\n]*:\s*/, '');
  else itemsBlock = text.replace(RE_EMPRESA,'').replace(RE_FECHA,'').replace(RE_DESC,'')
                        .replace(RE_TOTAL,'').trim();

  const items = parseItems(itemsBlock);
  const subtotal = items.reduce((a,b)=> a + b.line, 0);
  const total = totalIn ? +totalIn.replace(',','.') : subtotal;

  return { empresa, fecha: fecha || hoyBO(), descripcion: desc || '', items, subtotal, total };
}

function sessionFromParsed(telegramId, p){
  return {
    profileName: p.empresa || '',
    vars: {
      cart: p.items.map(it => ({
        nombre: it.detail,
        cantidad: it.qty,
        subtotal_bs: it.line
      }))
    },
    meta: { origin: 'telegram', chatId: telegramId },
    note: { fecha: p.fecha, descripcion: p.descripcion, total_bob: p.total }
  };
}

// ====== Flujo ======
async function sendWelcome(ctx){
  await ctx.reply('👋 Bot de *COTIZACIONES*. Elige la empresa:', { parse_mode:'Markdown', ...brandMenu() });
}

bot.start(async (ctx) => {
  clearS(ctx.chat.id);
  setS(ctx.chat.id, { step:'brand' });
  await sendWelcome(ctx);
});

bot.action(/brand:(PUBLICOM|ECORURAL)/, async (ctx) => {
  await ctx.answerCbQuery();
  const brand = ctx.match[1];
  setS(ctx.chat.id, { step:'plantilla', brand });
  await ctx.reply(introCampos());
  await ctx.reply(plantillaCampos());
});

bot.action('cotizar_nuevo', async (ctx) => {
  await ctx.answerCbQuery();
  clearS(ctx.chat.id);
  setS(ctx.chat.id, { step:'brand' });
  await ctx.reply('Elige la empresa para la cotización:', brandMenu());
});

bot.action('finalizar', async (ctx) => {
  await ctx.answerCbQuery('¡Listo!');
  clearS(ctx.chat.id);
  await ctx.reply('Gracias por usar el bot de cotizaciones. 🙌 /start para comenzar de nuevo.');
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text || '';
  const st = getS(ctx.chat.id);

  if (!st.step) { await sendWelcome(ctx); return; }
  if (st.step !== 'plantilla' || !st.brand) {
    setS(ctx.chat.id, { step:'brand' });
    await ctx.reply('Elige la empresa para la cotización:', brandMenu());
    return;
  }

  const p = parseQuoteText(text);
  if (!p.items.length) {
    await ctx.reply(introCampos());
    await ctx.reply(plantillaCampos());
    return;
  }
  const s = sessionFromParsed(ctx.from.id, p);

  let buffer;
  try{
    const out = (st.brand === 'ECORURAL')
      ? await sendEcoRuralQuotePDF(ctx.from.id, s)
      : await sendAutoQuotePDF(ctx.from.id, s);

    if (typeof out === 'string') {
      buffer = fs.readFileSync(out);
      try { fs.unlinkSync(out); } catch {}
    } else if (Buffer.isBuffer(out)) {
      buffer = out;
    } else if (out?.path) {
      buffer = fs.readFileSync(out.path);
      try { fs.unlinkSync(out.path); } catch {}
    } else {
      throw new Error('No obtuve un PDF válido.');
    }
  }catch(err){
    console.error('PDF error:', err?.message || err);
    await ctx.reply('⚠️ No pude generar el PDF.');
    return;
  }

  const resumen = [
    `*Cotización de servicios* (${st.brand})`,
    `Empresa: ${p.empresa || '—'}`,
    `Fecha: ${p.fecha}`,
    p.descripcion ? `\nDescripción:\n${p.descripcion}` : null,
    `\nItems:`,
    ...p.items.map(it => `• ${it.qty} ${it.detail} — Bs ${it.line.toFixed(2)}`),
    `\nSubtotal: Bs ${p.subtotal.toFixed(2)}`,
    `Total: Bs ${p.total.toFixed(2)}`
  ].filter(Boolean).join('\n');
  await ctx.reply(resumen, { parse_mode: 'Markdown' });

  const empresaSafe = cleanName(p.empresa || 'Cliente');
  const descSafe    = cleanName(p.descripcion || '');
  const fileName    = `${st.brand} - ${empresaSafe}${descSafe ? ' - ' + descSafe : ''}.pdf`;

  await ctx.replyWithDocument({ source: buffer, filename: fileName });
  await ctx.reply('¿Deseas hacer otra acción?', afterCotizacionMenu());
});

bot.launch();
console.log('Bot de COTIZACIONES iniciado (long-polling).');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
