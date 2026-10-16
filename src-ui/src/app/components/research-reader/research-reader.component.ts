import { HttpClient } from '@angular/common/http'
import {
  ChangeDetectorRef,
  Component,
  inject,
  Input,
  OnChanges,
  OnDestroy,
} from '@angular/core'
import { FormsModule } from '@angular/forms'
import { Router, ActivatedRoute } from '@angular/router'
import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
import { Subject, takeUntil } from 'rxjs'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { environment } from 'src/environments/environment'
import { SettingsService } from 'src/app/services/settings.service'
import { ResearchPdfComponent } from './annotations/research-pdf.component'
import { AnnotationPanelComponent } from './annotations/annotation-panel.component'
import { AnnotationSession } from './annotations/annotation-session.service'
import {
  PdfZoomLevel,
  PdfZoomScale,
} from '../common/pdf-viewer/pdf-viewer.types'

interface Artifact {
  id: string
  kind: string
  title: string
  provenance: string
}
interface Position {
  page: number
  zoom: PdfZoomLevel
  scroll: number
  rotation?: number
}
interface ReaderState {
  view?: string
  panel?: string
  width?: number
  collapsed?: boolean
  positions?: Record<string, Position>
}
interface Personal {
  notes: string
  list_status: string
  starred: boolean
  reader_state: ReaderState
  note_revision: number
}
interface Task {
  id: string
  kind: string
  status: string
  stage: string
  error_detail: string
  provenance: string
  usage?: {
    requests_started?: number
    responses_received?: number
    tokens?: { total_tokens?: number }
  }
}
interface ResearchState {
  pending_metadata: Record<string, string>
  manual_fields: string[]
  paper_key: string
  associated: boolean
  ai_enabled: boolean
  disabled_reason: string
  processing_notice: string
  can_import: boolean
  bibliography: Record<string, string>
  personal: Personal
  artifacts: Artifact[]
  tasks: Task[]
}

