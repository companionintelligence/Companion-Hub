import clsx from 'clsx';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export const Markdown: React.FC<{ content: string; className: string }> = ({ content, className }) => (
  <div className={clsx('markdown', className)}>
    <ReactMarkdown
      remarkPlugins={[remarkBreaks, remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline decoration-primary/50 underline-offset-4 transition-colors hover:text-primary/80"
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);
