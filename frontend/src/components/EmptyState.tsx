"use client";

// Shared empty-state block: icon + reason + one clear next action.
// Replaces the hand-rolled per-page variants so Inbox, History and future
// lists explain WHY they are empty the same way.

import Link from "next/link";
import { ReactNode } from "react";

interface Action {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: Action;
  secondaryAction?: Action;
  tone?: "neutral" | "attention";
}

export function EmptyState({ icon, title, description, action, secondaryAction, tone = "neutral" }: EmptyStateProps) {
  return (
    <div className="px-6 py-12 text-center">
      <div
        className={
          "mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl " +
          (tone === "attention" ? "bg-amber-50" : "bg-gray-100")
        }
      >
        {icon || (
          <svg className={"h-7 w-7 " + (tone === "attention" ? "text-amber-400" : "text-gray-300")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
        )}
      </div>
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-gray-400">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-4 flex items-center justify-center gap-3">
          {action &&
            (action.href ? (
              <Link
                href={action.href}
                onClick={action.onClick}
                className={
                  "inline-flex items-center rounded-xl px-4 py-2 text-xs font-semibold text-white transition " +
                  (tone === "attention" ? "bg-amber-500 hover:bg-amber-600" : "bg-primary-500 hover:bg-primary-600")
                }
              >
                {action.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={action.onClick}
                className={
                  "inline-flex items-center rounded-xl px-4 py-2 text-xs font-semibold text-white transition " +
                  (tone === "attention" ? "bg-amber-500 hover:bg-amber-600" : "bg-primary-500 hover:bg-primary-600")
                }
              >
                {action.label}
              </button>
            ))}
          {secondaryAction &&
            (secondaryAction.href ? (
              <Link href={secondaryAction.href} onClick={secondaryAction.onClick} className="text-xs font-medium text-primary-600 hover:text-primary-700">
                {secondaryAction.label}
              </Link>
            ) : (
              <button type="button" onClick={secondaryAction.onClick} className="text-xs font-medium text-primary-600 hover:text-primary-700">
                {secondaryAction.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
