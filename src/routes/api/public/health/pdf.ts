import { createFileRoute } from "@tanstack/react-router";

// Minimal valid 1-page PDF (no text content) — verifies unpdf can initialize on workerd.
const TINY_PDF_BASE64 =
  "JVBERi0xLjEKJcKlwrHDqwoKMSAwIG9iagogIDw8IC9UeXBlIC9DYXRhbG9nCiAgICAgL1BhZ2VzIDIgMCBSCiAgPj4KZW5kb2JqCgoyIDAgb2JqCiAgPDwgL1R5cGUgL1BhZ2VzCiAgICAgL0tpZHMgWzMgMCBSXQogICAgIC9Db3VudCAxCiAgICAgL01lZGlhQm94IFswIDAgMTAwIDEwMF0KICA+PgplbmRvYmoKCjMgMCBvYmoKICA8PCAvVHlwZSAvUGFnZQogICAgIC9QYXJlbnQgMiAwIFIKICAgICAvUmVzb3VyY2VzIDw8ID4+CiAgICAgL0NvbnRlbnRzIDQgMCBSCiAgPj4KZW5kb2JqCgo0IDAgb2JqCiAgPDwgL0xlbmd0aCAwID4+CnN0cmVhbQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYKMDAwMDAwMDAxOCAwMDAwMCBuCjAwMDAwMDAwNzcgMDAwMDAgbgowMDAwMDAwMTc4IDAwMDAwIG4KMDAwMDAwMDQ1NyAwMDAwMCBuCnRyYWlsZXIKICA8PCAvUm9vdCAxIDAgUgogICAgIC9TaXplIDUKICA+PgpzdGFydHhyZWYKNTI1CiUlRU9G";

export const Route = createFileRoute("/api/public/health/pdf")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const bin = atob(TINY_PDF_BASE64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const { extractText, getDocumentProxy } = await import("unpdf");
          const pdf = await getDocumentProxy(bytes);
          const { text } = await extractText(pdf, { mergePages: true });
          const joined = Array.isArray(text) ? text.join("") : String(text || "");
          return Response.json({ ok: true, chars: joined.length, bytes: bytes.length });
        } catch (e) {
          return Response.json(
            { ok: false, error: (e as Error)?.message || "unpdf failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
