import type { KnowledgeDocument } from '@/api/contracts/knowledge-candidates';

import styles from './Channels.module.css';

/**
 * The document an approve writes, word for word (`knowledgeDocumentOf`) - shown
 * before the confirm, so what the AI will be given is read before it is.
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
