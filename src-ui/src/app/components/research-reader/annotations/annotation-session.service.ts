import { HttpClient } from '@angular/common/http'
import { Injectable, inject, signal, OnDestroy } from '@angular/core'
import { firstValueFrom, Subject } from 'rxjs'
import {
  AnnotationChange,
  AnnotationRecord,
  PdfReaderPort,
  PdfVersion,
} from './annotation-contract'

interface Operation extends AnnotationChange {
  op_id: string
  base_revision?: number
}
interface Context {
  url: string
  key: string
  version: PdfVersion
  records: Map<string, AnnotationRecord>
  pending: Operation[]
  queue: Promise<void>
  failed: boolean
  recovering?: boolean
}

@Injectable()
export class AnnotationSession implements OnDestroy {
  private http = inject(HttpClient)
  private context?: Context
  private token = 0
  private staged = new Map<
    string,
    { ctx: Context; op: Operation; timer: ReturnType<typeof setTimeout> }
  >()
  restart = new Subject<void>()
  port?: PdfReaderPort
  records = signal<AnnotationRecord[]>([])
  selected = signal('')
  status = signal('正在加载批注')
  available = signal(false)
  unresolved = signal(0)
  otherVersions = signal(0)
  capabilities = signal({
    annotations: false,
    export: false,
    search: false,
    undo: false,
    redo: false,
  })
  private beforeUnload = (event: BeforeUnloadEvent) => {
    this.flushComments()
    if (this.context?.pending.length) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  constructor() {
    window.addEventListener('beforeunload', this.beforeUnload)
  }
  ngOnDestroy() {
    this.flushComments()
    window.removeEventListener('beforeunload', this.beforeUnload)
  }
  async activate(endpoint: string, selector: string, user: string) {
    const token = ++this.token
    this.port = undefined
    this.available.set(false)
    this.records.set([])
    this.selected.set('')
    this.status.set('正在加载批注')
    this.unresolved.set(0)
    this.otherVersions.set(0)
    const url =
      endpoint + 'annotations/?version=' + encodeURIComponent(selector)
    try {
      const state = await firstValueFrom(
        this.http.get<{
          version: PdfVersion
          annotations: AnnotationRecord[]
          drafts: { payload: Operation }[]
          other_versions: unknown[]
        }>(url)
      )
      if (token !== this.token) return null
      const key = `research-annotations:${user}:${url}:${state.version.sha256}`
      let local: Operation[] = []
      try {
        local = JSON.parse(localStorage.getItem(key) || '[]')
      } catch {
        this.status.set('本地草稿无法解析，请先导出检查')
      }
      const pending = [
        ...new Map(
          [...state.drafts.map((d) => d.payload), ...local].map((op) => [
            op.op_id,
            op,
          ])
        ).values(),
      ]
      this.context = {
        url,
        key,
        version: state.version,
        records: new Map(state.annotations.map((a) => [a.id, a])),
        pending,
        queue: Promise.resolve(),
        failed: false,
      }
      this.records.set(state.annotations.filter((a) => !a.deleted))
      this.otherVersions.set(state.other_versions.length)
      this.unresolved.set(pending.length)
      this.status.set(
        pending.length
          ? '发现未完成草稿；请手动重试或下载，不会自动覆盖'
          : '服务端已保存'
      )
      return state.version
    } catch (error) {
      if (token === this.token)
        this.status.set(error.error?.detail || '批注不可用；原文仍可阅读')
      return null
    }
  }
  bind(port: PdfReaderPort, sha256: string) {
    if (!this.context || this.context.version.sha256 !== sha256) {
      this.status.set('PDF版本无法核对，批注未启用')
      return
    }
    this.port = port
    port.loadAnnotations([...this.context.records.values()])
    this.available.set(true)
    this.refreshCapabilities()
  }
  refreshCapabilities() {
    if (this.port) this.capabilities.set(this.port.capabilities())
  }
  detach() {
    this.flushComments()
    ++this.token
    this.port = undefined
    this.available.set(false)
  }
  commentDraft(record: AnnotationRecord, value: string) {
    const ctx = this.context
    if (!ctx || !this.available()) return
    const key = ctx.key + record.id
    let staged = this.staged.get(key)
    if (!staged) {
      const op: Operation = {
        action: 'update',
        annotation: structuredClone(record),
        op_id: crypto.randomUUID(),
      }
      ctx.pending.push(op)
      staged = { ctx, op, timer: undefined }
      this.staged.set(key, staged)
    }
    staged.op.annotation.comment = value
    this.records.update((records) =>
      records.map((a) => (a.id === record.id ? { ...a, comment: value } : a))
    )
    this.port.comment(record, value, false)
    this.persist(ctx)
    this.status.set('SDK已显示 · 评论待保存')
    clearTimeout(staged.timer)
    staged.timer = setTimeout(() => {
      this.staged.delete(key)
      this.enqueue(ctx, staged.op)
    }, 400)
  }
  flushComments() {
    for (const entry of this.staged.values()) {
      clearTimeout(entry.timer)
      this.enqueue(entry.ctx, entry.op)
    }
    this.staged.clear()
  }
  select(id: string) {
    this.selected.set(id)
  }
  change(change: AnnotationChange) {
    this.flushComments()
    const ctx = this.context
    if (!this.available() || !ctx) return
    const op = {
      ...change,
      annotation: structuredClone(change.annotation),
      op_id: crypto.randomUUID(),
    }
    ctx.pending.push(op)
    this.persist(ctx)
    const shown = this.records().filter((a) => a.id !== change.annotation.id)
    this.records.set(
      change.action === 'delete' ? shown : [...shown, change.annotation]
    )
    this.selected.set(change.annotation.id)
    this.enqueue(ctx, op)
  }
  private persist(ctx: Context) {
    localStorage.setItem(ctx.key, JSON.stringify(ctx.pending))
    if (ctx === this.context) this.unresolved.set(ctx.pending.length)
  }
  private enqueue(ctx: Context, op: Operation) {
    ctx.queue = ctx.queue.then(async () => {
      if (ctx.failed) return
      if (op.base_revision === undefined) {
        const previous = ctx.records.get(op.annotation.id)
        op.base_revision = previous?.revision || 0
        if (op.action !== 'delete')
          op.action = previous && !previous.deleted ? 'update' : 'create'
        this.persist(ctx)
      }
      if (ctx === this.context) this.status.set('SDK已显示 · 正在保存')
      try {
        const response = await firstValueFrom(
          this.http.post<{ annotation: AnnotationRecord }>(ctx.url, op)
        )
        ctx.records.set(response.annotation.id, response.annotation)
        ctx.pending = ctx.pending.filter((p) => p.op_id !== op.op_id)
        this.persist(ctx)
        if (ctx === this.context) {
          if (!ctx.pending.some((p) => p.annotation.id === op.annotation.id))
            this.records.update((records) =>
              records.map((a) =>
                a.id === response.annotation.id ? response.annotation : a
              )
            )
          this.status.set(
            ctx.pending.length ? 'SDK已显示 · 正在保存' : '服务端已保存'
          )
          if (!ctx.pending.length && ctx.recovering) {
            ctx.recovering = false
            this.restart.next()
          }
        }
      } catch (error) {
        ctx.failed = true
        this.persist(ctx)
        if (ctx === this.context)
          this.status.set(
            error.status === 409
              ? '修订冲突：未覆盖服务端；草稿已保留，请下载比较'
              : '保存失败：未确认同步；草稿保留，可手动重试'
          )
      }
    })
  }
  retry() {
    const ctx = this.context
    if (!ctx) return
    ctx.failed = false
    ctx.recovering = true
    for (const op of ctx.pending) this.enqueue(ctx, op)
  }
  async archiveDrafts() {
    const ctx = this.context
    if (!ctx) return
    await ctx.queue
    try {
      for (const op of ctx.pending)
        await firstValueFrom(
          this.http.post(ctx.url, { action: 'discard_draft', op_id: op.op_id })
        )
      ctx.pending = []
      this.persist(ctx)
      if (ctx === this.context) this.restart.next()
    } catch {
      this.status.set('草稿归档失败，已保留；请检查服务和权限')
    }
  }
  async exportPdf() {
    this.flushComments()
    const ctx = this.context,
      port = this.port
    if (!ctx || !port) return
    await ctx.queue
    if (ctx.pending.length) {
      this.status.set('请先保存或处理冲突，再导出PDF副本')
      return
    }
    try {
      this.status.set('正在生成带批注副本')
      const bytes = await port.exportCopy()
      const body = new FormData()
      body.append('action', 'export_copy')
      body.append(
        'file',
        new Blob([bytes], { type: 'application/pdf' }),
        'annotated-copy.pdf'
      )
      body.append(
        'revisions',
        JSON.stringify(
          Object.fromEntries(
            [...ctx.records.values()]
              .filter((a) => !a.deleted)
              .map((a) => [a.id, a.revision])
          )
        )
      )
      const result = await firstValueFrom(
        this.http.post(ctx.url, body, { responseType: 'blob' })
      )
      if (ctx === this.context) {
        this.download(result, 'annotated-copy.pdf')
        this.status.set('副本已导出；Paperless原件未修改')
      }
    } catch {
      if (ctx === this.context)
        this.status.set('导出失败：请检查权限、修订与服务状态')
    }
  }
  downloadDrafts() {
    if (this.context)
      this.download(
        new Blob([JSON.stringify(this.context.pending, null, 2)], {
          type: 'application/json',
        }),
        'annotation-recovery-drafts.json'
      )
  }
  summaryUrl() {
    return this.context?.url + '&download=summary'
  }
  jsonUrl() {
    return this.context?.url + '&download=export'
  }
  private download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob),
      link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }
}
