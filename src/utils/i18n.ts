export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

// BCP 47 tags for <html lang> and hreflang, and Open Graph's underscore form.
const LANGUAGE_TAGS: Record<Locale, string> = { en: "en-US", zh: "zh-CN" };
const OG_LOCALES: Record<Locale, string> = { en: "en_US", zh: "zh_CN" };
const LANGUAGE_NAMES: Record<Locale, string> = { en: "English", zh: "中文" };

export function getLocale(astro: { currentLocale?: string }): Locale {
	return (LOCALES as readonly string[]).includes(astro.currentLocale ?? "")
		? (astro.currentLocale as Locale)
		: DEFAULT_LOCALE;
}

/** Prefix a site path for a locale: ("zh", "/posts/x") → "/zh/posts/x". */
export function localizePath(locale: Locale, path: string): string {
	if (locale === DEFAULT_LOCALE) return path;
	return path === "/" ? `/${locale}` : `/${locale}${path}`;
}

/** Remove a locale prefix: "/zh/posts/x" → "/posts/x". */
export function stripLocale(path: string): string {
	for (const locale of LOCALES) {
		if (locale === DEFAULT_LOCALE) continue;
		if (path === `/${locale}`) return "/";
		if (path.startsWith(`/${locale}/`)) return path.slice(locale.length + 1);
	}
	return path;
}

/** Language tag for <html lang> and hreflang, e.g. "zh-CN". */
export function htmlLang(locale: Locale): string {
	return LANGUAGE_TAGS[locale];
}

/** Open Graph locale, e.g. "zh_CN". */
export function ogLocale(locale: Locale): string {
	return OG_LOCALES[locale];
}

/**
 * EmDash stores content locales as "en"/"zh" and emits hreflang with those
 * codes; map them to the region-qualified tags the site uses.
 */
export function hreflangFor(code: string): string {
	return (LOCALES as readonly string[]).includes(code) ? LANGUAGE_TAGS[code as Locale] : code;
}

export function languageName(locale: Locale): string {
	return LANGUAGE_NAMES[locale];
}

export function formatDate(date: Date | null | undefined, locale: Locale, month: "long" | "short" = "long") {
	if (!date) return null;
	return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
		year: "numeric",
		month,
		day: "numeric",
	});
}

const STRINGS = {
	en: {
		latest: "Latest",
		viewAll: "View all",
		minRead: (n: number) => `${n} min read`,
		minutes: (n: number) => `${n} min`,
		allPosts: "All Posts",
		browseAllPosts: "Browse all posts",
		articles: (n: number) => `${n} ${n === 1 ? "article" : "articles"}`,
		noPosts: "No posts yet.",
		category: "Category",
		tag: "Tag",
		categoryTitle: (label: string) => `${label} posts`,
		categoryDescription: (label: string) => `All posts in ${label}`,
		tagTitle: (label: string) => `Posts tagged "${label}"`,
		tagDescription: (label: string) => `All posts tagged with ${label}`,
		noPostsInCategory: "No posts in this category yet.",
		noPostsWithTag: "No posts with this tag yet.",
		firstPage: "First page",
		nextPage: "Next page",
		olderPosts: "Older posts",
		author: "Author",
		authors: "Authors",
		published: "Published",
		readingTime: "Reading time",
		tags: "Tags",
		onThisPage: "On this page",
		continueReading: "Continue reading",
		search: "Search",
		searchPlaceholder: "Search...",
		searchPosts: "Search posts...",
		searchDescription: "Search posts",
		searchHint: "Enter a search term to find posts.",
		searchResults: (n: number, q: string) =>
			n === 0 ? `No results for "${q}"` : `${n} result${n === 1 ? "" : "s"} for "${q}"`,
		searchTitle: (q: string) => `Search: ${q}`,
		notFound: "Page not found",
		notFoundBody: "The page you're looking for doesn't exist.",
		goHome: "Go back home",
		navigate: "Navigate",
		connect: "Connect",
		rssFeed: "RSS Feed",
		language: "Language",
	},
	zh: {
		latest: "最新",
		viewAll: "查看全部",
		minRead: (n: number) => `阅读约 ${n} 分钟`,
		minutes: (n: number) => `${n} 分钟`,
		allPosts: "全部文章",
		browseAllPosts: "浏览全部文章",
		articles: (n: number) => `${n} 篇文章`,
		noPosts: "暂无文章。",
		category: "分类",
		tag: "标签",
		categoryTitle: (label: string) => `分类：${label}`,
		categoryDescription: (label: string) => `分类“${label}”下的全部文章`,
		tagTitle: (label: string) => `标签：${label}`,
		tagDescription: (label: string) => `标签“${label}”下的全部文章`,
		noPostsInCategory: "该分类下暂无文章。",
		noPostsWithTag: "该标签下暂无文章。",
		firstPage: "第一页",
		nextPage: "下一页",
		olderPosts: "更早的文章",
		author: "作者",
		authors: "作者",
		published: "发布于",
		readingTime: "阅读时间",
		tags: "标签",
		onThisPage: "本页内容",
		continueReading: "继续阅读",
		search: "搜索",
		searchPlaceholder: "搜索…",
		searchPosts: "搜索文章…",
		searchDescription: "搜索文章",
		searchHint: "输入关键词搜索文章。",
		searchResults: (n: number, q: string) => (n === 0 ? `没有找到“${q}”的结果` : `“${q}”共 ${n} 条结果`),
		searchTitle: (q: string) => `搜索：${q}`,
		notFound: "页面不存在",
		notFoundBody: "您访问的页面不存在。",
		goHome: "返回首页",
		navigate: "导航",
		connect: "关注",
		rssFeed: "RSS 订阅",
		language: "语言",
	},
} satisfies Record<Locale, unknown>;

export function t(locale: Locale) {
	return STRINGS[locale];
}

/**
 * Post URL: WordPress-style /YYYY/MM/slug, matching the posts collection's
 * urlPattern "/{year}/{month}/{slug}" (EmDash expands dates in UTC).
 */
export function postPath(
	locale: Locale,
	post: { id: string; data: { publishedAt?: Date | null } },
): string {
	// EmDash prefixes entry.id with "<locale>/" for every locale but the
	// unprefixed default ("zh/my-post"), and localizePath adds that prefix
	// again, so build the URL from the bare slug.
	const slug = post.id.slice(post.id.indexOf("/") + 1);
	const date = post.data.publishedAt;
	if (!date) return localizePath(locale, `/posts/${encodeURIComponent(slug)}`);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	return localizePath(locale, `/${year}/${month}/${encodeURIComponent(slug)}`);
}

/** Page URL, matching the pages collection's urlPattern "/{slug}". */
export function pagePath(locale: Locale, slug: string): string {
	return localizePath(locale, `/${encodeURIComponent(slug)}`);
}
