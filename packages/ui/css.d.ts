// Type declarations for CSS imports
// This file provides TypeScript support for importing CSS files

declare module '*.css' {
  // CSS files are imported for side effects (styles)
  // They don't export any values
}

declare module '*.scss' {
  // SCSS files are imported for side effects
}

declare module '*.sass' {
  // SASS files are imported for side effects
}

declare module '*.less' {
  // LESS files are imported for side effects
}
