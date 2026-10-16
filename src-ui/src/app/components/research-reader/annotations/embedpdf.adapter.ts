import type {
  AnnotationCapability,
  AnnotationScope,
  DocumentManagerCapability,
  EmbedPdfContainer,
  ExportCapability,
  HistoryCapability,
  HistoryScope,
  PdfAnnotationObject,
  PluginRegistry,
  RotateCapability,
  ScrollCapability,
  ScrollScope,
  SearchCapability,
  SelectionCapability,
  ZoomCapability,
  ViewportCapability,
} from '@embedpdf/snippet'
import {
  AnnotationChange,
  AnnotationRecord,
  PdfReaderPort,
  ReaderCapabilities,
} from './annotation-contract'

/** All SDK-specific objects, event suppression and geometry conversion stay here. */
export class EmbedPdfAdapter implements PdfReaderPort {
  private viewer?: EmbedPdfContainer
  private registry?: PluginRegistry
  private documentId = ''
  private annotation?: AnnotationScope
  private history?: HistoryScope
  private scroll?: ScrollScope
  private subscriptions: (() => void)[] = []
  private observer?: MutationObserver
  private media = matchMedia('(prefers-color-scheme: dark)')
  private themeChanged = () => this.theme()
  private muted = false
  private destroyed = false
  private layoutReady = false
  private initialZoom = 1
  private pendingPage = 1
  private finishLayout?: () => void
  private known = new Set<string>()
  private native = new Set<string>()
  private canAnnotate = false
  private quotes = new Map<string, string>()
  private sdk?: typeof import('@embedpdf/snippet')
  constructor(
    private target: HTMLElement,
    private changed: (event: AnnotationChange) => void,
    private selected: (id: string) => void,
    private pageChanged: (page: number) => void,
    private updated: () => void,
    private failed: (message: string) => void
  ) {}

