import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { ChatMessage } from '../providers/llm-provider.interface';
import { DatabaseService } from '@/core/database/database.service';
import { companionMessage } from '@/core/database/drizzle/schema';
import { eq, desc } from 'drizzle-orm';

@Injectable()
export class ConversationRepository {
  constructor(
    readonly _logger: LoggerService,
    private readonly db: DatabaseService,
  ) {}

  async saveMessage(userId: number, message: ChatMessage): Promise<void> {
    await this.db.db.insert(companionMessage).values({
      userId,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      toolCallId: message.toolCallId || null,
    });
  }

  async getHistory(userId: number, limit = 50): Promise<ChatMessage[]> {
    const rows = await this.db.db
      .select()
      .from(companionMessage)
      .where(eq(companionMessage.userId, userId))
      .orderBy(desc(companionMessage.createdAt))
      .limit(limit);

    return rows.reverse().map((row) => ({
      role: row.role as ChatMessage['role'],
      content: row.content,
      toolCalls: row.toolCalls ? JSON.parse(row.toolCalls) : undefined,
      toolCallId: row.toolCallId || undefined,
    }));
  }

  async clearHistory(userId: number): Promise<void> {
    await this.db.db.delete(companionMessage).where(eq(companionMessage.userId, userId));
  }

  async getMessageCount(userId: number): Promise<number> {
    const rows = await this.db.db.select().from(companionMessage).where(eq(companionMessage.userId, userId));
    return rows.length;
  }
}
