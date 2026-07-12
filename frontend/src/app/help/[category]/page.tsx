// Server wrapper: static export (prod) requires generateStaticParams for the
// dynamic segment; content is finite, so every category page is pre-rendered.
import { HELP_CATEGORIES } from "../content";
import { CategoryClient } from "./CategoryClient";

export function generateStaticParams() {
  return HELP_CATEGORIES.map((c) => ({ category: c.slug }));
}

export default function HelpCategoryPage() {
  return <CategoryClient />;
}
