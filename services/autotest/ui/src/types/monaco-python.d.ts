// monaco-editor bundles language definitions without published .d.ts files.
// Declare the esm subpath we import so vue-tsc stops treating it as implicit any.
declare module 'monaco-editor/languages/definitions/python/python.js' {
  export const conf: {
    comments?: Record<string, unknown>
    brackets?: unknown[]
    autoClosingPairs?: unknown[]
    surroundingPairs?: unknown[]
    folding?: Record<string, unknown>
  }
  export const language: {
    keywords?: string[]
    operators?: string[]
    symbols?: string[]
    defaultToken?: string
    tokenPostfix?: string
  }
}