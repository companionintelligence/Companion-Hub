import clsx from 'clsx';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export const Markdown: React.FC<{ content: string; className: string }> = ({ content, className }) => (
  <div className={clsx('markdown prose prose-sm dark:prose-invert max-w-none', className)}>
    <ReactMarkdown
      remarkPlugins={[remarkBreaks, remarkGfm]}
      // ⚠ `rehypeRaw` parses HTML written inside the Markdown, and what it parses comes from app
      // descriptions in stores anyone can add and from release notes. Without `rehypeSanitize` after
      // it, an `<iframe srcdoc>`, a `<form>` or a full-page `<style>` overlay rendered live inside the
      // Hub's own origin. The sanitiser keeps the HTML a description legitimately uses (tables,
      // images, details) and drops the rest, and it must stay AFTER `rehypeRaw`: it can only clean
      // what has already been parsed.
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
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
