/** Shared structured article types used across HTML extraction and PDF typesetting. */

export type ArticleBlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'p'
  | 'li'
  | 'ol-li'
  | 'blockquote'
  | 'pre';

export interface ArticleBlock {
  type: ArticleBlockType;
  text: string;
  listIndex?: number;
}

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  siteName: string | null;
  sourceDomain: string;
  textContent: string;
  paragraphs: string[];
  blocks?: ArticleBlock[];
}
