import type { KnowledgeDocument } from '@/api/contracts/knowledge-candidates';

import styles from './WhatWillBeUsed.module.css';

/**
 * The document an approve writes, word for word (`knowledgeDocumentOf`) - shown
 * before the confirm, so what the AI will be given is read before it is. One
 * way to write knowledge, one look: 13f's decide and add, and 08's resolve.
 * Each paragraph finds its own direction: a Hebrew answer sits beside the
 * platform's English sentences.
 */
export function WhatWillBeUsed({
  document,
  testid,
}: {
  readonly document: KnowledgeDocument;
  readonly testid?: string;
}) {
  return (
    <blockquote className={styles.usedDoc} data-testid={testid}>
      {document.paragraphs.map((p, i) => (
        <p key={i} dir="auto" className={i === 0 ? styles.usedDocQuestion : styles.usedDocLine}>
          {p}
        </p>
      ))}
    </blockquote>
  );
}