@Component({
  selector: 'pngx-research-reader',
  imports: [FormsModule, ResearchPdfComponent, AnnotationPanelComponent],
  providers: [AnnotationSession],
  templateUrl: './research-reader.component.html',
  styleUrl: './research-reader.component.scss',
})
export class ResearchReaderComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) documentId!: number
  @Input() documentTitle = ''
  annotations = inject(AnnotationSession)
  private http = inject(HttpClient)
  private cdr = inject(ChangeDetectorRef)
  private router = inject(Router)
  private route = inject(ActivatedRoute)
  private settings = inject(SettingsService)
  private sanitizer = inject(DomSanitizer)
  private reset = new Subject<void>()
  private timer?: ReturnType<typeof setInterval>
  private saveTimer?: ReturnType<typeof setTimeout>
  private session = crypto.randomUUID().replaceAll('-', '')
  private sequence = 0
  private lastTick = Date.now()
  private resetClock = () => {
    this.lastTick = Date.now()
  }
  private loadedDocumentId?: number
  state: ResearchState | null = null
  personal: Personal = {
    notes: '',
    list_status: 'none',
    starred: false,
    reader_state: {},
    note_revision: 0,
  }
  bibliography: Record<string, string> = {}
  error = ''
  notice = ''
  view = 'original'
  panel = 'analysis'
  panelWidth = 35
  collapsed = false
  mobilePanel = false
  page = 1
  pages = 0
  zoom = PdfZoomLevel.One
  zoomScale = PdfZoomScale.PageWidth
  search = ''
  pdfSource = ''
  positions: Record<string, Position> = {}
  analysis: SafeHtml | null = null
  analysisLoading = false
  pending: Record<string, string> = {}
  accepted: Record<string, boolean> = {}
  manualFields: string[] = []
  bibtexImport = ''
  importKind = 'reference_pdf'
  busy = false
  confirmExternal = false
  forceGenerate = false
  readonly kindNames: Record<string, string> = {
    translation: '翻译',
    analysis: '解读',
    manual_import: '人工导入',
  }
  readonly statusNames: Record<string, string> = {
    queued: '等待执行',
    running: '处理中',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    cancel_requested: '取消中',
    cancelled: '已取消',
  }
  readonly artifactNames: Record<string, string> = {
    reference_pdf: '参考 PDF',
    translated_pdf: '人工参考双语 / 双语 PDF',
    chinese_pdf: '人工参考中文 / 中文 PDF',
    analysis_markdown: '解读',
    figure_png: '插图',
  }
  readonly bookFields: Record<string, string> = {
    title: '论文题名',
    authors: '作者',
    year: '年份',
    journal: '期刊',
    doi: 'DOI',
    arxiv_id: 'arXiv',
    keywords: '关键词',
    abstract: '摘要',
  }
  readonly bookKeys = Object.keys(this.bookFields)
  readonly zooms = [
    PdfZoomLevel.Half,
    PdfZoomLevel.ThreeQuarters,
    PdfZoomLevel.One,
    PdfZoomLevel.OneAndHalf,
    PdfZoomLevel.Two,
  ]
  get endpoint() {
    return `${environment.apiBaseUrl}research/documents/${this.documentId}/`
  }
  get annotationSelector() {
    return this.view === 'original'
      ? 'original'
      : this.selectedArtifact?.id || ''
  }
  get readerUser() {
    return String(this.settings.currentUser()?.id || '')
  }
  appendAnnotation(text: string) {
    this.personal.notes += (this.personal.notes ? '\n\n' : '') + text
    this.draftChanged()
    this.selectPanel('notes')
    this.savePersonal()
  }
  get originalUrl() {
    return `${environment.apiBaseUrl}documents/${this.documentId}/preview/?original=true`
  }
  get selectedArtifact() {
    return this.state?.artifacts
      .filter(
        (a) =>
          a.kind ===
          (this.view === 'bilingual' ? 'translated_pdf' : 'chinese_pdf')
      )
      .at(-1)
  }
  get downloadUrl() {
    return this.view === 'original'
      ? `${environment.apiBaseUrl}documents/${this.documentId}/download/?original=true`
      : this.selectedArtifact
        ? this.artifactUrl(this.selectedArtifact)
        : ''
  }
  get analysisArtifact() {
    return this.state?.artifacts
      .filter((a) => a.kind === 'analysis_markdown')
      .at(-1)
  }
  get dirty() {
    return !!this.state && this.personal.notes !== this.state.personal.notes
  }
  get draftKey() {
    return `research-note:${this.settings.currentUser()?.id}:${this.state?.paper_key || this.documentId}`
  }
  get returnUrl() {
    const path = this.route.snapshot.queryParamMap.get('from')
    return path?.startsWith('/research/library?') ? path : '/research/library'
  }
  artifactUrl(artifact: Artifact) {
    return this.endpoint + `artifacts/${artifact.id}/`
  }
  ngOnChanges() {
    document.addEventListener('visibilitychange', this.resetClock)
    window.addEventListener('focus', this.resetClock)
    window.addEventListener('blur', this.resetClock)
    this.reset.next()
    clearInterval(this.timer)
    clearTimeout(this.saveTimer)
    this.state = null
    this.analysis = null
    this.error = ''
    this.notice = ''
    this.view = 'original'
    this.panel = 'analysis'
    this.positions = {}
    this.page = 1
    this.pages = 0
    this.zoom = PdfZoomLevel.One
    this.search = ''
    this.pdfSource = this.originalUrl
    this.personal = {
      notes: '',
      list_status: 'none',
      starred: false,
      reader_state: {},
      note_revision: 0,
    }
    this.confirmExternal = false
    this.forceGenerate = false
    this.session = crypto.randomUUID().replaceAll('-', '')
    this.sequence = 0
    this.loadedDocumentId = undefined
    this.load(true)
  }
  ngOnDestroy() {
    document.removeEventListener('visibilitychange', this.resetClock)
    window.removeEventListener('focus', this.resetClock)
    window.removeEventListener('blur', this.resetClock)
    this.sendReading(0)
    this.reset.next()
    this.reset.complete()
    clearInterval(this.timer)
    clearTimeout(this.saveTimer)
  }
  load(initial = false) {
    this.http
      .post<ResearchState>(this.endpoint, {})
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: (state) => {
          const previousAnalysis = this.analysisArtifact?.id,
            previousPdf = this.selectedArtifact?.id
          this.state = state
          if (!initial) {
            if (this.analysisArtifact?.id !== previousAnalysis)
              this.loadAnalysis()
            if (
              this.view !== 'original' &&
              this.selectedArtifact?.id !== previousPdf
            )
              this.switchView(this.view, false)
          }
          if (initial) {
            this.loadedDocumentId = this.documentId
            this.personal = structuredClone(state.personal)
            this.bibliography = { ...state.bibliography }
            const saved = this.personal.reader_state || {}
            this.positions = saved.positions || {}
            this.panel = [
              'analysis',
              'notes',
              'bibliography',
              'annotations',
            ].includes(saved.panel)
              ? saved.panel
              : 'analysis'
            this.panelWidth = Math.max(25, Math.min(55, saved.width || 35))
            this.collapsed = !!saved.collapsed
            this.switchView(
              ['original', 'bilingual', 'chinese'].includes(saved.view)
                ? saved.view
                : 'original',
              false
            )
            const draft = sessionStorage.getItem(this.draftKey)
            if (draft) {
              try {
                const parsed = JSON.parse(draft)
                this.personal.notes = parsed.notes
                this.notice = '已恢复此账号的未保存笔记草稿。'
              } catch {
                sessionStorage.removeItem(this.draftKey)
              }
            }
            this.pending = state.pending_metadata || {}
            this.manualFields = state.manual_fields || []
            this.accepted = Object.fromEntries(
              this.bookKeys.map((name) => [
                name,
                !this.manualFields.includes(name),
              ])
            )
            this.loadAnalysis()
            this.sendReading(0)
            this.lastTick = Date.now()
            clearInterval(this.timer)
            this.timer = setInterval(() => this.tick(), 15000)
          }
        },
        error: (response) => {
          this.error =
            response.error?.detail ?? '研究服务暂不可用，原始PDF仍可阅读。'
        },
      })
      .add(() => this.cdr.markForCheck())
  }
  private tick() {
    const now = Date.now(),
      seconds = (now - this.lastTick) / 1000
    this.lastTick = now
    if (document.visibilityState === 'visible' && document.hasFocus())
      this.sendReading(Math.min(20, seconds))
    if (
      this.state?.tasks.some((t) =>
        ['queued', 'running', 'cancel_requested'].includes(t.status)
      )
    )
      this.load()
  }
  sendReading(seconds: number) {
    if (!this.state || this.loadedDocumentId !== this.documentId) return
    this.rememberPosition()
    const payload = {
      session: this.session,
      sequence: this.sequence++,
      seconds,
      reader_state: {
        view: this.view,
        panel: this.panel,
        width: this.panelWidth,
        collapsed: this.collapsed,
        positions: this.positions,
      },
    }
    this.http
      .post(this.endpoint + 'reading/', payload)
      .subscribe({ error: () => {} })
  }
  rememberPosition() {
    const scroller = document.querySelector(
      'pngx-research-reader .pngx-pdf-viewer-container'
    ) as HTMLElement | null
    this.positions[this.view] = {
      page: this.page,
      zoom: this.zoom,
      scroll:
        this.annotations.port?.scrollPosition() || scroller?.scrollTop || 0,
      rotation: this.annotations.port?.rotation() || 0,
    }
  }
  schedulePosition() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.sendReading(0), 500)
  }
  switchView(view: string, persist = true) {
    if (persist) this.rememberPosition()
    this.view = view
    this.page = this.positions[view]?.page || 1
    this.zoom = this.positions[view]?.zoom || PdfZoomLevel.One
    this.search = ''
    const source =
      view === 'original'
        ? this.originalUrl
        : this.selectedArtifact
          ? this.artifactUrl(this.selectedArtifact)
          : ''
    if (source !== this.pdfSource) this.pages = 0
    this.pdfSource = source
    if (persist) this.schedulePosition()
  }
  pdfLoaded(pdf: { numPages: number }) {
    this.pages = pdf.numPages
    this.page = Math.max(1, Math.min(this.pages, this.page))
    this.cdr.markForCheck()
  }
  pdfRendered() {
    const saved = this.positions[this.view]
    if (saved?.scroll) {
      const scroller = document.querySelector(
        'pngx-research-reader .pngx-pdf-viewer-container'
      ) as HTMLElement | null
      if (scroller) {
        scroller.scrollTop = saved.scroll
        saved.scroll = 0
      }
    }
  }
  pageChanged(page: number) {
    this.page = page
    this.schedulePosition()
  }
  pdfError() {
    this.error = 'PDF加载失败，请检查当前权限或刷新重试。'
  }
  selectPanel(panel: string) {
    this.panel = panel
    this.collapsed = false
    this.mobilePanel = true
    this.schedulePosition()
  }
  back() {
    this.sendReading(0)
    this.router.navigateByUrl(this.returnUrl)
  }
  draftChanged() {
    if (this.dirty)
      sessionStorage.setItem(
        this.draftKey,
        JSON.stringify({ notes: this.personal.notes })
      )
    else sessionStorage.removeItem(this.draftKey)
  }
  savePersonal() {
    const payload = {
      notes: this.personal.notes,
      note_revision: this.personal.note_revision,
      list_status: this.personal.list_status,
      starred: this.personal.starred,
    }
    this.http
      .post<{ personal: Personal }>(this.endpoint + 'personal/', payload)
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: (response) => {
          this.personal.note_revision = response.personal.note_revision
          this.state.personal = { ...response.personal }
          this.notice = '个人阅读记录已保存'
          this.error = ''
          this.draftChanged()
        },
        error: (response) =>
          (this.error =
            response.error?.detail ?? '保存失败，草稿已保留，请重试。'),
      })
      .add(() => this.cdr.markForCheck())
  }
  saveStatus() {
    this.http
      .post(this.endpoint + 'personal/', {
        list_status: this.personal.list_status,
        starred: this.personal.starred,
      })
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: () => {
          this.notice = '阅读状态已保存'
          this.error = ''
        },
        error: () => (this.error = '阅读状态保存失败'),
      })
      .add(() => this.cdr.markForCheck())
  }
  removeFromList() {
    this.personal.list_status = 'none'
    this.personal.starred = false
    this.saveStatus()
  }
  saveBibliography(importBibtex = false) {
    this.http
      .post<{
        bibliography: Record<string, string>
        pending_metadata: Record<string, string>
        manual_fields: string[]
      }>(
        this.endpoint + 'bibliography/',
        importBibtex
          ? { bibtex_import: this.bibtexImport, preview_only: true }
          : this.bibliography
      )
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: (response) => {
          if (!importBibtex) this.bibliography = { ...response.bibliography }
          this.pending = response.pending_metadata || {}
          this.manualFields = response.manual_fields || []
          this.accepted = Object.fromEntries(
            this.bookKeys.map((name) => [
              name,
              !this.manualFields.includes(name),
            ])
          )
          this.bibtexImport = ''
          this.notice = importBibtex
            ? '候选已保存，请逐字段确认；手动字段默认受保护'
            : '书目已保存；Paperless原归档信息保留'
          this.error = ''
        },
        error: (r) => (this.error = r.error?.detail ?? '书目保存失败'),
      })
      .add(() => this.cdr.markForCheck())
  }
  confirmMetadata() {
    this.http
      .post<{ bibliography: Record<string, string> }>(
        this.endpoint + 'bibliography/',
        { accept_fields: this.bookKeys.filter((name) => this.accepted[name]) }
      )
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: (r) => {
          this.bibliography = { ...r.bibliography }
          this.pending = {}
          this.notice = '已应用选定字段，其他手动信息保留'
        },
        error: (r) => (this.error = r.error?.detail ?? '确认未完成'),
      })
      .add(() => this.cdr.markForCheck())
  }
  copyBibtex() {
    this.http
      .get(this.endpoint + 'bibtex/', { responseType: 'text' })
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: async (text) => {
          try {
            await navigator.clipboard.writeText(text)
            this.notice = 'BibTeX已复制'
          } catch {
            this.error = '无法访问剪贴板，可使用导出BibTeX'
          }
          this.cdr.markForCheck()
        },
        error: () => {
          this.error = 'BibTeX读取失败'
          this.cdr.markForCheck()
        },
      })
  }
  loadAnalysis() {
    const artifact = this.analysisArtifact
    if (!artifact) {
      this.analysis = null
      return
    }
    this.analysisLoading = true
    this.http
      .get(this.artifactUrl(artifact), { responseType: 'text' })
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: (text) => {
          const equations: string[] = []
          const source = text.replace(
            /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)\$/g,
            (match, a, b, c, d) => {
              const marker = `MATHPLACEHOLDER${equations.length}TOKEN`
              equations.push(
                katex.renderToString(a || b || c || d, {
                  displayMode: !!(a || b),
                  throwOnError: false,
                  trust: false,
                  maxExpand: 1000,
                  maxSize: 20,
                })
              )
              return marker
            }
          )
          let html = marked.parse(source, {
            async: false,
            gfm: true,
          }) as string
          equations.forEach(
            (value, index) =>
              (html = html.replace(`MATHPLACEHOLDER${index}TOKEN`, value))
          )
          DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
            if (data.attrName === 'srcset') data.keepAttr = false
            if (data.attrName === 'src') {
              try {
                const url = new URL(data.attrValue, location.origin)
                if (
                  node.nodeName !== 'IMG' ||
                  url.origin !== location.origin ||
                  !url.pathname.startsWith(
                    `/api/research/documents/${this.documentId}/artifacts/`
                  )
                )
                  data.keepAttr = false
              } catch {
                data.keepAttr = false
              }
            }
          })
          const cleaned = DOMPurify.sanitize(html, {
            FORBID_TAGS: [
              'script',
              'style',
              'iframe',
              'object',
              'form',
              'input',
            ],
          })
          DOMPurify.removeHook('uponSanitizeAttribute')
          const doc = new DOMParser().parseFromString(cleaned, 'text/html')
          doc.querySelectorAll('img').forEach((image) => {
            try {
              const url = new URL(
                image.getAttribute('src') || '',
                location.origin
              )
              if (
                url.origin !== location.origin ||
                !url.pathname.startsWith(
                  `/api/research/documents/${this.documentId}/artifacts/`
                )
              )
                image.remove()
              else image.loading = 'lazy'
            } catch {
              image.remove()
            }
          })
          doc.querySelectorAll('a').forEach((link) => {
            link.target = '_blank'
            link.rel = 'noopener noreferrer nofollow'
          })
          this.analysis = this.sanitizer.bypassSecurityTrustHtml(
            doc.body.innerHTML
          )
        },
        error: () => (this.error = '解读结果不可访问，请检查文档权限。'),
      })
      .add(() => {
        this.analysisLoading = false
        this.cdr.markForCheck()
      })
  }
  startTask(kind: string, retryTaskId?: string) {
    this.busy = true
    this.error = ''
    this.http
      .post<{ artifact_id?: string; reused: boolean; detail?: string }>(
        this.endpoint + 'tasks/',
        {
          kind,
          confirm_external: this.confirmExternal,
          force: this.forceGenerate,
          retry_task_id: retryTaskId,
        }
      )
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: (r) => {
          this.confirmExternal = false
          this.forceGenerate = false
          this.notice =
            r.detail ??
            (r.reused ? '已复用已有结果或任务，未重复创建' : '任务已保存')
          if (kind === 'analysis') {
            this.loadAnalysis()
            this.selectPanel('analysis')
          } else if (r.artifact_id) this.switchView('bilingual')
          this.load()
        },
        error: (r) =>
          (this.error = r.error?.detail ?? '模型服务未启用，未创建任务'),
      })
      .add(() => {
        this.busy = false
        this.cdr.markForCheck()
      })
  }
  restoreFile(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0]
    if (!file) return
    const body = new FormData()
    body.append('file', file)
    this.http
      .post<{ imported: number; reused: number }>(
        this.endpoint + 'restore/',
        body
      )
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: (r) => {
          this.notice = `已合并${r.imported}份产物，复用${r.reused}份，保留已有笔记和书目；未启动任务`
          input.value = ''
          this.load()
        },
        error: (r) => (this.error = r.error?.detail ?? '研究包未导入'),
      })
      .add(() => this.cdr.markForCheck())
  }
  importFile(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0]
    if (!file) return
    const body = new FormData()
    body.append('kind', this.importKind)
    body.append('file', file)
    this.http
      .post(this.endpoint + 'artifacts/', body)
      .pipe(takeUntil(this.reset))
      .subscribe({
        next: () => {
          input.value = ''
          this.notice = '已人工导入，未调用模型'
          this.load()
        },
        error: (r) => (this.error = r.error?.detail ?? '导入失败'),
      })
      .add(() => this.cdr.markForCheck())
  }
}
