import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle, X, Send, Trash2, Loader2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import clsx from 'clsx';

interface StreamEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'status' | 'done' | 'error';
  content?: string;
  toolCall?: { id: string; function: { name: string; arguments: string } };
  toolResult?: { callId: string; result: string };
  finishReason?: string;
}

interface Message {
  role: 'user' | 'assistant' | 'status';
  content: string;
}

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

  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Load history on open
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      fetch('/api/companion/history', { credentials: 'include' })
        .then((r) => r.json())
        .then((data) => {
          if (data.messages) {
            setMessages(
              data.messages
                .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
                .map((m: { role: string; content: string }) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
            );
          }
        })
        .catch(() => {
          /* ignore */
        });
    }
  }, [isOpen, messages.length]);

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
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setIsStreaming(true);

    try {
      const response = await fetch('/api/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: text }),
      });

      if (!response.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${response.statusText}` }]);
        setIsStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';
      let hasStartedAssistant = false;

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
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { role: 'assistant', content: assistantContent };
                  return updated;
                });
              } else {
                hasStartedAssistant = true;
                setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }]);
              }
            } else if (event.type === 'status' && event.content) {
              setMessages((prev) => [...prev, { role: 'status', content: event.content || '' }]);
            } else if (event.type === 'tool_result') {
              // Remove the status message for this tool call
              setMessages((prev) => prev.filter((m) => m.role !== 'status'));
            } else if (event.type === 'error') {
              setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${event.content}` }]);
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Connection error: ${error}` }]);
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
      {!isOpen && (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105"
          title="Open Companion (⌘K)"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}

      {/* Chat drawer */}
      {isOpen && (
        <div className="fixed bottom-0 right-0 z-50 flex flex-col w-full sm:w-[420px] h-[70vh] sm:h-[600px] sm:bottom-6 sm:right-6 rounded-t-xl sm:rounded-xl border bg-background shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30 rounded-t-xl">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-primary" />
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
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <MessageCircle className="h-12 w-12 mb-3 opacity-20" />
                <p className="text-sm font-medium">Ask me anything</p>
                <p className="text-xs mt-1">&quot;I want Microsoft Word&quot; · &quot;Check disk space&quot; · &quot;Find a photo app&quot;</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={`msg-${i}-${msg.role}`}
                className={clsx('flex', {
                  'justify-end': msg.role === 'user',
                  'justify-start': msg.role === 'assistant',
                  'justify-center': msg.role === 'status',
                })}
              >
                {msg.role === 'status' ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded-full px-3 py-1">
                    <Wrench className="h-3 w-3" />
                    {msg.content}
                  </div>
                ) : (
                  <div
                    className={clsx('max-w-[85%] rounded-xl px-3 py-2 text-sm', {
                      'bg-primary text-primary-foreground': msg.role === 'user',
                      'bg-muted': msg.role === 'assistant',
                    })}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  </div>
                )}
              </div>
            ))}
            {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-xl px-3 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t px-3 py-3">
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
                placeholder="Type a message..."
                disabled={isStreaming}
                className="flex-1 text-sm"
              />
              <Button type="submit" size="icon" disabled={!input.trim() || isStreaming} className="shrink-0">
                {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
