// Help Center content model. All copy is bilingual: [en, he].
// Bodies are markdown, rendered by src/components/Markdown.tsx.

export type L = [string, string]; // [en, he]

export interface HelpArticle {
  slug: string;
  title: L;
  excerpt: L;
  /** Extra search terms (both languages mixed, lowercase). */
  keywords: string[];
  body: L; // markdown
  popular?: boolean;
}

export interface HelpCategory {
  slug: string;
  icon: "rocket" | "chat" | "bot" | "plug" | "book" | "credit" | "users";
  title: L;
  desc: L;
  articles: HelpArticle[];
}

export interface HelpFaq {
  q: L;
  a: L; // markdown
}
