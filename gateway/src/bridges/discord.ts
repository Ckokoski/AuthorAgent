/**
 * AuthorAgent Discord Bridge (Stub)
 * Discord integration — similar structure to Telegram
 */

export class DiscordBridge {
  constructor(private token: string, private config: any) {}
  async connect(): Promise<void> {
    // Discord.js integration would go here
    console.log('  ℹ Discord bridge: requires discord.js — see docs/DISCORD-SETUP.md');
  }
  disconnect(): void {}
}
