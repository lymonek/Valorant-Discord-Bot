// Discord Valorant Profile Bot — Enhanced
// Single-file example using discord.js v14 and Riot Games Public API (Valorant)
// New features added:
//  ✅ In-memory cache with TTL + simple rate limiting for Riot API calls
//  ✅ Rich profile embeds with icons (agents, maps) from valorant-api.com
//  ✅ Extra commands: /lastmatch, /agent-stats, /map-stats
//  ✅ Multi-shard / multi-region support with /setshard and /setregion
//  ✅ Optional game mode filtering via options (queues)
//
// Prerequisites (Node 18+):
//   npm i discord.js dotenv
// .env:
//   DISCORD_TOKEN=...
//   DISCORD_CLIENT_ID=...
//   GUILD_ID=...                         # optional (guild-scoped commands)
//   RIOT_API_KEY=...
//   RIOT_REGION=europe                   # americas | europe | asia (Account routing)
//   VAL_SHARD=eu                         # eu | na | ap | kr | latam | br (Match routing)
//
// IMPORTANT: Riot's Valorant public API is limited. No live MMR endpoint.
//
// -------------------------------------------------------------
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  SlashCommandStringOption,
  SlashCommandUserOption,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  userMention,
} from 'discord.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ===================== Config =====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const RIOT_API_KEY = process.env.RIOT_API_KEY;
let RIOT_REGION = process.env.RIOT_REGION || 'europe'; // account routing
let VAL_SHARD = process.env.VAL_SHARD || 'eu';          // match routing

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !RIOT_API_KEY) {
  console.error('Missing env vars. Please set DISCORD_TOKEN, DISCORD_CLIENT_ID, RIOT_API_KEY.');
  process.exit(1);
}

// ===================== Persistence (JSON) =====================
const DB_PATH = './links.json';
function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJson(path, data) {
  try { writeFileSync(path, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('Save error', e); }
}
let LINKS = loadJson(DB_PATH, {}); // { [discordUserId]: { gameName, tagLine, shard?, region?, lastLinkedAt } }

// ===================== Simple cache + rate limit =====================
class TTLCache {
  constructor() { this.map = new Map(); }
  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    if (Date.now() > v.expires) { this.map.delete(key); return null; }
    return v.value;
  }
  set(key, value, ttlMs = 60_000) { this.map.set(key, { value, expires: Date.now() + ttlMs }); }
}
const cache = new TTLCache();

// Very simple token bucket: X requests per interval for the whole bot
const RATE_LIMIT = { capacity: 20, refillMs: 10_000 }; // ~20 req / 10s (tune to your key)
let tokens = RATE_LIMIT.capacity; let lastRefill = Date.now();
async function takeToken() {
  const now = Date.now();
  const delta = now - lastRefill;
  if (delta > RATE_LIMIT.refillMs) {
    tokens = RATE_LIMIT.capacity; lastRefill = now;
  }
  if (tokens <= 0) { await new Promise(r => setTimeout(r, 500)); return takeToken(); }
  tokens -= 1;
}

// ===================== Riot & Static APIs =====================
function riotBases(region = RIOT_REGION, shard = VAL_SHARD) {
  return {
    account: `https://${region}.api.riotgames.com/riot/account/v1`,
    match: `https://${shard}.api.riotgames.com/val/match/v1`,
  };
}

async function riotRequest(url, init = {}, retry = 2) {
  await takeToken();
  const headers = { 'X-Riot-Token': RIOT_API_KEY, 'Accept': 'application/json', ...init.headers };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 429 && retry > 0) {
    const retryAfter = Number(res.headers.get('Retry-After') || 1) * 1000;
    await new Promise(r => setTimeout(r, retryAfter));
    return riotRequest(url, init, retry - 1);
  }
  if (!res.ok) { throw new Error(`Riot ${res.status}: ${await res.text().catch(()=>'')}`); }
  return res.json();
}

function parseRiotId(input) {
  const idx = input.lastIndexOf('#');
  if (idx === -1) throw new Error('Niepoprawny format Riot ID. Użyj np. "Nick#TAG"');
  const gameName = input.slice(0, idx).trim();
  const tagLine = input.slice(idx + 1).trim();
  if (!gameName || !tagLine) throw new Error('Niepoprawny format Riot ID.');
  return { gameName, tagLine };
}

