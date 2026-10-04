import { defineMiddleware } from "astro:middleware";

// www is bound to the Worker only so it can send visitors to the apex.
// WordPress answered it with a 301 and indexed URLs still point here.
//
// This has to run before EmDash's redirect table, which is why it is a
// separate middleware registered with `order: "pre"` rather than living in
// src/middleware.ts: EmDash builds its redirects from the request origin, so a
// legacy path arriving on www would otherwise land on www rather than the apex.
export const onRequest = defineMiddleware((context, next) => {
	if (context.url.hostname !== "www.xinchejian.com") return next();

	const { pathname, search } = context.url;
	return context.redirect(`https://xinchejian.com${pathname}${search}`, 301);
});
