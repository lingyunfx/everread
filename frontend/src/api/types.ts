// 与后端 OpenAPI（/api/v1/openapi.json）保持一致的类型定义

export type Theme = "light" | "dark" | "sepia";
export type PdfFilter = "none" | "sepia" | "dark";
export type PageLayout = "double" | "single";
export type BookFormat = "pdf" | "epub" | "txt";
export type BookStatus = "processing" | "ready" | "failed";
export type Visibility = "private" | "public";
export type ReadStatus = "unread" | "reading" | "finished";

export interface Preferences {
  theme: Theme;
  font_size: number;
  line_height: number;
  pdf_filter: PdfFilter;
  pdf_zoom: number;
  page_layout: PageLayout;
}

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
  must_change_password: boolean;
  preferences: Preferences;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  format: BookFormat;
  file_size: number;
  original_filename: string;
  visibility: Visibility;
  status: BookStatus;
  error: string | null;
  page_count: number | null;
  has_text_layer: boolean | null;
  has_cover: boolean;
  is_owner: boolean;
  is_deleted: boolean;
  created_at: string;
}

export interface TocEntry {
  level: number;
  title: string;
  page?: number;
  para?: number;
}

export interface BookDetail extends Book {
  meta: { toc?: TocEntry[]; encoding?: string; paragraphs?: number; chapters?: number };
  accessible: boolean;
}

export interface ShelfItem {
  book: Book;
  read_status: ReadStatus;
  on_shelf: boolean;
  added_at: string;
  last_read_at: string | null;
  percent: number | null;
  accessible: boolean;
  unavailable_reason: "deleted" | "private" | "failed" | "processing" | null;
}

export interface LibraryItem {
  book: Book;
  on_my_shelf: boolean;
}

// ---------- 位置 ----------
// 每个位置对象带 type（格式）与 v（结构版本）；书籍文件不可变，book_id 即文件版本

export interface PdfLocator {
  type: "pdf";
  v: 1;
  page: number; // 文件页序号，从 1 开始
  y?: number; // 页内纵向位置（0~1，按未旋转页面）
  rects?: number[][]; // 标注：PDF 坐标 [x1, y1, x2, y2]
}

export interface EpubLocator {
  type: "epub";
  v: 1;
  cfi: string;
  percent?: number;
}

export interface TxtPoint {
  para: number;
  offset: number; // Unicode 码点偏移
}

export interface TxtLocator {
  type: "txt";
  v: 1;
  para: number;
  offset: number;
  end?: TxtPoint; // 标注/搜索结果的结束位置
}

export type Locator = PdfLocator | EpubLocator | TxtLocator;

export interface Progress {
  locator: Locator;
  percent: number;
  revision: number;
  device: string | null;
  updated_at: string;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink";

export interface Annotation {
  id: string;
  book_id: string;
  locator: Locator;
  quote: string;
  color: HighlightColor;
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  book_id: string;
  annotation_id: string | null;
  locator: Locator | null;
  quote: string | null;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface Bookmark {
  id: string;
  book_id: string;
  locator: Locator;
  position_label: string;
  sort_key: number;
  name: string;
  memo: string;
  created_at: string;
}

export interface RecordHit {
  kind: "note" | "annotation";
  id: string;
  snippet: string;
  quote: string | null;
  locator: Locator | null;
  updated_at: string;
}
