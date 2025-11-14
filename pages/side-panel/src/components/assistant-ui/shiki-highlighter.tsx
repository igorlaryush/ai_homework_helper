import { useEffect, useMemo, useState } from 'react';
import type { FC, ReactNode } from 'react';
import { codeToHtml } from 'shiki';

type SyntaxHighlighterProps = {
	language?: string;
	children?: ReactNode;
	className?: string;
};

// Lightweight Shiki-based highlighter.
// Falls back to plain <pre><code> rendering if highlighting fails.
export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({ language, children, className }) => {
	const code = useMemo(() => {
		if (children == null) return '';
		if (typeof children === 'string') return children;
		// Flatten children to string if needed
		return String(
			(Array.isArray(children) ? children : [children])
				.map(chunk => (typeof chunk === 'string' ? chunk : ''))
				.join(''),
		);
	}, [children]);

	const lang = (language || '').trim() || 'text';
	const [html, setHtml] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		// Use a popular, readable theme; can be customized if desired
		codeToHtml(code, { lang, theme: 'github-dark' })
			.then(result => {
				if (!cancelled) setHtml(result);
			})
			.catch(() => {
				if (!cancelled) setHtml(null);
			});
		return () => {
			cancelled = true;
		};
	}, [code, lang]);

	if (!code) {
		return null;
	}

	if (html) {
		return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
	}

	return (
		<pre className={className}>
			<code className={`language-${lang}`}>{code}</code>
		</pre>
	);
};


