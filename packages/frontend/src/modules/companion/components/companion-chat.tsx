import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle, X, Send, Trash2, Loader2, Wrench, Bot, User } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import Markdown from 'react-markdown';
import clsx from 'clsx';

interface StreamEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'status' | 'done' | 'error';
  content?: string;
  toolCall?: { id: string; function: { name: string; arguments: string } };
  toolResult?: { callId: string; result: string };
  finishReason?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'status';
  content: string;
  timestamp: Date;
}

let msgCounter = 0;
const nextId = () => `msg-${Date.now()}-${++msgCounter}`;

export const CompanionChat = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message changes only
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Load history on first open
  // biome-ignore lint/correctness/useExhaustiveDependencies: only load once when opened
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      fetch('/api/companion/history', { credentials: 'include' })
        .then((r) => r.json())
        .then((data) => {
          if (data.messages?.length) {
            setMessages(
              data.messages
                .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
                .filter((m: { content: string }) => m.content?.trim())
                .map((m: { role: string; content: string }) => ({
                  id: nextId(),
                  role: m.role as 'user' | 'assistant',
                  content: m.content,
                  timestamp: new Date(),
                })),
            );
          }
        })
        .catch(() => {
          /* ignore */
        });
    }
  }, [isOpen]);

  // Keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput('');
    const userMsg: Message = { id: nextId(), role: 'user', content: text, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);

    try {
      const response = await fetch('/api/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: text }),
      });

      if (!response.ok) {
        setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: `Error: ${response.statusText}`, timestamp: new Date() }]);
        setIsStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';
      const assistantId = nextId();
      let hasStartedAssistant = false;
      let statusId: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const event: StreamEvent = JSON.parse(trimmed.slice(6));

            if (event.type === 'token' && event.content) {
              assistantContent += event.content;
              if (hasStartedAssistant) {
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: assistantContent } : m)));
              } else {
                hasStartedAssistant = true;
                // Remove status message if present
                setMessages((prev) => {
                  const filtered = statusId ? prev.filter((m) => m.id !== statusId) : prev;
                  return [...filtered, { id: assistantId, role: 'assistant', content: assistantContent, timestamp: new Date() }];
                });
                statusId = null;
              }
            } else if (event.type === 'status' && event.content) {
              const newStatusId = nextId();
              statusId = newStatusId;
              setMessages((prev) => [...prev, { id: newStatusId, role: 'status', content: event.content || '', timestamp: new Date() }]);
            } else if (event.type === 'tool_result') {
              // Remove status messages
              if (statusId) {
                setMessages((prev) => prev.filter((m) => m.id !== statusId));
                statusId = null;
              }
            } else if (event.type === 'error') {
              setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: `⚠️ ${event.content}`, timestamp: new Date() }]);
            }
          } catch {
            // skip malformed SSE
          }
        }
      }
    } catch (error) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: `⚠️ Connection error: ${String(error)}`, timestamp: new Date() }]);
    } finally {
      setIsStreaming(false);
    }
  };

  const clearHistory = async () => {
    await fetch('/api/companion/history', { method: 'DELETE', credentials: 'include' });
    setMessages([]);
  };

  return (
    <>
      {/* FAB */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={clsx(
          'fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:scale-105 hover:bg-primary/90',
          isOpen && 'pointer-events-none scale-0 opacity-0',
          !isOpen && 'scale-100 opacity-100',
        )}
        title="Open Companion (⌘K)"
      >
        <MessageCircle className="h-6 w-6" />
      </button>

      {/* Chat panel */}
      <div
        className={clsx(
          'fixed bottom-0 right-0 z-50 flex flex-col w-full sm:w-[420px] h-[70vh] sm:h-[600px] sm:bottom-6 sm:right-6 rounded-t-xl sm:rounded-xl border bg-background shadow-2xl transition-all duration-300 ease-out origin-bottom-right',
          isOpen ? 'scale-100 opacity-100 translate-y-0' : 'pointer-events-none scale-95 opacity-0 translate-y-4',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30 rounded-t-xl shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold text-sm">Companion</span>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={clearHistory} className="p-1.5 rounded-md hover:bg-muted transition-colors" title="Clear history">
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </button>
            <button type="button" onClick={() => setIsOpen(false)} className="p-1.5 rounded-md hover:bg-muted transition-colors" title="Close (⌘K)">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground px-6">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/5 mb-4">
                <Bot className="h-8 w-8 text-primary/40" />
              </div>
              <p className="text-sm font-medium mb-1">Your Companion</p>
              <p className="text-xs leading-relaxed">
                Ask me to find apps, check system health, or discover self-hosted alternatives to services you use.
              </p>
              <div className="flex flex-wrap gap-2 mt-4 justify-center">
                {['Find a photo app', 'Check disk space', 'Replace Google Docs'].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="text-xs px-3 py-1.5 rounded-full border bg-background hover:bg-muted transition-colors"
                    onClick={() => {
                      setInput(suggestion);
                      inputRef.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg) => {
            if (msg.role === 'status') {
              return (
                <div key={msg.id} className="flex justify-center animate-in fade-in duration-200">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded-full px-3 py-1">
                    <Wrench className="h-3 w-3 animate-spin" />
                    {msg.content}
                  </div>
                </div>
              );
            }

            const isUser = msg.role === 'user';

            return (
              <div key={msg.id} className={clsx('flex gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200', isUser && 'flex-row-reverse')}>
                <div className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full mt-0.5', isUser ? 'bg-primary' : 'bg-muted')}>
                  {isUser ? <User className="h-3.5 w-3.5 text-primary-foreground" /> : <Bot className="h-3.5 w-3.5 text-foreground/70" />}
                </div>
                <div
                  className={clsx(
                    'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                    isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
                  )}
                >
                  {isUser ? (
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  ) : (
                    <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
                      <Markdown>{msg.content}</Markdown>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {isStreaming && !messages.some((m) => m.role === 'assistant' && m.id === messages[messages.length - 1]?.id) && (
            <div className="flex gap-2 animate-in fade-in duration-200">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5">
                <Bot className="h-3.5 w-3.5 text-foreground/70" />
              </div>
              <div className="bg-muted rounded-2xl px-3.5 py-2.5">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-foreground/30 animate-bounce [animation-delay:0ms]" />
                  <span className="h-2 w-2 rounded-full bg-foreground/30 animate-bounce [animation-delay:150ms]" />
                  <span className="h-2 w-2 rounded-full bg-foreground/30 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t px-3 py-3 shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
            className="flex gap-2"
          >
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask your companion..."
              disabled={isStreaming}
              className="flex-1 text-sm rounded-full px-4"
            />
            <Button type="submit" size="icon" disabled={!input.trim() || isStreaming} className="shrink-0 rounded-full h-10 w-10">
              {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </form>
        </div>
      </div>
    </>
  );
};
