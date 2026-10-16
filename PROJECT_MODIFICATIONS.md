# Local research integration changes

Upstream: https://github.com/paperless-ngx/paperless-ngx, v3.3.1, baseline c4d1b0c7325ea8782d87c64b6738ac39d313df2e. Original LICENSE is preserved. Local branch: integration/paperless-research. The production-compatible base is retained.

2026-10-14–15: added native Angular reading center, unified single-PDF research reader, private notes/bibliography, research tasks/preferences and discovery/import routes. Added a Django same-origin gateway which checks the current Paperless user and document permissions for reads, writes, task actions and every artifact download; session writes retain CSRF checks. No anonymous service-account fallback. Research data and processing remain in the independent Resophy service.

The supplied Gemini ZIP and separate interactive HTML were audited as untrusted design references. Only the two-column interaction idea was used; its backend, floating plugin, deployment/backup/rollback scripts and hardcoded accounts were not copied or executed. New components inherit Paperless theme.scss/SettingsService variables and user-adjustable appearance.

Direct UI additions are pinned in pnpm-lock.yaml: marked 18.1.0 (MIT), DOMPurify 3.4.16 (MPL-2.0 OR Apache-2.0), KaTeX 0.19.0 (MIT), @types/katex 0.16.8 (MIT), verified against npm version metadata. Generated third-party notices remain in the frontend build. This is not a complete transitive dependency/license audit.

Local-only test configuration disables all external AI and automatic model workflows. Manual fixtures are labeled as such. Real translation/interpretation and model performance have not been validated. Audit, test evidence, boundaries and orchestration belong to the companion orchestration repository; runtime data and credentials are excluded from Git.

2026-10-16: added content-free provider token journals, explicit real-AI opt-in, strict generated-result reuse, pinned BabelDOC CLI compatibility and protected MinerU image artifacts. Real acceptance is tracked separately; no claim of complete feature migration or commercial licensing.
