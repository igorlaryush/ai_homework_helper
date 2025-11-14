"use client";

import ReactMarkdown from "react-markdown";

import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { type FC, type PropsWithChildren, memo, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

// Normalize alternate LaTeX delimiters and whitespace around $$ blocks.
const normalizeCustomMathTags = (input: string): string => {
  if (!input) return input;
  let output = input.replace(/\r\n?/g, "\n");

  // Convert TeX \[...\] and \(...\) to remark-math forms
  output = output.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => `$$\n${inner}\n$$`);
  output = output.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => `$${inner}$`);

  // Clean standalone $$ lines
  output = output.replace(/^[ \t]*\$\$[ \t]*$/gm, "$$$$");

  // Collapse extra blank lines around $$ blocks to keep structure intact
  output = output.replace(/(^|\n)[ \t]*\n+[ \t]*(?=\$\$)/g, "$1"); // before
  output = output.replace(/(\$\$)[ \t]*\n[ \t]*\n+/g, "$1\n"); // after
  output = output.replace(/(^|\n)[ \t]*\n*[ \t]*(\$\$[\s\S]*?\$\$)[ \t]*\n*[ \t]*(?=\n|$)/g, "$1$2");

  // Left-align content inside $$ blocks to avoid ``` detection
  const lines = output.split("\n");
  const normalized: string[] = [];
  let insideBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "$$") {
      normalized.push("$$");
      insideBlock = !insideBlock;
      continue;
    }
    if (insideBlock) {
      normalized.push(line.replace(/^[\t ]+/, ""));
    } else {
      normalized.push(line);
    }
  }
  output = normalized.join("\n");

  // Final pass to collapse residual blank lines around $$ again
  output = output
    .replace(/(^|\n)[ \t]*\n+(?=\$\$)/g, "$1")
    .replace(/(\$\$)[ \t]*\n[ \t]*\n+/g, "$1\n");

  return output;
};

type MarkdownTextProps = PropsWithChildren<{ className?: string }>;

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ children, className }) => {
  const source =
    typeof children === "string"
      ? children
      : Array.isArray(children)
        ? children.join("")
        : String(children ?? "");

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      className={className ?? "aui-md"}
      components={defaultComponents}
    >
      {normalizeCustomMathTags(source)}
    </ReactMarkdown>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

type CodeHeaderProps = { language?: string; code?: string };
const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root flex items-center justify-between gap-4 rounded-t-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white dark:bg-violet-600">
      <span className="aui-code-header-language lowercase [&>span]:text-xs">
        {language}
      </span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy}>
        {!isCopied && <CopyIcon />}
        {isCopied && <CheckIcon />}
      </TooltipIconButton>
    </div>
  );
};

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;

    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

const defaultComponents = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 scroll-m-20 text-4xl font-extrabold tracking-tight",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 scroll-m-20 text-3xl font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 scroll-m-20 text-2xl font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 scroll-m-20 text-xl font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 text-lg font-semibold",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 font-semibold",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p leading-7",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a font-medium text-primary underline underline-offset-4",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn("aui-md-blockquote border-l-2 pl-6 italic", className)}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn("aui-md-ul ml-6 list-disc", className)}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn("aui-md-ol ml-6 list-decimal", className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("aui-md-hr border-b", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <table
      className={cn(
        "aui-md-table w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-4 py-2 text-left font-bold first:rounded-tl-lg last:rounded-tr-lg [&[align=center]]:text-center [&[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-b border-l px-4 py-2 text-left last:border-r [&[align=center]]:text-center [&[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
        className,
      )}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  code: function Code({
    inline,
    className,
    children,
    ...props
  }: {
    inline?: boolean;
    className?: string;
    children?: unknown;
  }) {
    const raw = Array.isArray(children) ? children.join("") : String(children ?? "");
    const language = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? undefined;

    if (!inline) {
      return (
        <div>
          <CodeHeader language={language} code={raw} />
          <pre
            className={cn(
              "aui-md-pre overflow-x-auto !rounded-t-none rounded-b-lg bg-black p-4 text-white",
              className,
            )}
          >
            <code className={className} {...props}>
              {raw}
            </code>
          </pre>
        </div>
      );
    }

    return (
      <code
        className={cn(
          "aui-md-inline-code rounded border bg-muted font-semibold",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
};