async function getAccountByRiotId(gameName, tagLine, region) {
  const { account } = riotBases(region);
  const url = `${account}/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  return riotRequest(url);
}

async function getRecentMatchIdsByPuuid(puuid, shard, start = 0, count = 5) {
  const { match } = riotBases(undefined, shard);
  const key = `matchlist:${shard}:${puuid}`;
  const cached = cache.get(key);
  if (cached) return cached.history.slice(start, start + count).map(h => h.matchId);
  const data = await riotRequest(`${match}/matchlists/by-puuid/${puuid}`);
  cache.set(key, data, 30_000); // 30s
  return (data?.history || []).slice(start, start + count).map(h => h.matchId);
}

async function getMatch(matchId, shard) {
  const { match } = riotBases(undefined, shard);
  const key = `match:${shard}:${matchId}`;
  const c = cache.get(key);
  if (c) return c;
  const data = await riotRequest(`${match}/matches/${matchId}`);
  cache.set(key, data, 60_000);
  return data;
}

// ----- Static (valorant-api.com) -----
const VAL_STATIC_BASE = 'https://valorant-api.com/v1';
async function getAgents() {
  const key = 'static:agents'; const c = cache.get(key); if (c) return c;
  const res = await fetch(`${VAL_STATIC_BASE}/agents?isPlayableCharacter=true`);
  if (!res.ok) throw new Error('VAL static agents failed');
  const data = await res.json();
  const byName = new Map();
  for (const a of data.data || []) { byName.set(a.displayName.toLowerCase(), a); }
  cache.set(key, byName, 3_600_000); // 1h
  return byName;
}
async function getMaps() {
  const key = 'static:maps'; const c = cache.get(key); if (c) return c;
  const res = await fetch(`${VAL_STATIC_BASE}/maps`);
  if (!res.ok) throw new Error('VAL static maps failed');
  const data = await res.json();
  const byUrlTail = new Map();
  for (const m of data.data || []) {
    const tail = (m.mapUrl || '').split('/').pop();
    byUrlTail.set(String(tail).toLowerCase(), m);
  }
  cache.set(key, byUrlTail, 3_600_000);
  return byUrlTail;
}

// ===================== Aggregation helpers =====================
function aggregateRecentStats(puuid, matches, modeFilter) {
  let k=0,d=0,a=0,wins=0,total=0; const perAgent=new Map(); const perMap=new Map();
  for (const m of matches) {
    const mode = m.matchInfo?.gameMode || 'unknown';
    if (modeFilter && mode !== modeFilter) continue;
    const player = m.players?.find(p => p.puuid === puuid);
    if (!player?.stats) continue;
    const team = player.teamId; const won = m.teams?.find(t => t.teamId === team)?.won;
    if (won) wins++; total++;
    k += player.stats.kills||0; d += player.stats.deaths||0; a += player.stats.assists||0;
    const ag = (player.characterId || 'unknown').toLowerCase();
    const map = (m.matchInfo?.mapId?.split('/')?.pop() || 'map').toLowerCase();
    perAgent.set(ag, (perAgent.get(ag)||0)+1);
    perMap.set(map, (perMap.get(map)||0)+1);
  }
  const kd = d>0 ? (k/d).toFixed(2) : '∞';
  return { k,d,a,wins,total,kd, perAgent, perMap };
}

function formatDuration(ms){ const s=Math.floor(ms/1000); const m=Math.floor(s/60); const sec=s%60; return `${m}m ${sec}s`; }

function resolveModeName(raw){
  const map = { competitive:'Competitive', unrated:'Unrated', spikerush:'Spike Rush', deathmatch:'Deathmatch', swiftplay:'Swiftplay', escalation:'Escalation', replication:'Replication' };
  return map[raw]||raw||'—';
}

// ===================== Embeds =====================
async function buildProfileEmbed({ account, summary, matches, targetUser, shard }){
  const agents = await getAgents();
  const maps = await getMaps();
  const e = new EmbedBuilder()
    .setTitle(`Valorant — ${account.gameName}#${account.tagLine}`)
    .setDescription(`Podsumowanie (${summary.total} gier${summary.total?` • wygrane: ${summary.wins}`:''}) dla ${targetUser}`)
    .addFields(
      { name: 'K/D/A', value: `${summary.k}/${summary.d}/${summary.a} (K/D ${summary.kd})`, inline: true },
      { name: 'Shard', value: shard, inline: true },
    )
    .setFooter({ text: 'Źródło: Riot Games API • Ikony: valorant-api.com' })
    .setTimestamp(Date.now());

  const lines = [];
  for (const m of matches.slice(0,5)){
    const start = new Date(m.matchInfo?.gameStartMillis||0);
    const mode = resolveModeName(m.matchInfo?.gameMode);
    const mapTail = (m.matchInfo?.mapId?.split('/')?.pop()||'mapa').toLowerCase();
    const mapMeta = maps.get(mapTail);
    const mapName = mapMeta?.displayName || mapTail;
    const dur = m.matchInfo?.gameLengthMillis?formatDuration(m.matchInfo.gameLengthMillis):'—';
    const player = m.players?.find(p=>p.puuid===account.puuid);
    const stats = player?.stats||{}; const team=player?.teamId||'—';
    const won = m.teams?.find(t=>t.teamId===team)?.won ? 'WIN' : 'LOSS';
    const agentUuid = (player?.characterId||'').toLowerCase();
    let agentName='—';
    for (const [,a] of agents){ if ((a.uuid||'').toLowerCase()===agentUuid) { agentName=a.displayName; break; } }
    lines.push(`• ${start.toLocaleDateString()} • ${mode} • ${mapName} • ${agentName} • ${won} • ${stats.kills??0}/${stats.deaths??0}/${stats.assists??0} • ${dur}`);
  }
  if (lines.length) e.addFields({ name:'Ostatnie mecze', value: lines.join('
') });
  return e;
}

async function buildLastMatchEmbed({ account, match }){
  const agents = await getAgents(); const maps = await getMaps();
  const e = new EmbedBuilder().setTitle(`Ostatni mecz — ${account.gameName}#${account.tagLine}`).setTimestamp(Date.now());
  const info = match.matchInfo || {}; const start = new Date(info.gameStartMillis||0);
  const mapTail = (info.mapId?.split('/')?.pop()||'mapa').toLowerCase();
  const mapMeta = maps.get(mapTail); const mapName = mapMeta?.displayName || mapTail;
  e.addFields({ name:'Tryb', value: resolveModeName(info.gameMode), inline:true }, { name:'Mapa', value: mapName, inline:true }, { name:'Czas', value: formatDuration(info.gameLengthMillis||0), inline:true });
  const me = match.players?.find(p=>p.puuid===account.puuid);
  if (me){
    const agentUuid = (me.characterId||'').toLowerCase();
    let agentName='—', agentIcon=null; for (const [,a] of agents){ if ((a.uuid||'').toLowerCase()===agentUuid){ agentName=a.displayName; agentIcon=a.displayIcon; break; } }
    const team = me.teamId; const won = match.teams?.find(t=>t.teamId===team)?.won ? 'WIN' : 'LOSS';
    e.setDescription(`${start.toLocaleString()} • ${won}`)
     .addFields({ name:'Agent', value: agentName, inline:true }, { name:'K/D/A', value: `${me.stats.kills}/${me.stats.deaths}/${me.stats.assists}`, inline:true });
    if (agentIcon) e.setThumbnail(agentIcon);
  }
  if (mapMeta?.splash) e.setImage(mapMeta.splash);
  return e;
}

// ===================== Command builders =====================
const queueChoices = [
  { name:'(wszystkie)', value:'any' },
  { name:'competitive', value:'competitive' },
  { name:'unrated', value:'unrated' },
  { name:'swiftplay', value:'swiftplay' },
  { name:'spikerush', value:'spikerush' },
  { name:'deathmatch', value:'deathmatch' },
  { name:'escalation', value:'escalation' },
];

function addQueueOption(opt){
  opt.addStringOption(o=>{
    o.setName('queue').setDescription('Filtruj tryb gry').setRequired(false);
    for (const ch of queueChoices) o.addChoices({ name: ch.name, value: ch.value });
    return o;
  });
}

function trackerUrl(gameName, tagLine){
  const id = `${encodeURIComponent(gameName)}%23${encodeURIComponent(tagLine)}`;
  return `https://tracker.gg/valorant/profile/riot/${id}/overview`;}

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Połącz swój profil Discord z Riot ID (Valorant) — format: Nick#TAG')
    .addStringOption(o=>o.setName('riot_id').setDescription('np. TwojNick#EUW').setRequired(true))
    .addStringOption(o=>o.setName('shard').setDescription('eu | na | ap | kr | latam | br').setRequired(false))
    .addStringOption(o=>o.setName('region').setDescription('americas | europe | asia').setRequired(false)),

  new SlashCommandBuilder()
    .setName('dodaj')
    .setDescription('Alias dla /link — dodaj (powiąż) Nick#TAG')
    .addStringOption(o=>o.setName('riot_id').setDescription('np. TwojNick#EUW').setRequired(true))
    .addStringOption(o=>o.setName('shard').setDescription('eu | na | ap | kr | latam | br').setRequired(false))
    .addStringOption(o=>o.setName('region').setDescription('americas | europe | asia').setRequired(false)),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Usuń powiązanie z Riot ID'),

  new SlashCommandBuilder().setName('unlink').setDescription('Usuń powiązanie z Riot ID'),
  new SlashCommandBuilder().setName('me').setDescription('Pokaż, jakie Riot ID masz powiązane'),

  ((()=>{ const b=new SlashCommandBuilder().setName('profile').setDescription('Pokaż profil Valorant')
      .addUserOption(o=>o.setName('user').setDescription('Użytkownik Discord (opcjonalnie)'))
      .addStringOption(o=>o.setName('riot_id').setDescription('Jednorazowo: Nick#TAG (pomija powiązanie)').setRequired(false)); addQueueOption(b); return b; })(),

  // Polski alias
  (()=>{ const b=new SlashCommandBuilder().setName('profil').setDescription('Alias: pokaż profil Valorant')
      .addUserOption(o=>o.setName('user').setDescription('Użytkownik Discord (opcjonalnie)'))
      .addStringOption(o=>o.setName('riot_id').setDescription('Jednorazowo: Nick#TAG (pomija powiązanie)').setRequired(false)); addQueueOption(b); return b; })(),

  (()=>{ const b=new SlashCommandBuilder().setName('lastmatch').setDescription('Pokaż ostatni mecz').addUserOption(o=>o.setName('user').setDescription('Użytkownik Discord (opcjonalnie)')); return b; })(),

  (()=>{ const b=new SlashCommandBuilder().setName('agent-stats').setDescription('Zestawienie po agencie').addUserOption(o=>o.setName('user').setDescription('Użytkownik Discord (opcjonalnie)')).addStringOption(o=>o.setName('agent').setDescription('np. Jett, Sova').setRequired(false)); addQueueOption(b); return b; })(),

  (()=>{ const b=new SlashCommandBuilder().setName('map-stats').setDescription('Zestawienie po mapie').addUserOption(o=>o.setName('user').setDescription('Użytkownik Discord (opcjonalnie)')).addStringOption(o=>o.setName('map').setDescription('np. Ascent, Bind').setRequired(false)); addQueueOption(b); return b; })(),

  new SlashCommandBuilder().setName('setshard').setDescription('Ustaw domyślny shard VAL dla siebie').addStringOption(o=>o.setName('shard').setDescription('eu | na | ap | kr | latam | br').setRequired(true)),
  new SlashCommandBuilder().setName('setregion').setDescription('Ustaw domyślny region account dla siebie').addStringOption(o=>o.setName('region').setDescription('americas | europe | asia').setRequired(true)),
].map(c=>c.toJSON());

async function registerCommands(){
  const rest=new REST({version:'10'}).setToken(DISCORD_TOKEN);
  if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
  else await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
}

// ===================== Bot =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', ()=> console.log(`Logged in as ${client.user.tag}`));

function userLink(userId){ return LINKS[userId]; }
function effectiveShard(link){ return link?.shard || VAL_SHARD; }
function effectiveRegion(link){ return link?.region || RIOT_REGION; }

client.on('interactionCreate', async (interaction)=>{
  try{
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName==='link' || interaction.commandName==='dodaj'){
      const riotIdRaw = interaction.options.getString('riot_id', true);
      const shard = interaction.options.getString('shard');
      const region = interaction.options.getString('region');
      await interaction.deferReply({ ephemeral: true });
      try{
        const { gameName, tagLine } = parseRiotId(riotIdRaw);
        const account = await getAccountByRiotId(gameName, tagLine, region||effectiveRegion());
        LINKS[interaction.user.id] = { gameName: account.gameName, tagLine: account.tagLine, lastLinkedAt: Date.now(), shard: shard||effectiveShard(), region: region||effectiveRegion() };
        saveJson(DB_PATH, LINKS);
        const url = trackerUrl(account.gameName, account.tagLine);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Otwórz w Tracker.gg').setStyle(ButtonStyle.Link).setURL(url));
        await interaction.editReply({ content:`Powiązano z **${account.gameName}#${account.tagLine}** (${shard||effectiveShard()} / ${region||effectiveRegion()}).`, components:[row] });
      }catch(e){ await interaction.editReply(`Nie udało się powiązać: ${e.message}`); }
      return;
    }

    if (interaction.commandName==='unlink'){
      const existed = !!LINKS[interaction.user.id];
      delete LINKS[interaction.user.id]; saveJson(DB_PATH, LINKS);
      await interaction.reply({ content: existed?'Usunięto powiązanie.':'Nie było żadnego powiązania.', ephemeral:true });
      return;
    }

    if (interaction.commandName==='me'){
      const link = userLink(interaction.user.id);
      if (!link) return interaction.reply({ content:'Brak powiązanego Riot ID. Użyj /link Nick#TAG', ephemeral:true });
      await interaction.reply({ content:`Masz powiązane: **${link.gameName}#${link.tagLine}** • shard: ${effectiveShard(link)} • region: ${effectiveRegion(link)}`, ephemeral:true });
      return;
    }

    if (interaction.commandName==='setshard'){
      const shard = interaction.options.getString('shard', true);
      LINKS[interaction.user.id] = LINKS[interaction.user.id] || {};
      LINKS[interaction.user.id].shard = shard; saveJson(DB_PATH, LINKS);
      await interaction.reply({ content:`Ustawiono shard na **${shard}**.`, ephemeral:true });
      return;
    }

    if (interaction.commandName==='setregion'){
      const region = interaction.options.getString('region', true);
      LINKS[interaction.user.id] = LINKS[interaction.user.id] || {};
      LINKS[interaction.user.id].region = region; saveJson(DB_PATH, LINKS);
      await interaction.reply({ content:`Ustawiono region na **${region}**.`, ephemeral:true });
      return;
    }

    // Helpers for commands below
    async function ensureLink(target){
      const link = userLink(target.id);
      if (!link){
        const msg = target.id===interaction.user.id ? 'Nie masz powiązanego Riot ID. Użyj /link Nick#TAG' : `${userMention(target.id)} nie ma powiązanego Riot ID.`;
        await interaction.reply({ content: msg, ephemeral: true });
        return null;
      }
      return link;
    }

    if (interaction.commandName==='profile' || interaction.commandName==='profil'){
      const target = interaction.options.getUser('user') || interaction.user;
      const queue = interaction.options.getString('queue');
      const riotIdInline = interaction.options.getString('riot_id');
      await interaction.deferReply();
      try{
        let account, shardToUse, regionToUse;
        if (riotIdInline){
          // One-off lookup without saving link
          const { gameName, tagLine } = parseRiotId(riotIdInline);
          regionToUse = effectiveRegion(userLink(target.id)) || effectiveRegion();
          shardToUse = effectiveShard(userLink(target.id)) || effectiveShard();
          account = await getAccountByRiotId(gameName, tagLine, regionToUse);
        } else {
          const link = await ensureLink(target); if (!link) return;
          regionToUse = effectiveRegion(link); shardToUse = effectiveShard(link);
          account = await getAccountByRiotId(link.gameName, link.tagLine, regionToUse);
        }
        const matchIds = await getRecentMatchIdsByPuuid(account.puuid, shardToUse, 0, 10);
        const matches = [];
        for (const id of matchIds){ try{ const m = await getMatch(id, shardToUse); matches.push(m); }catch(e){} }
        const modeFilter = (!queue || queue==='any') ? null : queue;
        const summary = aggregateRecentStats(account.puuid, matches, modeFilter);
        const embed = await buildProfileEmbed({ account, summary, matches, targetUser: userMention(target.id), shard: shardToUse });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Tracker.gg profil').setStyle(ButtonStyle.Link).setURL(trackerUrl(account.gameName, account.tagLine)));
        await interaction.editReply({ embeds:[embed], components:[row] });
      }catch(e){ await interaction.editReply(`Błąd: ${e.message}`); }
      return;
    }

    if (interaction.commandName==='lastmatch'){
      const target = interaction.options.getUser('user') || interaction.user;
      const link = await ensureLink(target); if (!link) return;
      await interaction.deferReply();
      try{
        const account = await getAccountByRiotId(link.gameName, link.tagLine, effectiveRegion(link));
        const [lastId] = await getRecentMatchIdsByPuuid(account.puuid, effectiveShard(link), 0, 1);
        if (!lastId) return interaction.editReply('Brak meczów.');
        const match = await getMatch(lastId, effectiveShard(link));
        const embed = await buildLastMatchEmbed({ account, match });
        await interaction.editReply({ embeds:[embed] });
      }catch(e){ await interaction.editReply(`Błąd: ${e.message}`); }
      return;
    }

    if (interaction.commandName==='agent-stats'){
      const target = interaction.options.getUser('user') || interaction.user;
      const queue = interaction.options.getString('queue');
      const agentQuery = (interaction.options.getString('agent')||'').toLowerCase();
      const link = await ensureLink(target); if (!link) return;
      await interaction.deferReply();
      try{
        const agents = await getAgents();
        let agentUuidFilter = null, agentDisplay = null;
        if (agentQuery){
          for (const [,a] of agents){ if (a.displayName.toLowerCase()===agentQuery){ agentUuidFilter=(a.uuid||'').toLowerCase(); agentDisplay=a.displayName; break; } }
          if (!agentUuidFilter) return interaction.editReply('Nie znam takiego agenta.');
        }
        const account = await getAccountByRiotId(link.gameName, link.tagLine, effectiveRegion(link));
        const matchIds = await getRecentMatchIdsByPuuid(account.puuid, effectiveShard(link), 0, 20);
        const matches = [];
        for (const id of matchIds){ try{ const m=await getMatch(id, effectiveShard(link)); matches.push(m); }catch(e){} }
        const modeFilter = (!queue || queue==='any') ? null : queue;

        // Aggregate per agent
        const tally = {};
        for (const m of matches){
          const mode = m.matchInfo?.gameMode; if (modeFilter && mode!==modeFilter) continue;
          const me = m.players?.find(p=>p.puuid===account.puuid); if (!me?.stats) continue;
          const agUuid = (me.characterId||'').toLowerCase();
          if (agentUuidFilter && agUuid!==agentUuidFilter) continue;
          const team = me.teamId; const won = m.teams?.find(t=>t.teamId===team)?.won;
          const key = agUuid||'unknown';
          tally[key] = tally[key]||{ games:0, wins:0, k:0,d:0,a:0 };
          tally[key].games++; if (won) tally[key].wins++; tally[key].k+=me.stats.kills; tally[key].d+=me.stats.deaths; tally[key].a+=me.stats.assists;
        }
        if (!Object.keys(tally).length) return interaction.editReply('Brak danych dla tego filtra.');
        // Pick best or specific
        const list = Object.entries(tally).map(([uuid,v])=>{
          const meta = [...agents.values()].find(a=>(a.uuid||'').toLowerCase()===uuid);
          const name = meta?.displayName||'—'; const icon = meta?.displayIcon;
          const kd = v.d>0 ? (v.k/v.d).toFixed(2) : '∞'; const wr = ((v.wins/v.games)*100).toFixed(0)+'%';
          return { uuid, name, icon, ...v, kd, wr };
        }).sort((a,b)=> b.games-a.games);

        const title = agentDisplay ? `Agent: ${agentDisplay}` : 'Top agenci';
        const e = new EmbedBuilder().setTitle(`Agent stats — ${account.gameName}#${account.tagLine}`).setDescription(title).setTimestamp(Date.now());
        const lines = list.slice(0,5).map(x=>`• ${x.name}: ${x.games} gier • wygrane ${x.wins} • WR ${x.wr} • K/D ${x.kd}`);
        e.addFields({ name:'Zestawienie', value: lines.join('
') });
        if (list[0]?.icon) e.setThumbnail(list[0].icon);
        await interaction.editReply({ embeds:[e] });
      }catch(e){ await interaction.editReply(`Błąd: ${e.message}`); }
      return;
    }

    if (interaction.commandName==='map-stats'){
      const target = interaction.options.getUser('user') || interaction.user;
      const queue = interaction.options.getString('queue');
      const mapQuery = (interaction.options.getString('map')||'').toLowerCase();
      const link = await ensureLink(target); if (!link) return;
      await interaction.deferReply();
      try{
        const maps = await getMaps();
        let mapTailFilter=null, mapDisplay=null, mapSplash=null;
        if (mapQuery){
          for (const [,m] of maps){ if ((m.displayName||'').toLowerCase()===mapQuery){ mapTailFilter=(m.mapUrl||'').split('/').pop().toLowerCase(); mapDisplay=m.displayName; mapSplash=m.splash; break; } }
          if (!mapTailFilter) return interaction.editReply('Nie znam takiej mapy.');
        }
        const account = await getAccountByRiotId(link.gameName, link.tagLine, effectiveRegion(link));
        const matchIds = await getRecentMatchIdsByPuuid(account.puuid, effectiveShard(link), 0, 20);
        const matches = [];
        for (const id of matchIds){ try{ const m=await getMatch(id, effectiveShard(link)); matches.push(m); }catch(e){} }
        const modeFilter = (!queue || queue==='any') ? null : queue;

        const tally = {};
        for (const m of matches){
          const mode = m.matchInfo?.gameMode; if (modeFilter && mode!==modeFilter) continue;
          const tail = (m.matchInfo?.mapId?.split('/')?.pop()||'map').toLowerCase();
          if (mapTailFilter && tail!==mapTailFilter) continue;
          const me = m.players?.find(p=>p.puuid===account.puuid); if (!me?.stats) continue;
          const team = me.teamId; const won = m.teams?.find(t=>t.teamId===team)?.won;
          const key = tail; tally[key]=tally[key]||{ games:0, wins:0, k:0,d:0,a:0 };
          tally[key].games++; if (won) tally[key].wins++; tally[key].k+=me.stats.kills; tally[key].d+=me.stats.deaths; tally[key].a+=me.stats.assists;
        }
        if (!Object.keys(tally).length) return interaction.editReply('Brak danych dla tego filtra.');

        const list = Object.entries(tally).map(([tail,v])=>{
          const meta = maps.get(tail); const name = meta?.displayName||tail; const splash=meta?.splash; const kd=v.d>0?(v.k/v.d).toFixed(2):'∞'; const wr=((v.wins/v.games)*100).toFixed(0)+'%';
          return { tail, name, splash, ...v, kd, wr };
        }).sort((a,b)=> b.games-a.games);

        const title = mapDisplay ? `Mapa: ${mapDisplay}` : 'Top mapy';
        const e = new EmbedBuilder().setTitle(`Map stats — ${account.gameName}#${account.tagLine}`).setDescription(title).setTimestamp(Date.now());
        const lines = list.slice(0,5).map(x=>`• ${x.name}: ${x.games} gier • wygrane ${x.wins} • WR ${x.wr} • K/D ${x.kd}`);
        e.addFields({ name:'Zestawienie', value: lines.join('
') });
        if (list[0]?.splash) e.setImage(list[0].splash);
        await interaction.editReply({ embeds:[e] });
      }catch(e){ await interaction.editReply(`Błąd: ${e.message}`); }
      return;
    }

  }catch(err){ console.error('Handler error:', err); }
});

// Bootstrap
registerCommands().then(()=> client.login(DISCORD_TOKEN)).catch(e=>{ console.error('Startup failed:', e); process.exit(1); });
