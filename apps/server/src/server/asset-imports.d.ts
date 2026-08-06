/**
 * What a `with { type: 'file' }` import answers with: the file's path — absolute on disk under
 * `bun start`, `/$bunfs/root/…` inside a compiled executable. TypeScript has no model for import
 * attributes: it types (or refuses) these specifiers by extension alone, so without this it reports
 * every asset in `assets.ts` as a module that does not exist.
 *
 * Deliberately only the extensions the GUI is made of. A wildcard over everything would type a
 * mistyped import as a valid string path instead of failing.
 *
 * NOT named `assets.d.ts`: a `X.d.ts` beside a `X.ts` is read as that file's OWN declarations and
 * dropped from the program, so the declarations below were silently absent and every asset still
 * reported as missing.
 */

declare module '*.css' {
  const path: string;
  export default path;
}

declare module '*.svg' {
  const path: string;
  export default path;
}

declare module '*.ico' {
  const path: string;
  export default path;
}