  private plugin<T>(name: string): T {
    return this.registry?.getPlugin(name)?.provides() as T
  }
  async open(buffer: ArrayBuffer, page: number, zoom: number, rotation = 0) {
    this.initialZoom = zoom
    this.pendingPage = page
    this.sdk = await import('@embedpdf/snippet')
    if (this.destroyed) return 0
    this.viewer = this.sdk.default.init({
      type: 'container',
      target: this.target,
      worker: true,
      wasmUrl: new URL('assets/embedpdf/pdfium.wasm', document.baseURI).href,
      fontFallback: {
        fonts: {
          134: new URL(
            'assets/embedpdf/fonts/NotoSansHans-Regular.otf',
            document.baseURI
          ).href,
        },
      },
      fonts: { ui: null, signature: null },
      stamp: { manifests: [], libraries: [], defaultLibrary: false },
      tabBar: 'never',
      documentManager: { initialDocuments: [], maxDocuments: 1 },
      // 2.15.1 leaves its initial viewport gate closed for numeric defaults.
      // Bootstrap with its public automatic mode, then apply the saved numeric zoom.
      zoom: { defaultZoomLevel: this.sdk.ZoomMode.FitPage },
      rotation: { defaultRotation: rotation },
      disabledCategories: [
        'document',
        'insert',
        'redaction',
        'form',
        'capture',
        'annotation',
      ],
      ui: {
        schema: {
          id: 'research-pdf',
          version: '1.0.0',
          toolbars: {},
          sidebars: {},
          menus: {},
          modals: {},
          overlays: {},
          selectionMenus: {},
        },
      },
      annotations: { autoCommit: false },
    })
    if (!this.viewer) throw new Error('PDF阅读器初始化失败')
    let initializationTimeout: ReturnType<typeof setTimeout>
    try {
      this.registry = await Promise.race([
        this.viewer.registry,
        new Promise<never>((_, reject) => {
          initializationTimeout = setTimeout(
            () => reject(new Error('PDF engine unavailable')),
            15000
          )
        }),
      ])
    } finally {
      clearTimeout(initializationTimeout)
    }
    if (this.destroyed) {
      this.viewer.remove()
      return 0
    }
    this.theme()
    this.observer = new MutationObserver(() => this.theme())
    this.observer.observe(document.documentElement, {
      attributes: true,
      subtree: false,
    })
    this.observer.observe(document.body, { attributes: true, subtree: false })
    this.media.addEventListener('change', this.themeChanged)
    const manager = this.plugin<DocumentManagerCapability>('document-manager')
    const opened = await manager
      .openDocumentBuffer({ buffer, name: 'Paperless.pdf', scale: zoom })
      .toPromise()
    const pdf = await opened.task.toPromise()
    if (this.destroyed) return 0
    this.canAnnotate =
      !pdf.isEncrypted ||
      pdf.isOwnerUnlocked ||
      (pdf.permissions & (1 << 5)) !== 0
    this.documentId = opened.documentId
    this.annotation = this.plugin<AnnotationCapability>(
      'annotation'
    ).forDocument(this.documentId)
    this.history = this.plugin<HistoryCapability>('history').forDocument(
      this.documentId
    )
    this.scroll = this.plugin<ScrollCapability>('scroll').forDocument(
      this.documentId
    )
    const layout = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('PDF layout unavailable')),
        15000
      )
      this.finishLayout = () => {
        clearTimeout(timeout)
        resolve()
      }
      this.subscriptions.push(
        this.plugin<ScrollCapability>('scroll').onLayoutReady((event) => {
          if (
            event.documentId !== this.documentId ||
            this.layoutReady ||
            this.destroyed
          )
            return
          this.layoutReady = true
          this.zoom(this.initialZoom)
          this.navigate(this.pendingPage)
          this.finishLayout()
        })
      )
    })
    this.subscriptions.push(
      this.annotation.onAnnotationEvent((event) => {
        if (event.type === 'loaded') {
          for (const entry of this.annotation.getAnnotations()) {
            if (!this.known.has(entry.object.id)) {
              this.native.add(entry.object.id)
              this.annotation.syncAnnotationObject(entry.object.id, {
                flags: ['print', 'locked', 'lockedContents'],
              })
            }
          }
          return
        }
        if (
          this.muted ||
          event.committed ||
          this.native.has(event.annotation.id)
        )
          return
        const object =
          event.type === 'update'
            ? { ...event.annotation, ...event.patch }
            : event.annotation
        const record = this.fromSdk(object as PdfAnnotationObject)
        if (!record) {
          this.failed('该PDF批注类型当前不支持保存。')
          return
        }
        this.known.add(record.id)
        this.changed({ action: event.type, annotation: record })
      })
    )
    this.subscriptions.push(
      this.annotation.onStateChange(() => {
        const id = this.annotation.getSelectedAnnotationIds()[0]
        if (id && this.known.has(id)) this.selected(id)
        this.updated()
      })
    )
    this.subscriptions.push(this.history.onHistoryChange(() => this.updated()))
    await layout
    if (this.destroyed) return 0
    this.subscriptions.push(
      this.scroll.onPageChange((event) => this.pageChanged(event.pageNumber))
    )
    return pdf.pages.length
  }
  private theme() {
    const css = getComputedStyle(this.target)
    const color = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback
    const surface = color('--pngx-bg-alt', '#ffffff'),
      foreground = color('--bs-body-color', '#303030')
    const primary = color('--bs-primary', '#17541f'),
      border = color('--bs-border-color', '#dddddd')
    const palette = {
      background: {
        app: surface,
        surface,
        elevated: surface,
        surfaceAlt: color('--pngx-bg-darker', '#eeeeee'),
      },
      foreground: { primary: foreground, secondary: foreground },
      border: { default: border },
      accent: {
        primary,
        primaryHover: primary,
        primaryActive: primary,
        primaryForeground: color('--pngx-primary-text-contrast', '#ffffff'),
      },
    }
    const mode = document.documentElement.getAttribute('data-bs-theme')
    this.viewer?.setTheme({
      preference:
        mode === 'auto' ? 'system' : mode === 'dark' ? 'dark' : 'light',
      light: palette,
      dark: palette,
    })
  }
  private fromSdk(object: PdfAnnotationObject): AnnotationRecord | null {
    const types = {
      1: 'text',
      5: 'rectangle',
      9: 'highlight',
      10: 'underline',
      15: 'ink',
    } as const
    const type = types[object.type]
    if (!type) return null
    const raw = JSON.parse(JSON.stringify(object))
    const segments = raw.segmentRects?.length ? raw.segmentRects : [raw.rect]
    const quote = raw.custom?.text || this.quotes.get(raw.id) || ''
    this.quotes.set(raw.id, quote)
    delete raw.custom
    return {
      schema_version: 1,
      id: raw.id,
      type,
      page: raw.pageIndex + 1,
      coordinate_system: 'pdf-points-top-left-unrotated',
      regions: segments.map((r) => ({
        x: r.origin.x,
        y: r.origin.y,
        width: r.size.width,
        height: r.size.height,
      })),
      quote,
      comment: raw.contents || '',
      color: raw.strokeColor || raw.color || '#F6D84A',
      sdk: { format: 'embedpdf-v2', version: '2.15.1', data: raw },
    }
  }
  private toSdk(record: AnnotationRecord): PdfAnnotationObject {
    const raw: Record<string, any> = {
      ...(record.type === 'rectangle'
        ? { color: 'transparent', strokeStyle: 1 }
        : {}),
      ...record.sdk.data,
      contents: record.comment,
      custom: { text: record.quote },
    }
    for (const key of ['created', 'modified'])
      if (raw[key]) raw[key] = new Date(raw[key])
    return raw as unknown as PdfAnnotationObject
  }
  loadAnnotations(records: AnnotationRecord[]) {
    if (!this.annotation) return
    this.muted = true
    try {
      for (const record of records) {
        this.known.add(record.id)
        this.quotes.set(record.id, record.quote)
        if (!record.deleted && !this.annotation.getAnnotationById(record.id))
          this.annotation.importAnnotations([
            { annotation: this.toSdk(record) },
          ])
      }
      this.history.purgeByMetadata(() => true)
    } finally {
      this.muted = false
    }
    this.updated()
  }
  navigate(page: number) {
    this.pendingPage = page
    if (!this.layoutReady) return
    this.scroll?.scrollToPage({ pageNumber: page, behavior: 'instant' })
  }
  zoom(level: number) {
    this.initialZoom = level
    if (!this.layoutReady) return
    this.plugin<ZoomCapability>('zoom')
      ?.forDocument(this.documentId)
      .requestZoom(level)
  }
  rotate() {
    this.plugin<RotateCapability>('rotate')
      ?.forDocument(this.documentId)
      .rotateForward()
  }
  search(query: string) {
    const scope = this.plugin<SearchCapability>('search')?.forDocument(
      this.documentId
    )
    if (!scope) return
    if (!query) {
      scope.stopSearch()
      return
    }
    scope.startSearch()
    scope.setShowAllResults(true)
    scope.searchAllPages(query)
  }
  async tool(name: string | null) {
    if (!this.annotation) return
    if (name === 'highlight' || name === 'underline' || name === 'text') {
      const selection = this.plugin<SelectionCapability>(
        'selection'
      ).forDocument(this.documentId)
      const formatted = selection.getFormattedSelection()
      if (formatted.length) {
        const text = (await selection.getSelectedText().toPromise()).join('\n')
        if (this.destroyed) return
        for (const area of formatted) {
          const id = crypto.randomUUID()
          this.quotes.set(id, text)
          this.annotation.createAnnotation(area.pageIndex, {
            id,
            type: name === 'underline' ? 10 : 9,
            pageIndex: area.pageIndex,
            rect: area.rect,
            segmentRects: area.segmentRects,
            strokeColor: '#F6D84A',
            opacity: 0.4,
            flags: ['print'],
            created: new Date(),
            custom: { text },
          } as PdfAnnotationObject)
          this.annotation.selectAnnotation(area.pageIndex, id)
        }
        selection.clear()
        this.annotation.setActiveTool(null)
        return
      }
    }
    this.annotation.deselectAnnotation()
    this.annotation.setActiveTool(
      name === 'rectangle' ? 'square' : name === 'text' ? 'highlight' : name
    )
  }
  focus(record: AnnotationRecord) {
    const region = record.regions[0]
    this.scroll?.scrollToPage({
      pageNumber: record.page,
      pageCoordinates: { x: region.x, y: region.y },
      alignY: 20,
    })
    this.annotation?.selectAnnotation(record.page - 1, record.id)
  }
  comment(record: AnnotationRecord, value: string, notify = true) {
    this.muted = !notify
    try {
      this.annotation?.updateAnnotation(record.page - 1, record.id, {
        contents: value,
      })
    } finally {
      this.muted = false
    }
  }
  remove(record: AnnotationRecord) {
    this.annotation?.deleteAnnotation(record.page - 1, record.id)
  }
  color(record: AnnotationRecord, value: string) {
    this.annotation?.updateAnnotation(record.page - 1, record.id, {
      strokeColor: value,
    } as Partial<PdfAnnotationObject>)
  }
  undo() {
    this.history?.undo()
  }
  redo() {
    this.history?.redo()
  }
  capabilities(): ReaderCapabilities {
    return {
      annotations: !!this.annotation && this.canAnnotate,
      export: !!this.documentId && this.canAnnotate,
      search: !!this.documentId,
      undo: this.history?.canUndo() || false,
      redo: this.history?.canRedo() || false,
    }
  }
  scrollPosition() {
    return this.documentId
      ? this.plugin<ViewportCapability>('viewport')
          .forDocument(this.documentId)
          .getMetrics().scrollTop
      : 0
  }
  restoreScroll(offset: number) {
    if (offset > 0)
      this.plugin<ViewportCapability>('viewport')
        .forDocument(this.documentId)
        .scrollTo({ x: 0, y: offset, behavior: 'instant' })
  }
  rotation() {
    return (
      this.plugin<RotateCapability>('rotate')
        ?.forDocument(this.documentId)
        .getRotation() || 0
    )
  }
  setRotation(value: number) {
    if (Number.isInteger(value) && value >= 0 && value <= 3)
      this.plugin<RotateCapability>('rotate')
        ?.forDocument(this.documentId)
        .setRotation(value)
  }
  async exportCopy() {
    await this.annotation.commit().toPromise()
    return this.plugin<ExportCapability>('export')
      .forDocument(this.documentId)
      .saveAsCopy()
      .toPromise()
  }
  destroy() {
    this.destroyed = true
    this.finishLayout?.()
    this.subscriptions.forEach((unsubscribe) => unsubscribe())
    this.observer?.disconnect()
    this.media.removeEventListener('change', this.themeChanged)
    this.viewer?.remove()
  }
}
