/// <reference types="vite/client" />

declare module "*.md" {
  const doc: { html: string; title: string; headings: { level: number; id: string; text: string }[] };
  export default doc;
}
