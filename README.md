# Valorant-Discord-Bot

# Valorant Discord Bot

A community-driven Discord bot that brings Valorant match statistics directly into Discord.

## ✨ Features
- **Link Riot ID to Discord** – `/link Nick#TAG` (or `/dodaj`)  
- **Check profile stats** – `/profile` (or `/profil`) shows recent matches, K/D/A, win rates  
- **One-time lookup** – `/profile riot_id: Nick#TAG` without linking  
- **Last match summary** – `/lastmatch`  
- **Agent-specific stats** – `/agent-stats`  
- **Map-specific stats** – `/map-stats`  
- **Region/shard settings** – `/setregion`, `/setshard`  
- Tracker.gg profile link embedded in results (no scraping, only a direct link)

All data is retrieved using the **official Riot Games API** (Account-V1 and Match-V1).  
Static assets like agent names and map images are fetched from [valorant-api.com](https://valorant-api.com/).

## ⚙️ Tech stack
- [Node.js](https://nodejs.org/) (v18+)  
- [discord.js](https://discord.js.org/)  
- Riot Games API (Account-V1, Match-V1)  
- Community Valorant API (for static assets)

## 🔑 Requirements
- A Discord bot token (from [Discord Developer Portal](https://discord.com/developers/applications))  
- A Riot Games API key (Development key for testing, Production key for 24/7 operation)  
- Node.js v18 or newer

## 🚀 Getting started
1. Clone this repository  
2. Run `npm install`  
3. Create a `.env` file:
   ```env
   DISCORD_TOKEN=your-discord-bot-token
   DISCORD_CLIENT_ID=your-application-id
   GUILD_ID=your-server-id
   RIOT_API_KEY=your-riot-api-key
   RIOT_REGION=europe
   VAL_SHARD=eu
